import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const agentPeerGrants = pgTable(
  "agent_peer_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull().default([]),
    grantedByUserId: text("granted_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    notes: text("notes"),
    // Server-enforced single-use (spec §8 O1). null max_uses => no per-use cap
    // (legacy TTL-only behavior, preserved for pre-existing grants).
    maxUses: integer("max_uses"),
    usesCount: integer("uses_count").notNull().default(0),
  },
  (table) => ({
    agentTargetIdx: index("agent_peer_grants_agent_target_idx").on(table.agentId, table.targetCompanyId),
    targetCompanyIdx: index("agent_peer_grants_target_company_idx").on(table.targetCompanyId),
  }),
);
