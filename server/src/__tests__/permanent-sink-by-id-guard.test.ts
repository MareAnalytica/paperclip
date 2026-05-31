import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isPermanentSinkIssueById } from "../services/recovery/audit-sink-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres permanent-sink by-id guard tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// DEE-651: the heartbeat successful-run handoff + run-liveness-continuation
// guards only hold an issue id, so they used the label-only `isAuditSinkIssue`.
// An un-labeled permanent sink identified by the reserved `-SWEEP-LOG` title
// shape (e.g. DEE-567) fell through and re-fired the `successful_run_missing_state`
// recovery every cycle. `isPermanentSinkIssueById` must recognize such a sink by
// its title shape too, matching the stranded-recovery sweep that DEE-631 already
// moved onto `isPermanentSinkIssue`.
describeEmbeddedPostgres("isPermanentSinkIssueById (DEE-651)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-permanent-sink-by-id-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`truncate table issue_labels, labels, issues, companies restart identity cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const prefix = `PS${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Permanent Sink By Id Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix };
  }

  async function seedIssue(input: {
    companyId: string;
    prefix: string;
    issueNumber: number;
    title: string;
    description?: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      description: input.description ?? null,
      status: "in_progress",
      priority: "low",
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
    });
    return issueId;
  }

  it("recognizes a `-SWEEP-LOG` title-shaped sink with no label (the DEE-651 / DEE-567 shape)", async () => {
    const { companyId, prefix } = await seedCompany();
    const sinkId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 1,
      title: `${prefix}-CEO-SWEEP-LOG`,
      description: "Heartbeat audit sink. Append-only; no forward work by design.",
    });
    expect(await isPermanentSinkIssueById(db, companyId, sinkId)).toBe(true);
  });

  it("recognizes the generalized board sweep-log suffix (the DEE-631 recurrence shape)", async () => {
    const { companyId, prefix } = await seedCompany();
    const sinkId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 1,
      title: "ELI-BOARD-SWEEP-LOG",
    });
    expect(await isPermanentSinkIssueById(db, companyId, sinkId)).toBe(true);
  });

  it("does not flag an ordinary in_progress work issue", async () => {
    const { companyId, prefix } = await seedCompany();
    const ordinaryId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 1,
      title: "Platform: fix recovery loop",
    });
    expect(await isPermanentSinkIssueById(db, companyId, ordinaryId)).toBe(false);
  });

  it("returns false for a missing issue id", async () => {
    const { companyId } = await seedCompany();
    expect(await isPermanentSinkIssueById(db, companyId, randomUUID())).toBe(false);
  });
});
