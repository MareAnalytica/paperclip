import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { agentPeerGrants } from "./agent_peer_grants.js";

export const peerGrantRequests = pgTable(
  "peer_grant_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),

    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    requestedByAgentId: uuid("requested_by_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    sourceIssueIdentifier: text("source_issue_identifier").notNull(),

    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().notNull().default([]),
    reason: text("reason").notNull(),
    requestedTtlSeconds: integer("requested_ttl_seconds"),
    requestedUses: integer("requested_uses"),

    status: text("status").notNull().default("pending"),
    decidedByAgentId: uuid("decided_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),

    grantId: uuid("grant_id").references(() => agentPeerGrants.id, { onDelete: "set null" }),
    interactionId: uuid("interaction_id"),
    dedupeKey: text("dedupe_key").notNull(),
  },
  (table) => ({
    pendingDedupeUq: uniqueIndex("peer_grant_requests_pending_dedupe_uq")
      .on(table.dedupeKey)
      .where(sql`${table.status} = 'pending'`),
    sourceIdx: index("peer_grant_requests_source_idx").on(table.sourceCompanyId, table.createdAt),
    targetIdx: index("peer_grant_requests_target_idx").on(table.targetCompanyId, table.status),
  }),
);
