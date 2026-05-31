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
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

// Regression for DEE-586: the generalized backstop migration normalizes ANY non-pending
// interaction row whose `result` fails its kind's zod schema (not just outcome="declined",
// which 0095/DEE-570 handled). The DEE-582 read-guard already keeps a malformed row from
// 400-ing on read (it degrades `result` to null + flags unparseableResult); this migration
// repairs the stored data so reads return the real outcome and terminal transitions are sound.
// It must compose with 0095 (no-op on rows 0095 already repaired) and leave healthy rows alone.
const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL(
    "../../../packages/db/src/migrations/0096_dee586_generalized_interaction_result_repair.sql",
    import.meta.url,
  )),
  "utf8",
);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("DEE-586 generalized interaction-result repair migration", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dee586-generalized-repair-");
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

  async function seedIssue() {
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
    await db.insert(goals).values({ id: goalId, companyId, title: "DEE-586 repair", level: "task", status: "active" });
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

  // Insert a row directly (bypassing the service) so the bad result JSON is persisted verbatim.
  async function insertRow(args: {
    companyId: string;
    issueId: string;
    kind: string;
    status: string;
    payloadJson: string;
    resultJson: string | null;
  }) {
    const id = randomUUID();
    const resultExpr = args.resultJson === null
      ? sql.raw("NULL")
      : sql.raw(`'${args.resultJson.replace(/'/g, "''")}'::jsonb`);
    await db.execute(sql`
      INSERT INTO "issue_thread_interactions"
        ("id", "company_id", "issue_id", "kind", "status", "continuation_policy", "payload", "result")
      VALUES (
        ${id}, ${args.companyId}, ${args.issueId}, ${sql.raw(`'${args.kind}'`)},
        ${sql.raw(`'${args.status}'`)}, 'wake_assignee',
        ${sql.raw(`'${args.payloadJson.replace(/'/g, "''")}'::jsonb`)},
        ${resultExpr}
      )
    `);
    return id;
  }

  // Mirror drizzle's migrator (readMigrationFiles): split on the statement-breakpoint
  // markers and run each statement separately, exactly as migratePg() does in production.
  async function runRepair() {
    for (const statement of MIGRATION_SQL.split("--> statement-breakpoint")) {
      if (statement.trim().length === 0) continue;
      await db.execute(sql.raw(statement));
    }
  }

  async function rawResult(id: string): Promise<unknown> {
    const rows = await db.execute(sql`SELECT "result" FROM "issue_thread_interactions" WHERE "id" = ${id}`);
    // postgres-js returns an array of rows
    const list = rows as unknown as Array<{ result: unknown }>;
    return list[0]?.result ?? null;
  }

  it("repairs the ELI-795 shape (missing version + missing outcome) on a non-pending row", async () => {
    const { companyId, issueId } = await seedIssue();
    const id = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "cancelled",
      payloadJson: '{"version":1,"prompt":"Confirm?"}', resultJson: '{"reason":"x"}',
    });

    // DEE-582 read-guard: degraded, not a 400.
    const before = await interactionsSvc.listForIssue(issueId);
    expect(before[0].result).toBeNull();
    expect(before[0].unparseableResult).toBe(true);

    await runRepair();

    const repaired = await interactionsSvc.getById(id);
    expect(repaired?.result).toMatchObject({ version: 1, outcome: "cancelled" });
    expect(repaired?.unparseableResult).toBeFalsy();
  });

  it("maps status -> outcome for an expired request_confirmation", async () => {
    const { companyId, issueId } = await seedIssue();
    const id = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "expired",
      payloadJson: '{"version":1,"prompt":"Confirm?"}', resultJson: '{"outcome":"declined"}',
    });
    await runRepair();
    const repaired = await interactionsSvc.getById(id);
    expect(repaired?.result).toMatchObject({ version: 1, outcome: "issue_terminal_status" });
  });

  it("repairs malformed ask_user_questions and suggest_tasks results", async () => {
    const { companyId, issueId } = await seedIssue();
    const askId = await insertRow({
      companyId, issueId, kind: "ask_user_questions", status: "answered",
      payloadJson: '{"version":1,"questions":[]}', resultJson: '{"answers":"oops"}',
    });
    const sugId = await insertRow({
      companyId, issueId, kind: "suggest_tasks", status: "cancelled",
      payloadJson: '{"version":1,"tasks":[]}', resultJson: '{}',
    });

    await runRepair();

    const ask = await interactionsSvc.getById(askId);
    expect(ask?.result).toMatchObject({ version: 1, cancelled: true });
    expect(Array.isArray((ask?.result as { answers: unknown }).answers)).toBe(true);
    const sug = await interactionsSvc.getById(sugId);
    expect(sug?.result).toMatchObject({ version: 1 });
    expect(sug?.unparseableResult).toBeFalsy();
  });

  it("repairs a versioned suggest_tasks row with a structurally-invalid (non-array) field", async () => {
    // Codex P2 regression: version:1 present but skippedClientKeys is not an array.
    // A version-only predicate would treat this as healthy; the type-level guard catches it.
    const { companyId, issueId } = await seedIssue();
    const id = await insertRow({
      companyId, issueId, kind: "suggest_tasks", status: "rejected",
      payloadJson: '{"version":1,"tasks":[{"clientKey":"a","title":"t"}]}',
      resultJson: '{"version":1,"skippedClientKeys":"oops","createdTasks":[]}',
    });

    const before = await interactionsSvc.getById(id);
    expect(before?.unparseableResult).toBe(true);

    await runRepair();

    const repaired = await interactionsSvc.getById(id);
    expect(repaired?.result).toMatchObject({ version: 1 });
    expect(repaired?.unparseableResult).toBeFalsy();
  });

  it("preserves real data when the only fault is a missing version (Codex P1)", async () => {
    const { companyId, issueId } = await seedIssue();
    // ask_user_questions: valid recorded answers but no version:1 -> must KEEP the answers.
    const askId = await insertRow({
      companyId, issueId, kind: "ask_user_questions", status: "answered",
      payloadJson: '{"version":1,"questions":[{"id":"q1","prompt":"Pick","selectionMode":"single","options":[{"id":"o1","label":"A"}]}]}',
      resultJson: '{"answers":[{"questionId":"q1","optionIds":["o1"]}]}',
    });
    // request_confirmation: valid outcome but no version:1 -> must KEEP outcome "accepted".
    const rcId = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "accepted",
      payloadJson: '{"version":1,"prompt":"Confirm?"}',
      resultJson: '{"outcome":"accepted","reason":"looks good"}',
    });

    await runRepair();

    const ask = await interactionsSvc.getById(askId);
    expect(ask?.result).toMatchObject({ version: 1 });
    const answers = (ask?.result as { answers: Array<{ questionId: string }> }).answers;
    expect(answers).toHaveLength(1);
    expect(answers[0].questionId).toBe("q1"); // real answer preserved, NOT wiped to []

    const rc = await interactionsSvc.getById(rcId);
    expect(rc?.result).toMatchObject({ version: 1, outcome: "accepted", reason: "looks good" });
  });

  it("repairs a string version \"1\" (zod requires numeric literal 1) and a scalar result", async () => {
    const { companyId, issueId } = await seedIssue();
    // version is the JSON string "1", not the number 1 -> fails z.literal(1).
    const strVerId = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "rejected",
      payloadJson: '{"version":1,"prompt":"Confirm?"}',
      resultJson: '{"version":"1","outcome":"rejected"}',
    });
    // result is a bare JSON scalar (not an object) -> jsonb || must not array-concat it.
    const scalarId = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "cancelled",
      payloadJson: '{"version":1,"prompt":"Confirm?"}',
      resultJson: '"declined"',
    });

    await runRepair();

    const strVer = await interactionsSvc.getById(strVerId);
    expect(strVer?.result).toMatchObject({ version: 1, outcome: "rejected" });
    expect(strVer?.unparseableResult).toBeFalsy();

    const scalar = await interactionsSvc.getById(scalarId);
    expect(scalar?.result).toMatchObject({ version: 1, outcome: "cancelled" });
    expect(scalar?.unparseableResult).toBeFalsy();
  });

  it("resets a pending row with a non-null malformed result back to NULL", async () => {
    const { companyId, issueId } = await seedIssue();
    const id = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "pending",
      payloadJson: '{"version":1,"prompt":"Confirm?"}', resultJson: '{"outcome":"declined"}',
    });
    await runRepair();
    expect(await rawResult(id)).toBeNull();
  });

  it("does not touch healthy rows and is idempotent", async () => {
    const { companyId, issueId } = await seedIssue();
    const healthyId = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "accepted",
      payloadJson: '{"version":1,"prompt":"Confirm?"}', resultJson: '{"version":1,"outcome":"accepted"}',
    });
    const corruptId = await insertRow({
      companyId, issueId, kind: "request_confirmation", status: "rejected",
      payloadJson: '{"version":1,"prompt":"Confirm?"}', resultJson: '{"outcome":"nope"}',
    });

    await runRepair();
    const healthyAfter1 = await rawResult(healthyId);
    expect(healthyAfter1).toMatchObject({ version: 1, outcome: "accepted" });
    expect(await interactionsSvc.getById(corruptId)).toMatchObject({
      result: { version: 1, outcome: "rejected" },
    });

    // Second run is a no-op: healthy row byte-identical, repaired row unchanged.
    await runRepair();
    expect(await rawResult(healthyId)).toEqual(healthyAfter1);
    expect((await interactionsSvc.getById(corruptId))?.result).toMatchObject({ version: 1, outcome: "rejected" });
  });
});
