import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  goals,
  instanceSettings,
  issueThreadInteractions,
  issues,
  sql,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

// Regression for DEE-570: a stored request_confirmation interaction whose result JSON predates the
// enum constraint (outcome="declined", missing version) makes hydrateInteraction() throw on READ, so
// GET /interactions (listForIssue) and every terminal-status auto-resolve path 400, which blocked
// DEE-441 from reaching `done`. Migration 0095_repair_declined_interaction_outcome.sql normalizes the
// row to outcome="superseded_by_comment" + version:1. This test reproduces the read failure and proves
// the migration repairs it (and is idempotent / a no-op on a clean DB).
const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL("../../../packages/db/src/migrations/0095_repair_declined_interaction_outcome.sql", import.meta.url)),
  "utf8",
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("DEE-570 declined interaction outcome repair migration", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dee570-declined-repair-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedConfirmationIssue() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "DEE-570 repair",
      level: "task",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Issue with corrupted interaction",
      status: "in_progress",
      priority: "medium",
    });

    return { companyId, issueId };
  }

  // Insert a corrupted request_confirmation row directly, bypassing the service so the bad
  // result JSON is persisted exactly as the pre-enum operator cleanup left it.
  async function insertCorruptedDeclinedInteraction(args: { companyId: string; issueId: string }) {
    const interactionId = randomUUID();
    await db.execute(sql`
      INSERT INTO "issue_thread_interactions"
        ("id", "company_id", "issue_id", "kind", "status", "continuation_policy", "payload", "result")
      VALUES (
        ${interactionId},
        ${args.companyId},
        ${args.issueId},
        'request_confirmation',
        'expired',
        'wake_assignee',
        ${sql.raw("'{\"prompt\":\"Confirm?\"}'::jsonb")},
        ${sql.raw("'{\"outcome\":\"declined\"}'::jsonb")}
      )
    `);
    return interactionId;
  }

  async function runRepairMigration() {
    await db.execute(sql.raw(MIGRATION_SQL));
  }

  it("reproduces the read failure, then repairs it via the migration", async () => {
    const { companyId, issueId } = await seedConfirmationIssue();
    const interactionId = await insertCorruptedDeclinedInteraction({ companyId, issueId });

    // Before repair: hydrateInteraction zod-parses result on read and throws on the bad enum/version.
    await expect(interactionsSvc.listForIssue(issueId)).rejects.toThrow();

    await runRepairMigration();

    // After repair: read succeeds and the row is normalized.
    const interactions = await interactionsSvc.listForIssue(issueId);
    expect(interactions).toHaveLength(1);
    const repaired = interactions[0];
    expect(repaired.id).toBe(interactionId);
    expect(repaired.result).toMatchObject({ version: 1, outcome: "superseded_by_comment" });

    // getById path is hydrated too.
    const byId = await interactionsSvc.getById(interactionId);
    expect(byId?.result).toMatchObject({ version: 1, outcome: "superseded_by_comment" });
  });

  it("is idempotent: a second run is a no-op and untouched rows are left alone", async () => {
    const { companyId, issueId } = await seedConfirmationIssue();
    const interactionId = await insertCorruptedDeclinedInteraction({ companyId, issueId });

    await runRepairMigration();
    const first = await interactionsSvc.getById(interactionId);
    expect(first?.result).toMatchObject({ version: 1, outcome: "superseded_by_comment" });

    // Second run matches no 'declined' rows -> no change.
    await runRepairMigration();
    const second = await interactionsSvc.getById(interactionId);
    expect(second?.result).toMatchObject({ version: 1, outcome: "superseded_by_comment" });
  });

  it("does not touch already-valid interaction rows", async () => {
    const { companyId, issueId } = await seedConfirmationIssue();
    const validId = randomUUID();
    await db.execute(sql`
      INSERT INTO "issue_thread_interactions"
        ("id", "company_id", "issue_id", "kind", "status", "continuation_policy", "payload", "result")
      VALUES (
        ${validId},
        ${companyId},
        ${issueId},
        'request_confirmation',
        'accepted',
        'wake_assignee',
        ${sql.raw("'{\"prompt\":\"Confirm?\"}'::jsonb")},
        ${sql.raw("'{\"version\":1,\"outcome\":\"accepted\"}'::jsonb")}
      )
    `);

    await runRepairMigration();

    const row = await interactionsSvc.getById(validId);
    expect(row?.result).toMatchObject({ version: 1, outcome: "accepted" });
  });
});
