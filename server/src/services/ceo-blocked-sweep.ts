/**
 * F6 — CEO periodic blocked-queue sweep (`ceo_blocked_sweep_tick`).
 *
 * Per-company managed routine that fires every
 * `instanceExperimentalSettings.ceoBlockedSweepIntervalMinutes` minutes
 * (default 60) with ±10% jitter and wakes the company's CEO agent with the
 * inline F7 blocked-queue projection as payload. Backs F5's event-driven
 * invariant with a heartbeat fallback so quiet periods can never strand the
 * CEO indefinitely (canonical case: 09:05Z→15:04Z stall on 2026-05-24).
 *
 * Implementation notes
 *
 * - State is persisted as a row in the existing `routines` table with
 *   `status="paused"` and a sentinel marker in `description`. The paused
 *   status keeps the regular schedule ticker (`routineService.tickScheduledTriggers`)
 *   from accidentally dispatching the routine through the normal
 *   issue-creating path — this sweep wakes the CEO directly instead.
 * - The accompanying `schedule` trigger carries the nominal cron expression
 *   matching the configured interval. Real fire times are driven by the
 *   trigger's `nextRunAt`, which we advance with per-fire jitter when the
 *   sweep runs.
 */

import { and, asc, eq, isNotNull, lte, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type { BlockedQueueItem } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CEO_BLOCKED_SWEEP_KIND = "ceo_blocked_sweep";
export const CEO_BLOCKED_SWEEP_ROUTINE_TITLE = "CEO Blocked-Queue Sweep";
export const CEO_BLOCKED_SWEEP_TRIGGER_LABEL = "ceo_blocked_sweep";
export const CEO_BLOCKED_SWEEP_WAKE_REASON = "ceo_blocked_sweep_tick";
export const CEO_BLOCKED_SWEEP_AUDIT_ACTION = "ceo_blocked_sweep.fired";

const SENTINEL_DESCRIPTION_PREFIX = `[system:${CEO_BLOCKED_SWEEP_KIND}]`;
const SENTINEL_DESCRIPTION_BODY =
  "System-managed CEO blocked-queue sweep. Fires every N minutes with ±10% jitter " +
  "to wake the CEO agent with the current blocked-queue projection. Do not edit.";

// Per-fire jitter half-width. ±10% per the F6 spec.
const JITTER_HALF_WIDTH = 0.10;

// Default per-tick scan/dispatch limit, defensively bounded so a misconfigured
// instance can't fan out unbounded wakes from one tick.
const DEFAULT_TICK_BATCH_LIMIT = 64;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function ceoBlockedSweepDescription(): string {
  return `${SENTINEL_DESCRIPTION_PREFIX} ${SENTINEL_DESCRIPTION_BODY}`;
}

export function isCeoBlockedSweepRoutine(routine: { description: string | null }): boolean {
  return Boolean(routine.description && routine.description.startsWith(SENTINEL_DESCRIPTION_PREFIX));
}

/**
 * Pick a representative 5-field cron expression for the configured interval.
 *
 * Cron is best at sub-hourly evenly-divisible intervals; for any other case
 * we still emit a valid 5-field expression so external tooling can inspect
 * the routine without choking, but the authoritative fire times are stored
 * on the trigger's `nextRunAt` column and advanced by `computeJitteredNextRunAt`.
 */
export function intervalToNominalCronExpression(intervalMinutes: number): string {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    return "0 * * * *";
  }
  const minutes = Math.floor(intervalMinutes);
  if (minutes >= 60) {
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      if (hours === 1) return "0 * * * *";
      if (24 % hours === 0) return `0 */${hours} * * *`;
    }
    return "0 * * * *";
  }
  if (60 % minutes === 0) return `*/${minutes} * * * *`;
  return `*/${minutes} * * * *`;
}

/**
 * Advance `after` by `intervalMinutes` minutes, jittered ±10% uniformly.
 * Guarantees a strictly positive delta so a degenerate `rand()` return of
 * exactly `0.0` (which maps to factor `0.9`) still moves forward.
 */
export function computeJitteredNextRunAt(
  after: Date,
  intervalMinutes: number,
  rand: () => number = Math.random,
): Date {
  const safeInterval = Math.max(1, Math.floor(intervalMinutes));
  const jitter = (rand() * 2 - 1) * JITTER_HALF_WIDTH; // uniform on [-0.10, +0.10)
  const factor = 1 + jitter;
  const deltaMs = Math.max(1, Math.round(safeInterval * 60_000 * factor));
  return new Date(after.getTime() + deltaMs);
}

// ---------------------------------------------------------------------------
// Wake payload shape
// ---------------------------------------------------------------------------

export interface CeoBlockedSweepWakePayload {
  reason: typeof CEO_BLOCKED_SWEEP_WAKE_REASON;
  companyId: string;
  sweepIntervalMinutes: number;
  sweepFiredAt: string;
  blockedQueueSize: number;
  blockedQueue: BlockedQueueItem[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ExperimentalSweepSettings {
  ceoBlockedSweepEnabled: boolean;
  ceoBlockedSweepIntervalMinutes: number;
}

export type ExperimentalSettingsReader = () => Promise<ExperimentalSweepSettings>;

export interface CeoBlockedSweepWakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

export type WakeupFn = (
  agentId: string,
  opts: CeoBlockedSweepWakeupOptions,
) => Promise<unknown>;

export interface CeoBlockedSweepTickDeps {
  listBlockedQueue(companyId: string): Promise<BlockedQueueItem[]>;
  wakeup: WakeupFn;
  experimentalSettings: ExperimentalSettingsReader;
  now?: () => Date;
  rand?: () => number;
  batchLimit?: number;
}

export interface ReconcileOutcome {
  outcome: "created" | "updated" | "removed" | "unchanged" | "skipped_no_ceo" | "skipped_disabled";
  routineId: string | null;
}

export function ceoBlockedSweepService(db: Db) {
  async function findExistingRoutine(companyId: string) {
    const rows = await db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.companyId, companyId),
          eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE),
        ),
      );
    // Sentinel match is the authoritative check; the title is a secondary hint.
    return rows.find((row) => isCeoBlockedSweepRoutine(row)) ?? null;
  }

  async function findActiveCeoAgent(companyId: string) {
    const ceo = await db
      .select({ id: agents.id, createdAt: agents.createdAt })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.role, "ceo"),
          ne(agents.status, "terminated"),
        ),
      )
      .orderBy(asc(agents.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return ceo;
  }

  async function deleteRoutine(routineId: string) {
    // routine_triggers has ON DELETE CASCADE on routine_id, so deleting the
    // routine row drops its trigger(s) too.
    await db.delete(routines).where(eq(routines.id, routineId));
  }

  async function reconcileForCompany(
    companyId: string,
    deps: { experimentalSettings: ExperimentalSettingsReader; now?: () => Date; rand?: () => number },
  ): Promise<ReconcileOutcome> {
    const now = (deps.now ?? (() => new Date()))();
    const settings = await deps.experimentalSettings();
    const ceo = await findActiveCeoAgent(companyId);
    const existing = await findExistingRoutine(companyId);

    const shouldExist = settings.ceoBlockedSweepEnabled && ceo !== null;
    if (!shouldExist) {
      if (existing) {
        await deleteRoutine(existing.id);
        return {
          outcome: settings.ceoBlockedSweepEnabled ? "skipped_no_ceo" : "skipped_disabled",
          routineId: null,
        };
      }
      return {
        outcome: settings.ceoBlockedSweepEnabled ? "skipped_no_ceo" : "skipped_disabled",
        routineId: null,
      };
    }

    const interval = settings.ceoBlockedSweepIntervalMinutes;
    const cronExpression = intervalToNominalCronExpression(interval);
    const description = ceoBlockedSweepDescription();
    const rand = deps.rand ?? Math.random;

    if (existing) {
      // Update assignee + description + (next-run schedule) idempotently if drifted.
      const assigneeChanged = existing.assigneeAgentId !== ceo!.id;
      const descChanged = existing.description !== description;
      if (assigneeChanged || descChanged) {
        await db
          .update(routines)
          .set({
            assigneeAgentId: ceo!.id,
            description,
            updatedAt: now,
          })
          .where(eq(routines.id, existing.id));
      }

      // Reconcile the schedule trigger (interval or cron change). We keep at
      // most one schedule trigger per sweep routine; extras are pruned.
      const triggers = await db
        .select()
        .from(routineTriggers)
        .where(
          and(eq(routineTriggers.routineId, existing.id), eq(routineTriggers.kind, "schedule")),
        )
        .orderBy(asc(routineTriggers.createdAt));

      if (triggers.length === 0) {
        await db.insert(routineTriggers).values({
          companyId,
          routineId: existing.id,
          kind: "schedule",
          label: CEO_BLOCKED_SWEEP_TRIGGER_LABEL,
          enabled: true,
          cronExpression,
          timezone: "UTC",
          nextRunAt: computeJitteredNextRunAt(now, interval, rand),
        });
      } else {
        const [primary, ...extras] = triggers;
        const cronChanged = primary.cronExpression !== cronExpression;
        if (cronChanged || !primary.nextRunAt || primary.nextRunAt <= now) {
          await db
            .update(routineTriggers)
            .set({
              cronExpression,
              timezone: primary.timezone ?? "UTC",
              nextRunAt: cronChanged
                ? computeJitteredNextRunAt(now, interval, rand)
                : primary.nextRunAt ?? computeJitteredNextRunAt(now, interval, rand),
              enabled: true,
              updatedAt: now,
            })
            .where(eq(routineTriggers.id, primary.id));
        }
        for (const extra of extras) {
          await db.delete(routineTriggers).where(eq(routineTriggers.id, extra.id));
        }
      }

      return {
        outcome: assigneeChanged || descChanged ? "updated" : "unchanged",
        routineId: existing.id,
      };
    }

    // Create routine + trigger.
    const [created] = await db
      .insert(routines)
      .values({
        companyId,
        title: CEO_BLOCKED_SWEEP_ROUTINE_TITLE,
        description,
        assigneeAgentId: ceo!.id,
        priority: "high",
        status: "paused", // hides from the regular schedule ticker
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
        env: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await db.insert(routineTriggers).values({
      companyId,
      routineId: created.id,
      kind: "schedule",
      label: CEO_BLOCKED_SWEEP_TRIGGER_LABEL,
      enabled: true,
      cronExpression,
      timezone: "UTC",
      nextRunAt: computeJitteredNextRunAt(now, interval, rand),
      createdAt: now,
      updatedAt: now,
    });

    return { outcome: "created", routineId: created.id };
  }

  async function listDueSweeps(now: Date, limit: number) {
    return db
      .select({
        routine: routines,
        trigger: routineTriggers,
      })
      .from(routineTriggers)
      .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
      .where(
        and(
          eq(routineTriggers.kind, "schedule"),
          eq(routineTriggers.enabled, true),
          isNotNull(routineTriggers.nextRunAt),
          lte(routineTriggers.nextRunAt, now),
          eq(routines.title, CEO_BLOCKED_SWEEP_ROUTINE_TITLE),
        ),
      )
      .orderBy(asc(routineTriggers.nextRunAt))
      .limit(limit);
  }

  /**
   * Tick handler: dispatch one wake per due sweep routine. Always called from
   * a scheduler interval (`server/src/index.ts`) — never from request paths.
   *
   * For each due, sentinel-tagged routine:
   *
   * 1. Atomically claim the trigger by advancing `nextRunAt` to a jittered
   *    next-fire timestamp. Skip the row if another node won the CAS.
   * 2. Load the F7 blocked-queue projection.
   * 3. Wake the CEO with `ceo_blocked_sweep_tick`, inline `blockedQueue`,
   *    and a `blockedQueueSize` audit entry.
   */
  async function tickDue(deps: CeoBlockedSweepTickDeps): Promise<{ triggered: number; skipped: number }> {
    const now = (deps.now ?? (() => new Date()))();
    const rand = deps.rand ?? Math.random;
    const limit = Math.max(1, deps.batchLimit ?? DEFAULT_TICK_BATCH_LIMIT);
    const settings = await deps.experimentalSettings();
    if (!settings.ceoBlockedSweepEnabled) {
      return { triggered: 0, skipped: 0 };
    }

    const due = await listDueSweeps(now, limit);
    let triggered = 0;
    let skipped = 0;

    for (const row of due) {
      // Re-confirm sentinel (defense-in-depth: title match alone is not authoritative).
      if (!isCeoBlockedSweepRoutine(row.routine)) {
        skipped += 1;
        continue;
      }

      const assigneeAgentId = row.routine.assigneeAgentId;
      if (!assigneeAgentId) {
        skipped += 1;
        continue;
      }

      const interval = settings.ceoBlockedSweepIntervalMinutes;
      const claimedNextRunAt = computeJitteredNextRunAt(now, interval, rand);

      const claimed = await db
        .update(routineTriggers)
        .set({
          nextRunAt: claimedNextRunAt,
          lastFiredAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(routineTriggers.id, row.trigger.id),
            eq(routineTriggers.enabled, true),
            row.trigger.nextRunAt
              ? eq(routineTriggers.nextRunAt, row.trigger.nextRunAt)
              : isNotNull(routineTriggers.nextRunAt),
          ),
        )
        .returning({ id: routineTriggers.id });
      if (claimed.length === 0) {
        skipped += 1;
        continue;
      }

      try {
        const blockedQueue = await deps.listBlockedQueue(row.routine.companyId);
        const payload: CeoBlockedSweepWakePayload = {
          reason: CEO_BLOCKED_SWEEP_WAKE_REASON,
          companyId: row.routine.companyId,
          sweepIntervalMinutes: interval,
          sweepFiredAt: now.toISOString(),
          blockedQueueSize: blockedQueue.length,
          blockedQueue,
        };
        await deps.wakeup(assigneeAgentId, {
          source: "automation" as const,
          triggerDetail: "system" as const,
          reason: CEO_BLOCKED_SWEEP_WAKE_REASON,
          payload: payload as unknown as Record<string, unknown>,
          requestedByActorType: "system" as const,
          requestedByActorId: null,
          contextSnapshot: {
            wakeReason: CEO_BLOCKED_SWEEP_WAKE_REASON,
            source: "ceo_blocked_sweep",
            companyId: row.routine.companyId,
            sweepIntervalMinutes: interval,
            sweepFiredAt: now.toISOString(),
            blockedQueueSize: blockedQueue.length,
          },
        });
        await logActivity(db, {
          companyId: row.routine.companyId,
          actorType: "system",
          actorId: "ceo_blocked_sweep",
          action: CEO_BLOCKED_SWEEP_AUDIT_ACTION,
          entityType: "agent",
          entityId: assigneeAgentId,
          details: {
            routineId: row.routine.id,
            triggerId: row.trigger.id,
            sweepIntervalMinutes: interval,
            blockedQueueSize: blockedQueue.length,
            firedAt: now.toISOString(),
            nextRunAt: claimedNextRunAt.toISOString(),
          },
        });
        await db
          .update(routines)
          .set({ lastTriggeredAt: now, lastEnqueuedAt: now, updatedAt: now })
          .where(eq(routines.id, row.routine.id));
        triggered += 1;
      } catch (err) {
        logger.error(
          { err, companyId: row.routine.companyId, routineId: row.routine.id },
          "ceo blocked sweep tick failed to dispatch",
        );
        skipped += 1;
      }
    }

    return { triggered, skipped };
  }

  async function reconcileAllCompanies(deps: {
    experimentalSettings: ExperimentalSettingsReader;
    listCompanyIds: () => Promise<string[]>;
    now?: () => Date;
    rand?: () => number;
  }) {
    const companyIds = await deps.listCompanyIds();
    let created = 0;
    let updated = 0;
    let removed = 0;
    for (const companyId of companyIds) {
      try {
        const outcome = await reconcileForCompany(companyId, deps);
        if (outcome.outcome === "created") created += 1;
        else if (outcome.outcome === "updated") updated += 1;
        else if (outcome.outcome === "skipped_no_ceo" || outcome.outcome === "skipped_disabled") {
          if (outcome.routineId === null) {
            // Pre-existing routine removed by reconcile.
          }
        }
      } catch (err) {
        logger.error({ err, companyId }, "ceo blocked sweep reconcile failed for company");
      }
    }
    return { created, updated, removed };
  }

  return {
    reconcileForCompany,
    reconcileAllCompanies,
    tickDue,
    findExistingRoutine,
  };
}
