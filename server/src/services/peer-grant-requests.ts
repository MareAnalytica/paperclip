import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  agentPeerGrants,
  companies,
  issues,
  peerGrantRequests,
  type Db,
} from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { isValidPeerGrantScope, peerGrantService, type PeerGrantScope } from "./peer-grants.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/**
 * Config-driven control-plane policy for self-service peer-grant requests
 * (spec docs/specs/2026-05-28-ceo-gated-peer-ticket-grants.md §4). Read from the
 * SOURCE company's `policies.peerGrantPolicy`; defaults are closed so any blueprint
 * that does not explicitly opt in (e.g. DeepSee/future companies) cannot self-serve.
 */
export interface PeerGrantPolicy {
  selfServiceEnabled: boolean;
  selfServiceSourceCompanyAllowlist: string[];
  approverRole: string;
  defaultGrantTtlSeconds: number;
  maxGrantTtlSeconds: number;
  defaultGrantUses: number;
  maxGrantUses: number;
  allowedScopes: PeerGrantScope[];
  requestCoalesceWindowSeconds: number;
}

export const PEER_GRANT_POLICY_DEFAULTS: PeerGrantPolicy = {
  selfServiceEnabled: false,
  selfServiceSourceCompanyAllowlist: [],
  approverRole: "ceo",
  defaultGrantTtlSeconds: 3600,
  maxGrantTtlSeconds: 86400,
  defaultGrantUses: 1,
  maxGrantUses: 20,
  allowedScopes: ["peer_issue:create", "peer_issue:comment"],
  requestCoalesceWindowSeconds: 300,
};

const PENDING_DEDUPE_CONSTRAINT = "peer_grant_requests_pending_dedupe_uq";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.filter((item): item is string => typeof item === "string");
  return out;
}

/** Merge a company's stored `policies.peerGrantPolicy` over the closed defaults. */
export function resolvePeerGrantPolicy(policies: unknown): PeerGrantPolicy {
  const block = asRecord(asRecord(policies)?.peerGrantPolicy);
  if (!block) return { ...PEER_GRANT_POLICY_DEFAULTS };
  const allowedScopes = readStringArray(block.allowedScopes, PEER_GRANT_POLICY_DEFAULTS.allowedScopes)
    .filter(isValidPeerGrantScope);
  return {
    selfServiceEnabled: readBoolean(block.selfServiceEnabled, PEER_GRANT_POLICY_DEFAULTS.selfServiceEnabled),
    selfServiceSourceCompanyAllowlist: readStringArray(
      block.selfServiceSourceCompanyAllowlist,
      PEER_GRANT_POLICY_DEFAULTS.selfServiceSourceCompanyAllowlist,
    ),
    approverRole: typeof block.approverRole === "string" && block.approverRole.trim().length > 0
      ? block.approverRole.trim()
      : PEER_GRANT_POLICY_DEFAULTS.approverRole,
    defaultGrantTtlSeconds: readPositiveInt(block.defaultGrantTtlSeconds, PEER_GRANT_POLICY_DEFAULTS.defaultGrantTtlSeconds),
    maxGrantTtlSeconds: readPositiveInt(block.maxGrantTtlSeconds, PEER_GRANT_POLICY_DEFAULTS.maxGrantTtlSeconds),
    defaultGrantUses: readPositiveInt(block.defaultGrantUses, PEER_GRANT_POLICY_DEFAULTS.defaultGrantUses),
    maxGrantUses: readPositiveInt(block.maxGrantUses, PEER_GRANT_POLICY_DEFAULTS.maxGrantUses),
    allowedScopes: allowedScopes.length > 0 ? allowedScopes : [...PEER_GRANT_POLICY_DEFAULTS.allowedScopes],
    requestCoalesceWindowSeconds: readPositiveInt(
      block.requestCoalesceWindowSeconds,
      PEER_GRANT_POLICY_DEFAULTS.requestCoalesceWindowSeconds,
    ),
  };
}

/** dedupeKey = sha256(sourceCompanyId | targetCompanyId | requestedByAgentId | sortedScopes) (spec §5.2). */
export function computePeerGrantDedupeKey(args: {
  sourceCompanyId: string;
  targetCompanyId: string;
  requestedByAgentId: string;
  scopes: string[];
}): string {
  const sortedScopes = [...args.scopes].sort().join(",");
  return createHash("sha256")
    .update([args.sourceCompanyId, args.targetCompanyId, args.requestedByAgentId, sortedScopes].join("|"))
    .digest("hex");
}

export interface PeerGrantRequestInput {
  sourceCompanyId: string;
  requestedByAgentId: string;
  sourceIssueIdentifier: string;
  scopes: string[];
  reason: string;
  requestedTtlSeconds?: number | null;
  requestedUses?: number | null;
  /** Run that drove the request, for source-side activity-log provenance. */
  runId?: string | null;
}

export type PeerGrantRequestRow = typeof peerGrantRequests.$inferSelect;

export interface PeerGrantRequestCreateResult {
  request: PeerGrantRequestRow;
  replayed: boolean;
  interactionId: string | null;
  wokeApproverIds: string[];
}

export type PeerGrantRow = typeof agentPeerGrants.$inferSelect;

/** Identity of the agent deciding a request (the source-company approver). */
export interface PeerGrantDecider {
  agentId: string;
  runId?: string | null;
}

export interface PeerGrantRequestDecisionResult {
  request: PeerGrantRequestRow;
  grant: PeerGrantRow | null;
  wokeRequester: boolean;
}

export interface PeerGrantRequestListOptions {
  /** `source` => requests this company originated (CEO inbox/history); `target` => requests aimed at this company. */
  direction?: "source" | "target";
  status?: string;
}

function isPendingDedupeConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  return err.code === "23505" && (err.constraint ?? err.constraint_name) === PENDING_DEDUPE_CONSTRAINT;
}

function clampOptional(value: number | null | undefined, max: number): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return Math.min(value, max);
}

export function peerGrantRequestService(db: Db) {
  const interactions = issueThreadInteractionService(db);
  const heartbeat = heartbeatService(db);
  const grants = peerGrantService(db);

  async function findPendingByDedupeKey(dedupeKey: string): Promise<PeerGrantRequestRow | null> {
    return db
      .select()
      .from(peerGrantRequests)
      .where(and(
        eq(peerGrantRequests.dedupeKey, dedupeKey),
        eq(peerGrantRequests.status, "pending"),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getRequestOrThrow(requestId: string): Promise<PeerGrantRequestRow> {
    const row = await db
      .select()
      .from(peerGrantRequests)
      .where(eq(peerGrantRequests.id, requestId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Peer-grant request not found");
    return row;
  }

  /**
   * Authorize a decision actor as the source-company approver (spec §5.3): an agent
   * whose company is the request's source company and whose role matches the source
   * company's `peerGrantPolicy.approverRole` (default `ceo`). Deliberately NOT
   * `assertBoard` — this is the new CEO gate, and the board approval invariant for the
   * generic `approvals` resource stays untouched.
   */
  async function authorizeApprover(
    request: PeerGrantRequestRow,
    approverAgentId: string,
  ): Promise<PeerGrantPolicy> {
    const approver = await db
      .select({ id: agents.id, companyId: agents.companyId, role: agents.role })
      .from(agents)
      .where(eq(agents.id, approverAgentId))
      .then((rows) => rows[0] ?? null);
    if (!approver) throw forbidden("Approver agent not found");
    const policy = await peerGrantRequestService(db).resolvePolicyForCompany(request.sourceCompanyId);
    if (approver.companyId !== request.sourceCompanyId || approver.role !== policy.approverRole) {
      throw forbidden(`Only a ${policy.approverRole} agent in the source company may decide this request`);
    }
    return policy;
  }

  /**
   * Best-effort: drive the linked CEO decision card to a terminal state so it clears
   * from the inbox. The request row is the source of truth, so a card already resolved
   * by a parallel UI flow (or a missing source issue) must not fail the decision.
   */
  async function resolveDecisionCard(
    request: PeerGrantRequestRow,
    approverAgentId: string,
    decision: "approve" | "reject",
    note: string | null,
  ): Promise<void> {
    if (!request.interactionId) return;
    const sourceIssue = await db
      .select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId, goalId: issues.goalId })
      .from(issues)
      .where(eq(issues.identifier, request.sourceIssueIdentifier))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return;
    try {
      if (decision === "approve") {
        await interactions.acceptInteraction(sourceIssue, request.interactionId, {}, { agentId: approverAgentId });
      } else {
        await interactions.rejectInteraction(
          { id: sourceIssue.id, companyId: sourceIssue.companyId },
          request.interactionId,
          { reason: note ?? undefined },
          { agentId: approverAgentId },
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: request.id, interactionId: request.interactionId },
        "peer_grant_request decision card resolution failed");
    }
  }

  /** Wake the original requester after a decision (approval_approved / rejected pattern). */
  async function wakeRequester(
    request: PeerGrantRequestRow,
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<boolean> {
    const sourceIssue = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.identifier, request.sourceIssueIdentifier))
      .then((rows) => rows[0] ?? null);
    try {
      await heartbeat.wakeup(request.requestedByAgentId, {
        source: "automation",
        triggerDetail: "callback",
        reason,
        payload: {
          issueId: sourceIssue?.id ?? null,
          issueIdentifier: request.sourceIssueIdentifier,
          requestId: request.id,
          targetCompanyId: request.targetCompanyId,
          scopes: request.scopes,
          status: request.status,
          ...extra,
        },
        requestedByActorType: "system",
        requestedByActorId: "peer-grant-request",
      });
      return true;
    } catch (err) {
      logger.warn({ err, agentId: request.requestedByAgentId, requestId: request.id },
        "peer_grant_request requester wake failed");
      return false;
    }
  }

  return {
    resolvePolicyForCompany: async (companyId: string): Promise<PeerGrantPolicy> => {
      const row = await db
        .select({ policies: companies.policies })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Source company not found");
      return resolvePeerGrantPolicy(row.policies);
    },

    /**
     * Self-service request path (spec §5.1). Validates eligibility against the source
     * company's peerGrantPolicy, dedupes via the pending-unique dedupeKey, emits a
     * CEO decision card on the source issue, activity-logs, and wakes the approver(s).
     * Does NOT mint a grant — that happens on CEO approval (ELI-379.4 / ELI-387).
     */
    create: async (
      targetCompanyId: string,
      input: PeerGrantRequestInput,
    ): Promise<PeerGrantRequestCreateResult> => {
      const policy = await peerGrantRequestService(db).resolvePolicyForCompany(input.sourceCompanyId);

      // Eligibility: Eli-only, default-closed (spec §5.1.2).
      if (!policy.selfServiceEnabled
        || !policy.selfServiceSourceCompanyAllowlist.includes(input.sourceCompanyId)) {
        throw forbidden("peer self-service not enabled for this company");
      }

      // Scope validation (spec §5.1.3).
      if (input.scopes.length === 0) throw badRequest("At least one scope is required");
      const scopes: PeerGrantScope[] = [];
      for (const scope of input.scopes) {
        if (!isValidPeerGrantScope(scope)) throw badRequest(`Unknown peer grant scope: ${scope}`);
        if (!policy.allowedScopes.includes(scope)) {
          throw badRequest(`Scope not permitted by policy: ${scope}`);
        }
        scopes.push(scope);
      }

      if (targetCompanyId === input.sourceCompanyId) {
        throw badRequest("Peer grant requires a cross-company target");
      }
      const targetCompany = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, targetCompanyId))
        .then((rows) => rows[0] ?? null);
      if (!targetCompany) throw notFound("Target company not found");

      // Resolve the driving source issue (must exist in the source company).
      const sourceIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.identifier, input.sourceIssueIdentifier))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue || sourceIssue.companyId !== input.sourceCompanyId) {
        throw badRequest("sourceIssueIdentifier must reference an issue in the source company");
      }

      const dedupeKey = computePeerGrantDedupeKey({
        sourceCompanyId: input.sourceCompanyId,
        targetCompanyId,
        requestedByAgentId: input.requestedByAgentId,
        scopes,
      });

      // Anti-spam (spec §5.2): one open card per (agent, target, scopes). Replay existing.
      const existingPending = await findPendingByDedupeKey(dedupeKey);
      if (existingPending) {
        return {
          request: existingPending,
          replayed: true,
          interactionId: existingPending.interactionId,
          wokeApproverIds: [],
        };
      }

      const requestedTtlSeconds = clampOptional(input.requestedTtlSeconds, policy.maxGrantTtlSeconds);
      const requestedUses = clampOptional(input.requestedUses, policy.maxGrantUses);

      let request: PeerGrantRequestRow;
      try {
        [request] = await db
          .insert(peerGrantRequests)
          .values({
            sourceCompanyId: input.sourceCompanyId,
            requestedByAgentId: input.requestedByAgentId,
            sourceIssueIdentifier: input.sourceIssueIdentifier,
            targetCompanyId,
            scopes,
            reason: input.reason,
            requestedTtlSeconds,
            requestedUses,
            status: "pending",
            dedupeKey,
          })
          .returning();
      } catch (error) {
        if (!isPendingDedupeConflict(error)) throw error;
        const raced = await findPendingByDedupeKey(dedupeKey);
        if (!raced) throw error;
        return { request: raced, replayed: true, interactionId: raced.interactionId, wokeApproverIds: [] };
      }

      // CEO decision card on the source issue (spec §6). The platform decisionClass
      // enum has no `agent_gate`; `ceo_actionable` is the value that expresses
      // "CEO-resolvable, not human/board". Request metadata rides in detailsMarkdown +
      // a custom target keyed to the request id; the durable link is the
      // peer_grant_requests.interaction_id column set below.
      const interaction = await interactions.create(
        { id: sourceIssue.id, companyId: sourceIssue.companyId },
        {
          kind: "request_confirmation",
          continuationPolicy: "none",
          title: `Peer-grant request → ${targetCompanyId}`,
          summary: `Cross-company ${scopes.join(", ")} requested for ${input.sourceIssueIdentifier}`,
          payload: {
            version: 1,
            prompt: `Approve cross-company peer access (${scopes.join(", ")}) to company ${targetCompanyId}?`,
            decisionClass: "ceo_actionable",
            decisionSubject: {
              type: "peer_grant_request",
              issueIdentifier: input.sourceIssueIdentifier,
              summary: input.reason.slice(0, 1000),
            },
            acceptLabel: "Approve",
            rejectLabel: "Reject",
            allowDeclineReason: true,
            detailsMarkdown: [
              `**Peer-grant request** \`${request.id}\``,
              "",
              `- Requesting agent: \`${input.requestedByAgentId}\``,
              `- Source company: \`${input.sourceCompanyId}\``,
              `- Source issue: ${input.sourceIssueIdentifier}`,
              `- Target company: \`${targetCompanyId}\``,
              `- Scopes: ${scopes.map((s) => `\`${s}\``).join(", ")}`,
              `- Requested TTL (s): ${requestedTtlSeconds ?? `policy default (${policy.defaultGrantTtlSeconds})`}`,
              `- Requested uses: ${requestedUses ?? `policy default (${policy.defaultGrantUses})`}`,
              "",
              `**Reason:** ${input.reason}`,
            ].join("\n"),
            target: {
              type: "custom",
              key: `peer_grant_request:${request.id}`,
              revisionId: request.id,
              label: "Peer-grant request",
            },
          },
        },
        { agentId: input.requestedByAgentId },
      );

      [request] = await db
        .update(peerGrantRequests)
        .set({ interactionId: interaction.id, updatedAt: new Date() })
        .where(eq(peerGrantRequests.id, request.id))
        .returning();

      await logActivity(db, {
        companyId: input.sourceCompanyId,
        actorType: "agent",
        actorId: input.requestedByAgentId,
        agentId: input.requestedByAgentId,
        runId: input.runId ?? null,
        action: "peer_grant_request.created",
        entityType: "peer_grant_request",
        entityId: request.id,
        details: {
          targetCompanyId,
          scopes,
          sourceIssueIdentifier: input.sourceIssueIdentifier,
          dedupeKey,
          interactionId: interaction.id,
        },
      });

      // Wake the approver(s): policy.approverRole agents in the source company.
      const approverRows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(
          eq(agents.companyId, input.sourceCompanyId),
          eq(agents.role, policy.approverRole),
        ));
      const wokeApproverIds: string[] = [];
      for (const approver of approverRows) {
        if (approver.id === input.requestedByAgentId) continue;
        try {
          await heartbeat.wakeup(approver.id, {
            source: "automation",
            triggerDetail: "callback",
            reason: "peer_grant_request_created",
            payload: {
              issueId: sourceIssue.id,
              issueIdentifier: input.sourceIssueIdentifier,
              requestId: request.id,
              interactionId: interaction.id,
              targetCompanyId,
              scopes,
            },
            requestedByActorType: "system",
            requestedByActorId: "peer-grant-request",
          });
          wokeApproverIds.push(approver.id);
        } catch (err) {
          logger.warn({ err, agentId: approver.id, requestId: request.id },
            "peer_grant_request approver wake failed");
        }
      }

      return { request, replayed: false, interactionId: interaction.id, wokeApproverIds };
    },

    /**
     * CEO approval (spec §5.3, §7). Mints a narrow, time-boxed, single-use-by-default
     * `agent_peer_grants` row keyed to the exact (agent, targetCompany, scopes) the
     * request named, links it back to the request, resolves the decision card, wakes
     * the requester, and activity-logs on the source company. Idempotency: a request
     * already decided returns `409` rather than minting a second grant.
     */
    approve: async (
      requestId: string,
      approver: PeerGrantDecider,
      opts?: { decisionNote?: string | null },
    ): Promise<PeerGrantRequestDecisionResult> => {
      const request = await getRequestOrThrow(requestId);
      if (request.status !== "pending") {
        throw conflict(`Peer-grant request already ${request.status}`);
      }
      const policy = await authorizeApprover(request, approver.agentId);

      const scopes = request.scopes.filter(isValidPeerGrantScope) as PeerGrantScope[];
      if (scopes.length === 0) throw badRequest("Request has no valid scopes to grant");

      const now = new Date();
      const ttlSeconds = Math.min(
        request.requestedTtlSeconds ?? policy.defaultGrantTtlSeconds,
        policy.maxGrantTtlSeconds,
      );
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      const maxUses = Math.min(
        request.requestedUses ?? policy.defaultGrantUses,
        policy.maxGrantUses,
      );

      const grant = await grants.create(request.targetCompanyId, {
        agentId: request.requestedByAgentId,
        scopes,
        grantedByUserId: `agent:${approver.agentId}`,
        expiresAt,
        maxUses,
        notes: `peer_grant_request:${request.id}`,
      });

      const [updated] = await db
        .update(peerGrantRequests)
        .set({
          status: "approved",
          grantId: grant.id,
          decidedByAgentId: approver.agentId,
          decidedAt: now,
          decisionNote: opts?.decisionNote ?? null,
          updatedAt: now,
        })
        .where(and(eq(peerGrantRequests.id, request.id), eq(peerGrantRequests.status, "pending")))
        .returning();
      if (!updated) throw conflict("Peer-grant request already decided");

      await resolveDecisionCard(updated, approver.agentId, "approve", opts?.decisionNote ?? null);

      await logActivity(db, {
        companyId: request.sourceCompanyId,
        actorType: "agent",
        actorId: approver.agentId,
        agentId: approver.agentId,
        runId: approver.runId ?? null,
        action: "peer_grant_request.approved",
        entityType: "peer_grant_request",
        entityId: request.id,
        details: {
          grantId: grant.id,
          decidedByAgentId: approver.agentId,
          targetCompanyId: request.targetCompanyId,
          scopes,
          ttlSeconds,
          maxUses,
        },
      });

      const wokeRequester = await wakeRequester(updated, "peer_grant_request_approved", {
        grantId: grant.id,
        expiresAt: expiresAt.toISOString(),
        maxUses,
      });

      return { request: updated, grant, wokeRequester };
    },

    /**
     * CEO rejection (spec §5.3, §7). No grant minted; records the decision, resolves
     * the decision card, wakes the requester with reason `peer_grant_request_rejected`,
     * and activity-logs on the source company.
     */
    reject: async (
      requestId: string,
      approver: PeerGrantDecider,
      opts?: { decisionNote?: string | null },
    ): Promise<PeerGrantRequestDecisionResult> => {
      const request = await getRequestOrThrow(requestId);
      if (request.status !== "pending") {
        throw conflict(`Peer-grant request already ${request.status}`);
      }
      await authorizeApprover(request, approver.agentId);

      const now = new Date();
      const [updated] = await db
        .update(peerGrantRequests)
        .set({
          status: "rejected",
          decidedByAgentId: approver.agentId,
          decidedAt: now,
          decisionNote: opts?.decisionNote ?? null,
          updatedAt: now,
        })
        .where(and(eq(peerGrantRequests.id, request.id), eq(peerGrantRequests.status, "pending")))
        .returning();
      if (!updated) throw conflict("Peer-grant request already decided");

      await resolveDecisionCard(updated, approver.agentId, "reject", opts?.decisionNote ?? null);

      await logActivity(db, {
        companyId: request.sourceCompanyId,
        actorType: "agent",
        actorId: approver.agentId,
        agentId: approver.agentId,
        runId: approver.runId ?? null,
        action: "peer_grant_request.rejected",
        entityType: "peer_grant_request",
        entityId: request.id,
        details: { decidedByAgentId: approver.agentId, decisionNote: opts?.decisionNote ?? null },
      });

      const wokeRequester = await wakeRequester(updated, "peer_grant_request_rejected", {
        reason: opts?.decisionNote ?? null,
      });

      return { request: updated, grant: null, wokeRequester };
    },

    /**
     * List requests for a company (spec §5.4): `direction=source` is the CEO inbox +
     * source-issue history (requests this company originated); `direction=target` lists
     * requests aimed at this company. Optional `status` filter.
     */
    list: async (
      companyId: string,
      opts?: PeerGrantRequestListOptions,
    ): Promise<PeerGrantRequestRow[]> => {
      const direction = opts?.direction ?? "source";
      const conds = [
        direction === "target"
          ? eq(peerGrantRequests.targetCompanyId, companyId)
          : eq(peerGrantRequests.sourceCompanyId, companyId),
      ];
      if (opts?.status) conds.push(eq(peerGrantRequests.status, opts.status));
      return db
        .select()
        .from(peerGrantRequests)
        .where(and(...conds))
        .orderBy(desc(peerGrantRequests.createdAt));
    },
  };
}
