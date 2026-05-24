import { and, eq, gte, sql } from "drizzle-orm";
import {
  agents,
  issues,
  issueComments,
  peerIssueAudits,
  type Db,
} from "@paperclipai/db";
import { issueService } from "./issues.js";
import { peerGrantService } from "./peer-grants.js";
import { SYSTEM_PEER_ISSUE_USER_ID } from "./peer-issue-system-user.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";

const PEER_ISSUE_AUDITS_IDEMPOTENCY_CONSTRAINT = "peer_issue_audits_idempotency_uq";

function isIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = err.constraint ?? err.constraint_name;
  return err.code === "23505" && constraint === PEER_ISSUE_AUDITS_IDEMPOTENCY_CONSTRAINT;
}

/**
 * Per spec §8 CEO ruling 2026-05-24:
 *  - default cap: 20 peer-issue actions per (source company × target company) per 24h
 *  - hard ceiling: 100 / 24h (no per-target override above this)
 */
export const PEER_ISSUE_DEFAULT_RATE_CAP_24H = 20;
export const PEER_ISSUE_HARD_CEILING_24H = 100;

export interface PeerIssueCreateInput {
  sourceCompanyId: string;
  sourceAgentId: string;
  sourceIssueIdentifier: string;
  sourceCallbackUrl: string;
  title: string;
  body?: string | null;
  acceptanceCriteria: string;
  requestedAssigneeAgentNameKey?: string | null;
  guardrailAck: Record<string, unknown>;
  idempotencyKey: string;
}

export interface PeerCommentInput {
  sourceCompanyId: string;
  sourceAgentId: string;
  sourceIssueIdentifier: string;
  sourceCallbackUrl: string;
  body: string;
  guardrailAck: Record<string, unknown>;
  idempotencyKey: string;
}

const REQUIRED_GUARDRAIL_KEYS = [
  "noSecrets",
  "noEnvMutation",
  "noAgentMutation",
  "noBoardEscalation",
] as const;

function assertGuardrailAck(ack: unknown): asserts ack is Record<string, true> {
  if (!ack || typeof ack !== "object") {
    throw unprocessable("guardrailAck is required");
  }
  const obj = ack as Record<string, unknown>;
  for (const key of REQUIRED_GUARDRAIL_KEYS) {
    if (obj[key] !== true) {
      throw unprocessable(`guardrailAck.${key} must be acknowledged with literal true`);
    }
  }
}

export function peerIssueService(db: Db) {
  const issues_ = issueService(db);
  const grants = peerGrantService(db);

  /**
   * Returns the existing audit row if `idempotencyKey` was already used by `sourceCompanyId`
   * against `targetCompanyId` — used to replay the original 201.
   */
  async function findIdempotentAudit(
    targetCompanyId: string,
    sourceCompanyId: string,
    idempotencyKey: string,
  ) {
    return db
      .select()
      .from(peerIssueAudits)
      .where(and(
        eq(peerIssueAudits.targetCompanyId, targetCompanyId),
        eq(peerIssueAudits.sourceCompanyId, sourceCompanyId),
        eq(peerIssueAudits.idempotencyKey, idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function assertRateCap(
    targetCompanyId: string,
    sourceCompanyId: string,
    cap: number,
  ) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(peerIssueAudits)
      .where(and(
        eq(peerIssueAudits.targetCompanyId, targetCompanyId),
        eq(peerIssueAudits.sourceCompanyId, sourceCompanyId),
        gte(peerIssueAudits.createdAt, since),
      ));
    const effectiveCap = Math.min(cap, PEER_ISSUE_HARD_CEILING_24H);
    if (count >= effectiveCap) {
      throw conflict(
        `Peer-issue rate cap exceeded: ${count}/${effectiveCap} actions in last 24h`,
        { count, cap: effectiveCap },
      );
    }
  }

  /**
   * Look up the agent's source company. The endpoint is gated by an active grant, but
   * we still need the agent row to resolve which source company is invoking us.
   */
  async function resolveSourceAgent(agentId: string) {
    const row = await db
      .select({ id: agents.id, companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw forbidden("Source agent not found");
    return row;
  }

  async function resolveTargetIssue(targetCompanyId: string, identifier: string) {
    const row = await issues_.getByIdentifier(identifier);
    if (!row) throw notFound("Target issue not found");
    if (row.companyId !== targetCompanyId) {
      // Per spec §5.5: comment route refuses cross-company target mismatch.
      throw forbidden("Target issue does not belong to target company");
    }
    return row;
  }

  return {
    create: async (
      targetCompanyId: string,
      agentId: string,
      input: PeerIssueCreateInput,
    ) => {
      assertGuardrailAck(input.guardrailAck);
      const source = await resolveSourceAgent(agentId);
      if (source.companyId !== input.sourceCompanyId) {
        // Per spec §5.7: source identity is server-derived from the actor key; the
        // body's sourceCompanyId is only an assertion that must match.
        throw forbidden("sourceCompanyId does not match the agent's company");
      }
      if (source.companyId === targetCompanyId) {
        throw badRequest("Peer endpoint refuses same-company requests");
      }

      const grant = await grants.findActiveGrant(agentId, targetCompanyId, "peer_issue:create");
      if (!grant) throw forbidden("No active peer_issue:create grant");

      const replay = await findIdempotentAudit(targetCompanyId, input.sourceCompanyId, input.idempotencyKey);
      if (replay) {
        const snap = replay.responseSnapshot as Record<string, unknown> | null;
        if (snap && "commentId" in snap && !("issueId" in snap)) {
          throw conflict("idempotencyKey was previously used for a peer comment, not a peer issue create");
        }
        return { replayed: true as const, audit: replay, response: replay.responseSnapshot };
      }

      await assertRateCap(targetCompanyId, input.sourceCompanyId, PEER_ISSUE_DEFAULT_RATE_CAP_24H);

      const issue = await issues_.create(targetCompanyId, {
        title: input.title,
        description: input.body ?? null,
        status: "todo",
        priority: "medium",
        createdByUserId: SYSTEM_PEER_ISSUE_USER_ID,
        createdByAgentId: null,
      });

      const auditPayload = {
        targetCompanyId,
        targetIssueId: issue.id,
        targetIssueIdentifier: issue.identifier,
        sourceCompanyId: input.sourceCompanyId,
        sourceAgentId: agentId,
        sourceUserId: null,
        sourceIssueIdentifier: input.sourceIssueIdentifier,
        sourceCallbackUrl: input.sourceCallbackUrl,
        acceptanceCriteria: input.acceptanceCriteria,
        requestedAssigneeAgentNameKey: input.requestedAssigneeAgentNameKey ?? null,
        grantId: grant.id,
        guardrailAck: input.guardrailAck as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey,
      };

      const response = {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        targetCompanyId,
        acceptanceCriteria: input.acceptanceCriteria,
        sourceIssueIdentifier: input.sourceIssueIdentifier,
        sourceCallbackUrl: input.sourceCallbackUrl,
      };

      let audit: typeof peerIssueAudits.$inferSelect;
      try {
        const [row] = await db
          .insert(peerIssueAudits)
          .values({ ...auditPayload, responseSnapshot: response })
          .returning();
        audit = row;
      } catch (err) {
        // Concurrent request with the same idempotencyKey won the unique-index race.
        // Delete the orphan issue we just created and replay the winner's audit row.
        if (isIdempotencyConflict(err)) {
          await db.delete(issues).where(eq(issues.id, issue.id));
          const winner = await findIdempotentAudit(targetCompanyId, input.sourceCompanyId, input.idempotencyKey);
          if (winner) return { replayed: true as const, audit: winner, response: winner.responseSnapshot };
        }
        throw err;
      }

      return { replayed: false as const, audit, response, issue };
    },

    comment: async (
      targetCompanyId: string,
      targetIssueIdentifier: string,
      agentId: string,
      input: PeerCommentInput,
    ) => {
      assertGuardrailAck(input.guardrailAck);
      const source = await resolveSourceAgent(agentId);
      if (source.companyId !== input.sourceCompanyId) {
        throw forbidden("sourceCompanyId does not match the agent's company");
      }
      if (source.companyId === targetCompanyId) {
        throw badRequest("Peer endpoint refuses same-company requests");
      }

      const grant = await grants.findActiveGrant(agentId, targetCompanyId, "peer_issue:comment");
      if (!grant) throw forbidden("No active peer_issue:comment grant");

      const targetIssue = await resolveTargetIssue(targetCompanyId, targetIssueIdentifier);

      const replay = await findIdempotentAudit(targetCompanyId, input.sourceCompanyId, input.idempotencyKey);
      if (replay) {
        const snap = replay.responseSnapshot as Record<string, unknown> | null;
        if (snap && "issueId" in snap && !("commentId" in snap)) {
          throw conflict("idempotencyKey was previously used for a peer issue create, not a comment");
        }
        return { replayed: true as const, audit: replay, response: replay.responseSnapshot };
      }

      await assertRateCap(targetCompanyId, input.sourceCompanyId, PEER_ISSUE_DEFAULT_RATE_CAP_24H);

      const comment = await issues_.addComment(
        targetIssue.id,
        input.body,
        { userId: SYSTEM_PEER_ISSUE_USER_ID },
        // assertIssueCommentAuthorTypeAllowed requires authorType "user" when userId
        // is set; the system-author identity is conveyed by the sentinel user id itself.
        { authorType: "user" },
      );

      const commentId = (comment as { id: string }).id;

      const auditPayload = {
        targetCompanyId,
        targetIssueId: targetIssue.id,
        targetIssueIdentifier: targetIssue.identifier,
        sourceCompanyId: input.sourceCompanyId,
        sourceAgentId: agentId,
        sourceUserId: null,
        sourceIssueIdentifier: input.sourceIssueIdentifier,
        sourceCallbackUrl: input.sourceCallbackUrl,
        // TODO: make acceptance_criteria nullable in a follow-on migration (ELI-237 follow-up);
        // the sentinel string is benign but pollutes the audit log for comment-kind rows.
        acceptanceCriteria: "(comment on existing peer issue)",
        requestedAssigneeAgentNameKey: null,
        grantId: grant.id,
        guardrailAck: input.guardrailAck as Record<string, unknown>,
        idempotencyKey: input.idempotencyKey,
      };

      const response = {
        issueIdentifier: targetIssue.identifier,
        commentId,
        targetCompanyId,
      };

      let audit: typeof peerIssueAudits.$inferSelect;
      try {
        const [row] = await db
          .insert(peerIssueAudits)
          .values({ ...auditPayload, responseSnapshot: response })
          .returning();
        audit = row;
      } catch (err) {
        if (isIdempotencyConflict(err)) {
          await db.delete(issueComments).where(eq(issueComments.id, commentId));
          const winner = await findIdempotentAudit(targetCompanyId, input.sourceCompanyId, input.idempotencyKey);
          if (winner) return { replayed: true as const, audit: winner, response: winner.responseSnapshot };
        }
        throw err;
      }

      return { replayed: false as const, audit, response, comment, issue: targetIssue };
    },

    listAudits: async (
      companyId: string,
      direction: "inbound" | "outbound",
    ) => {
      const col = direction === "inbound"
        ? peerIssueAudits.targetCompanyId
        : peerIssueAudits.sourceCompanyId;
      return db
        .select()
        .from(peerIssueAudits)
        .where(eq(col, companyId))
        .orderBy(sql`${peerIssueAudits.createdAt} desc`);
    },
  };
}
