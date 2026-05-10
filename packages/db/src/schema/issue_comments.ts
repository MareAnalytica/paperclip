import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    mutationType: text("mutation_type"),
    routedReviewerOf: text("routed_reviewer_of"),
    routingEvidenceLink: text("routing_evidence_link"),
    routingMetadata: jsonb("routing_metadata").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_comments_issue_idx").on(table.issueId),
    companyIdx: index("issue_comments_company_idx").on(table.companyId),
    companyIssueCreatedAtIdx: index("issue_comments_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyAuthorIssueCreatedAtIdx: index("issue_comments_company_author_issue_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.issueId,
      table.createdAt,
    ),
    bodySearchIdx: index("issue_comments_body_search_idx").using("gin", table.body.op("gin_trgm_ops")),
    mutationTypeIdx: index("issue_comments_mutation_type_idx").on(table.companyId, table.mutationType),
    routedReviewerOfIdx: index("issue_comments_routed_reviewer_of_idx").on(table.companyId, table.routedReviewerOf),
    companyIssueAuthorIdempotencyUq: uniqueIndex("issue_comments_company_issue_author_idempotency_uq")
      .on(table.companyId, table.issueId, table.authorAgentId, table.idempotencyKey)
      .where(sql.raw('"idempotency_key" IS NOT NULL AND "author_agent_id" IS NOT NULL')),
  }),
);
