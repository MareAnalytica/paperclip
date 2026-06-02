import { and, eq, isNull, gt, or, desc, inArray, sql } from "drizzle-orm";
import { agentPeerGrants, agents, type Db } from "@paperclipai/db";
import { badRequest, notFound } from "../errors.js";

export type PeerGrantScope = "peer_issue:create" | "peer_issue:comment";

const ALLOWED_SCOPES: readonly PeerGrantScope[] = [
  "peer_issue:create",
  "peer_issue:comment",
] as const;

export function isValidPeerGrantScope(value: unknown): value is PeerGrantScope {
  return typeof value === "string" && (ALLOWED_SCOPES as readonly string[]).includes(value);
}

export interface PeerGrantInput {
  agentId: string;
  scopes: PeerGrantScope[];
  grantedByUserId: string;
  expiresAt?: Date | null;
  notes?: string | null;
  /**
   * Server-enforced per-grant use cap (spec §8 O1). null => legacy TTL-only
   * (unlimited uses). CEO-minted grants default to single-use via the request
   * policy, so this is set on the approval path.
   */
  maxUses?: number | null;
}

export function peerGrantService(db: Db) {
  return {
    /**
     * Create a grant authorizing `agentId` (which may live in any source company) to take
     * scoped peer-issue actions against `targetCompanyId`.
     */
    create: async (targetCompanyId: string, input: PeerGrantInput) => {
      if (input.scopes.length === 0) {
        throw badRequest("At least one scope is required");
      }
      for (const scope of input.scopes) {
        if (!isValidPeerGrantScope(scope)) {
          throw badRequest(`Unknown peer grant scope: ${scope}`);
        }
      }
      const agentRow = await db
        .select({ id: agents.id, companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .then((rows) => rows[0] ?? null);
      if (!agentRow) throw notFound("Agent not found");
      if (agentRow.companyId === targetCompanyId) {
        // Same-company grants are meaningless: assertCompanyAccess already permits.
        throw badRequest("Peer grant requires a cross-company agent");
      }
      const [row] = await db
        .insert(agentPeerGrants)
        .values({
          agentId: input.agentId,
          targetCompanyId,
          scopes: input.scopes,
          grantedByUserId: input.grantedByUserId,
          expiresAt: input.expiresAt ?? null,
          notes: input.notes ?? null,
          maxUses: input.maxUses ?? null,
        })
        .returning();
      return row;
    },

    list: async (targetCompanyId: string, opts?: { activeOnly?: boolean }) => {
      const now = new Date();
      const baseConds = [eq(agentPeerGrants.targetCompanyId, targetCompanyId)];
      if (opts?.activeOnly) {
        baseConds.push(isNull(agentPeerGrants.revokedAt));
        baseConds.push(or(isNull(agentPeerGrants.expiresAt), gt(agentPeerGrants.expiresAt, now))!);
      }
      const rows = await db
        .select()
        .from(agentPeerGrants)
        .where(and(...baseConds))
        .orderBy(desc(agentPeerGrants.createdAt));
      return rows;
    },

    revoke: async (grantId: string, targetCompanyId: string, revokedAt: Date = new Date()) => {
      const [row] = await db
        .update(agentPeerGrants)
        .set({ revokedAt })
        .where(and(
          eq(agentPeerGrants.id, grantId),
          eq(agentPeerGrants.targetCompanyId, targetCompanyId),
          isNull(agentPeerGrants.revokedAt),
        ))
        .returning();
      if (!row) throw notFound("Active peer grant not found for this company");
      return row;
    },

    /**
     * Look up the active grant (if any) that authorizes `agentId` to act against
     * `targetCompanyId` with the required scope, and atomically consume one use.
     *
     * Single-use / limited-use enforcement (spec §3, §5.5, §8 O1): a grant with a
     * non-null `maxUses` is active only while `usesCount < maxUses`. A successful
     * lookup increments `usesCount` in the same statement, so the Nth+1 call to a
     * grant with `maxUses = N` returns null. Grants with `maxUses = null` keep the
     * legacy TTL-only behavior (unlimited uses; `usesCount` still tracked).
     *
     * The lookup targets the newest non-revoked grant only (matching the prior
     * selection semantics — it does not fall through to older grants). Because the
     * `usesCount < maxUses` predicate is in the outer UPDATE WHERE, concurrent calls
     * cannot both consume the final use: Postgres re-checks the predicate against the
     * row each transaction locks, so the loser updates zero rows and returns null.
     */
    findActiveGrant: async (
      agentId: string,
      targetCompanyId: string,
      requiredScope: PeerGrantScope,
    ) => {
      const now = new Date();
      const newestNonRevoked = db
        .select({ id: agentPeerGrants.id })
        .from(agentPeerGrants)
        .where(and(
          eq(agentPeerGrants.agentId, agentId),
          eq(agentPeerGrants.targetCompanyId, targetCompanyId),
          isNull(agentPeerGrants.revokedAt),
        ))
        .orderBy(desc(agentPeerGrants.createdAt))
        .limit(1);
      const [row] = await db
        .update(agentPeerGrants)
        .set({ usesCount: sql`${agentPeerGrants.usesCount} + 1` })
        .where(and(
          inArray(agentPeerGrants.id, newestNonRevoked),
          or(isNull(agentPeerGrants.expiresAt), gt(agentPeerGrants.expiresAt, now))!,
          sql`${requiredScope} = ANY(${agentPeerGrants.scopes})`,
          or(
            isNull(agentPeerGrants.maxUses),
            sql`${agentPeerGrants.usesCount} < ${agentPeerGrants.maxUses}`,
          )!,
        ))
        .returning();
      return row ?? null;
    },
  };
}
