import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agents,
  companies,
  issues,
  peerGrantRequests,
  type Db,
} from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import { isValidPeerGrantScope, type PeerGrantScope } from "./peer-grants.js";
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
  };
}
