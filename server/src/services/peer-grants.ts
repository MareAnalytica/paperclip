import { and, eq, isNull, gt, or, desc } from "drizzle-orm";
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
     * `targetCompanyId` with the required scope.
     */
    findActiveGrant: async (
      agentId: string,
      targetCompanyId: string,
      requiredScope: PeerGrantScope,
    ) => {
      const now = new Date();
      const row = await db
        .select()
        .from(agentPeerGrants)
        .where(and(
          eq(agentPeerGrants.agentId, agentId),
          eq(agentPeerGrants.targetCompanyId, targetCompanyId),
          isNull(agentPeerGrants.revokedAt),
        ))
        .orderBy(desc(agentPeerGrants.createdAt))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
      if (!row.scopes.includes(requiredScope)) return null;
      return row;
    },
  };
}
