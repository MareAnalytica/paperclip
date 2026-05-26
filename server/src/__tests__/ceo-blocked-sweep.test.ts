import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CEO_BLOCKED_SWEEP_AUDIT_ACTION,
  CEO_BLOCKED_SWEEP_ROUTINE_TITLE,
  CEO_BLOCKED_SWEEP_WAKE_REASON,
  ceoBlockedSweepService,
  computeJitteredNextRunAt,
  intervalToNominalCronExpression,
} from "../services/ceo-blocked-sweep.js";
import type { BlockedQueueItem } from "../services/issues.js";

// ---------------------------------------------------------------------------
// Pure-helper tests (no DB)
// ---------------------------------------------------------------------------

describe("ceo-blocked-sweep / pure helpers", () => {
  it("intervalToNominalCronExpression: 60 minutes → hourly at :00", () => {
    expect(intervalToNominalCronExpression(60)).toBe("0 * * * *");
  });

  it("intervalToNominalCronExpression: divides 60 → */N", () => {
    expect(intervalToNominalCronExpression(30)).toBe("*/30 * * * *");
    expect(intervalToNominalCronExpression(15)).toBe("*/15 * * * *");
    expect(intervalToNominalCronExpression(5)).toBe("*/5 * * * *");
  });

  it("intervalToNominalCronExpression: multi-hour divisors of 24 → 0 */h * * *", () => {
    expect(intervalToNominalCronExpression(120)).toBe("0 */2 * * *");
    expect(intervalToNominalCronExpression(180)).toBe("0 */3 * * *");
  });

  it("computeJitteredNextRunAt: stays within ±10% per fire", () => {
    const base = new Date("2026-05-26T00:00:00Z");
    const intervalMinutes = 60;
    const nominalDeltaMs = intervalMinutes * 60_000;
    for (let i = 0; i < 200; i++) {
      const next = computeJitteredNextRunAt(base, intervalMinutes);
      const deltaMs = next.getTime() - base.getTime();
      const ratio = deltaMs / nominalDeltaMs;
      expect(ratio).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(ratio).toBeLessThan(1.1 + 1e-9);
    }
  });

  it("computeJitteredNextRunAt: 20-fire mean within ±2% of nominal (seeded rand)", () => {
    // Deterministic uniform PRNG with seeded state so jitter scatters across the full range
    // — protects the test from the test runner's environment.
    let seed = 0x12345678;
    const rand = () => {
      // Mulberry32
      seed = (seed + 0x6D2B79F5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const base = new Date("2026-05-26T00:00:00Z");
    const intervalMinutes = 60;
    const nominalDeltaMs = intervalMinutes * 60_000;
    const ratios: number[] = [];
    for (let i = 0; i < 20; i++) {
      const next = computeJitteredNextRunAt(base, intervalMinutes, rand);
      const deltaMs = next.getTime() - base.getTime();
      ratios.push(deltaMs / nominalDeltaMs);
      // each individual fire still within ±10%
      expect(ratios[i]).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(ratios[i]).toBeLessThan(1.1 + 1e-9);
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    // ±2% of nominal (i.e. mean ratio in [0.98, 1.02]).
    expect(mean).toBeGreaterThanOrEqual(0.98);
    expect(mean).toBeLessThanOrEqual(1.02);
  });
});

// ---------------------------------------------------------------------------
// DB-backed reconcile + tick tests
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ceo-blocked-sweep tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ceo-blocked-sweep / reconcile + tick", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof ceoBlockedSweepService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ceo-blocked-sweep-");
    db = createDb(tempDb.connectionString);
    svc = ceoBlockedSweepService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;
  async function makeCompany() {
    const companyId = randomUUID();
    const issuePrefix = `SWP${prefixCounter++}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function makeCeoAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      status: "idle",
    });
    return agentId;
  }

  const enabledSettings = async () => ({
    ceoBlockedSweepEnabled: true,
    ceoBlockedSweepIntervalMinutes: 60,
  });
  const disabledSettings = async () => ({
    ceoBlockedSweepEnabled: false,
    ceoBlockedSweepIntervalMinutes: 60,
  });

  it("reconcile: creates routine + schedule trigger when CEO exists; removes on termination", async () => {
    const companyId = await makeCompany();
    const ceoId = await makeCeoAgent(companyId);

    const created = await svc.reconcileForCompany(companyId, {
      experimentalSettings: enabledSettings,
    });
    expect(created.outcome).toBe("created");
    expect(created.routineId).toBeTruthy();

    const routineRows = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE)));
    expect(routineRows).toHaveLength(1);
    expect(routineRows[0].status).toBe("paused");
    expect(routineRows[0].assigneeAgentId).toBe(ceoId);

    const triggerRows = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, routineRows[0].id));
    expect(triggerRows).toHaveLength(1);
    expect(triggerRows[0].kind).toBe("schedule");
    expect(triggerRows[0].cronExpression).toBe("0 * * * *");
    expect(triggerRows[0].enabled).toBe(true);
    expect(triggerRows[0].nextRunAt).not.toBeNull();

    // Idempotent: a second reconcile is a no-op on the row identity.
    const second = await svc.reconcileForCompany(companyId, {
      experimentalSettings: enabledSettings,
    });
    expect(second.outcome).toBe("unchanged");
    expect(second.routineId).toBe(created.routineId);

    // Terminate the CEO → routine row removed on reconcile.
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, ceoId));
    const removed = await svc.reconcileForCompany(companyId, {
      experimentalSettings: enabledSettings,
    });
    expect(removed.outcome).toBe("skipped_no_ceo");
    expect(removed.routineId).toBeNull();
    const afterRemoval = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE)));
    expect(afterRemoval).toHaveLength(0);
  });

  it("reconcile: ceoBlockedSweepEnabled=false → no routine row, existing row removed", async () => {
    const companyId = await makeCompany();
    await makeCeoAgent(companyId);

    const skipped = await svc.reconcileForCompany(companyId, {
      experimentalSettings: disabledSettings,
    });
    expect(skipped.outcome).toBe("skipped_disabled");
    expect(skipped.routineId).toBeNull();
    const none = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE)));
    expect(none).toHaveLength(0);

    // Pre-existing routine (e.g. settings flipped from enabled → disabled) must
    // be torn down by reconcile.
    await svc.reconcileForCompany(companyId, { experimentalSettings: enabledSettings });
    const present = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE)));
    expect(present).toHaveLength(1);
    const flipped = await svc.reconcileForCompany(companyId, {
      experimentalSettings: disabledSettings,
    });
    expect(flipped.outcome).toBe("skipped_disabled");
    const afterFlip = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE)));
    expect(afterFlip).toHaveLength(0);
  });

  it("tickDue: wakes CEO with ceo_blocked_sweep_tick payload + blockedQueueSize audit", async () => {
    const companyId = await makeCompany();
    const ceoId = await makeCeoAgent(companyId);
    const now = new Date("2026-05-26T03:00:00.000Z");
    await svc.reconcileForCompany(companyId, {
      experimentalSettings: enabledSettings,
      now: () => now,
    });

    // Backdate nextRunAt so the tick claims it.
    const triggerRow = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.companyId, companyId))
      .then((rows) => rows[0]);
    expect(triggerRow).toBeTruthy();
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date(now.getTime() - 60_000) })
      .where(eq(routineTriggers.id, triggerRow.id));

    const blockedQueue: BlockedQueueItem[] = [
      {
        id: randomUUID(),
        identifier: "BLK-1",
        title: "Stalled work",
        priority: "high",
        ageMinutesSinceLastComment: 480,
        lastAuthor: { agentId: null, userId: null, type: null },
        lastCommentClass: "bounce",
        unresolvedInteractionIds: [],
        namedUnblockOwner: null,
      },
    ];
    const wakeup = vi.fn(async () => null);
    const listBlockedQueue = vi.fn(async (_cid: string) => blockedQueue);

    const result = await svc.tickDue({
      listBlockedQueue,
      wakeup,
      experimentalSettings: enabledSettings,
      now: () => now,
    });
    expect(result.triggered).toBe(1);
    expect(result.skipped).toBe(0);

    expect(listBlockedQueue).toHaveBeenCalledTimes(1);
    expect(listBlockedQueue).toHaveBeenCalledWith(companyId);

    expect(wakeup).toHaveBeenCalledTimes(1);
    const call = wakeup.mock.calls[0];
    if (!call) throw new Error("wakeup not called");
    const wakedAgentId = call[0];
    const wakeOpts = call[1];
    expect(wakedAgentId).toBe(ceoId);
    expect(wakeOpts.reason).toBe(CEO_BLOCKED_SWEEP_WAKE_REASON);
    expect(wakeOpts.source).toBe("automation");
    expect(wakeOpts.triggerDetail).toBe("system");
    expect(wakeOpts.requestedByActorType).toBe("system");
    const payload = wakeOpts.payload as Record<string, unknown>;
    expect(payload.reason).toBe(CEO_BLOCKED_SWEEP_WAKE_REASON);
    expect(payload.companyId).toBe(companyId);
    expect(payload.sweepIntervalMinutes).toBe(60);
    expect(payload.sweepFiredAt).toBe(now.toISOString());
    expect(payload.blockedQueueSize).toBe(1);
    expect(payload.blockedQueue).toEqual(blockedQueue);

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, CEO_BLOCKED_SWEEP_AUDIT_ACTION));
    expect(audit).toHaveLength(1);
    const details = audit[0].details as Record<string, unknown>;
    expect(details.blockedQueueSize).toBe(1);
    expect(details.sweepIntervalMinutes).toBe(60);
    expect(details.routineId).toBeTruthy();

    // nextRunAt advanced past `now` after the fire.
    const afterTrigger = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, triggerRow.id))
      .then((rows) => rows[0]);
    expect(afterTrigger.nextRunAt).not.toBeNull();
    expect(afterTrigger.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(afterTrigger.lastFiredAt!.getTime()).toBe(now.getTime());
  });

  it("tickDue: disable flag suppresses all wakes even if a routine row exists", async () => {
    const companyId = await makeCompany();
    await makeCeoAgent(companyId);
    const now = new Date("2026-05-26T04:00:00.000Z");
    await svc.reconcileForCompany(companyId, { experimentalSettings: enabledSettings, now: () => now });
    const triggerRow = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.companyId, companyId))
      .then((rows) => rows[0]);
    await db
      .update(routineTriggers)
      .set({ nextRunAt: new Date(now.getTime() - 60_000) })
      .where(eq(routineTriggers.id, triggerRow.id));

    const wakeup = vi.fn(async () => null);
    const listBlockedQueue = vi.fn(async () => [] as BlockedQueueItem[]);
    const result = await svc.tickDue({
      listBlockedQueue,
      wakeup,
      experimentalSettings: disabledSettings,
      now: () => now,
    });
    expect(result.triggered).toBe(0);
    expect(wakeup).not.toHaveBeenCalled();
    expect(listBlockedQueue).not.toHaveBeenCalled();
  });
});
