import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agentPeerGrants } from "./agent_peer_grants.js";

export const peerIssueAudits = pgTable(
  "peer_issue_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    targetCompanyId: uuid("target_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    targetIssueIdentifier: text("target_issue_identifier").notNull(),
    sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceAgentId: uuid("source_agent_id").references(() => agents.id, { onDelete: "set null" }),
    sourceUserId: text("source_user_id"),
    sourceIssueIdentifier: text("source_issue_identifier").notNull(),
    sourceCallbackUrl: text("source_callback_url").notNull(),
    acceptanceCriteria: text("acceptance_criteria").notNull(),
    requestedAssigneeAgentNameKey: text("requested_assignee_agent_name_key"),
    grantId: uuid("grant_id").references(() => agentPeerGrants.id, { onDelete: "set null" }),
    guardrailAck: jsonb("guardrail_ack").$type<Record<string, boolean>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    responseSnapshot: jsonb("response_snapshot").$type<Record<string, unknown> | null>(),
  },
  (table) => ({
    targetCompanyIdx: index("peer_issue_audits_target_company_idx").on(table.targetCompanyId, table.createdAt),
    sourceCompanyIdx: index("peer_issue_audits_source_company_idx").on(table.sourceCompanyId, table.createdAt),
    targetIssueIdx: index("peer_issue_audits_target_issue_idx").on(table.targetIssueId),
    idempotencyUq: uniqueIndex("peer_issue_audits_idempotency_uq").on(
      table.targetCompanyId,
      table.sourceCompanyId,
      table.idempotencyKey,
    ),
  }),
);
