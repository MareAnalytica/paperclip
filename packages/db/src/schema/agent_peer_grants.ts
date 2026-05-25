import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
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
  },
  (table) => ({
    agentTargetIdx: index("agent_peer_grants_agent_target_idx").on(table.agentId, table.targetCompanyId),
    targetCompanyIdx: index("agent_peer_grants_target_company_idx").on(table.targetCompanyId),
  }),
);
