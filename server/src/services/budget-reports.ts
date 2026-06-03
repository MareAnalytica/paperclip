import { and, eq, gte, like, lt, sql, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetCaps, costEvents } from "@paperclipai/db";
import {
  BUDGET_WINDOWS,
  type BudgetWindow,
  isCalendarWindow,
  currentCalendarWindow,
  rollingWindowBounds,
  type CalendarWindow,
  type RollingWindow,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";

// Read-only budget reporting — agent-budgeting policy §6.1 (burn) and §6.4
// (forecast). All math is over cost_events.cost_micros (the §2.1 frozen-pricing
// field) and budget_caps.limit_micros. Legacy rows that predate §2.1 carry only
// cost_cents; we fold those in at 1 cent = 10_000 micros so burn stays
// meaningful through the writer transition (ELI-72/75). Nothing here mutates
// state.

// ---------------------------------------------------------------------------
// Config-driven defaults (policy §6.4 / §appendix). Exposed as named constants
// so they remain tunable per cluster via query override; no values are baked
// into call sites. Keep these in lock-step with config/agent-budgeting.yaml in
// the eli-board blueprint when that loader lands.
// ---------------------------------------------------------------------------

export type ForecastMode = "linear" | "recent_window";
export const FORECAST_MODES: readonly ForecastMode[] = ["linear", "recent_window"];

/** Default extrapolation mode when forecast.mode is unset (policy §6.1: linear). */
export const DEFAULT_FORECAST_MODE: ForecastMode = "linear";

/** Min cost_events in the window before we trust a projection (else insufficient_history). */
export const DEFAULT_MIN_EVENTS_FOR_FORECAST = 5;

/**
 * recent_window smoothing window (policy §6.4 / appendix: min(2h, elapsed/4)).
 * `recentWindowHours` overrides the 2h ceiling; the elapsed/4 floor still applies.
 */
export const DEFAULT_RECENT_WINDOW_HOURS = 2;

/** Top-contributor dimensions a burn slice can be grouped by (policy §6.1). */
export const BURN_DIMENSIONS = ["agent", "project", "model", "billingCode", "provider"] as const;
export type BurnDimension = (typeof BURN_DIMENSIONS)[number];

const MICROS_PER_CENT = 10_000;

// cost_micros when present, else legacy cents folded up to micros.
const spendMicrosExpr = sql<number>`coalesce(sum(coalesce(${costEvents.costMicros}, ${costEvents.costCents} * ${MICROS_PER_CENT})), 0)::double precision`;

export interface BurnTopContributor {
  dimension: BurnDimension;
  key: string;
  spendMicros: number;
}

export interface BudgetBurn {
  scope: string;
  scopeKey: string;
  window: BudgetWindow;
  windowStart: string;
  windowEnd: string;
  spendMicros: number;
  limitMicros: number | null;
  percent: number | null;
  // Linear extrapolation of current-window spend to windowEnd (policy §6.1).
  projectedSpendMicros: number;
  projectedPercent: number | null;
  topAttributable: BurnTopContributor[];
}

export type ForecastCapStatus =
  | "ok"
  | "warning"
  | "critical"
  | "exhausted"
  | "insufficient_history";

export interface ForecastCap {
  capId: string;
  scope: string;
  scopeKey: string;
  window: BudgetWindow;
  action: string;
  windowStart: string | null;
  windowEnd: string;
  limitMicros: number;
  spendMicros: number;
  eventCount: number;
  currentPercent: number;
  projectedPercent: number | null;
  // Estimated wall-clock at which projected spend reaches limitMicros, or null
  // when the recent run-rate is zero / the window has no end (total).
  projectedExhaustionAt: string | null;
  warnAtPercent: number;
  criticalAtPercent: number;
  hardStopAtPercent: number;
  status: ForecastCapStatus;
}

export interface BudgetForecast {
  mode: ForecastMode;
  minEventsForForecast: number;
  caps: ForecastCap[];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a db) — the risky projection math lives here.
// ---------------------------------------------------------------------------

export interface WindowSpan {
  windowStart: Date | null; // null == open start (total / lifetime)
  windowEnd: Date;
}

/**
 * Linear extrapolation of spend over [windowStart, windowEnd) to windowEnd, given
 * the spend accrued up to `now` (policy §6.1). For open-start or already-closed
 * windows there is no future fraction to project into, so spend is returned as-is.
 */
export function linearProjectedSpend(spend: number, span: WindowSpan, now: Date): number {
  if (span.windowStart == null) return spend;
  const elapsedMs = now.getTime() - span.windowStart.getTime();
  const lengthMs = span.windowEnd.getTime() - span.windowStart.getTime();
  if (elapsedMs <= 0 || lengthMs <= 0) return spend;
  if (now.getTime() >= span.windowEnd.getTime()) return spend;
  return (spend * lengthMs) / elapsedMs;
}

/**
 * recent_window projection (policy §6.4): project the run-rate measured over the
 * trailing `recentSpan` across the remainder of the window.
 *   projectedSpend = spend + windowRemainingMs * (recentSpend / recentSpanMs)
 * `recentSpend` is the spend accrued in the trailing window; `recentSpanMs` is
 * its length (clamped to elapsed). Returns spend unchanged for open/closed windows.
 */
export function recentWindowProjectedSpend(
  spend: number,
  recentSpend: number,
  recentSpanMs: number,
  span: WindowSpan,
  now: Date,
): number {
  if (span.windowStart == null) return spend;
  if (now.getTime() >= span.windowEnd.getTime()) return spend;
  if (recentSpanMs <= 0) return spend;
  const remainingMs = span.windowEnd.getTime() - now.getTime();
  const ratePerMs = recentSpend / recentSpanMs;
  return spend + remainingMs * ratePerMs;
}

/**
 * Wall-clock at which cumulative spend reaches `limitMicros`, projecting forward
 * at `ratePerMs` from `now`/`spend`. Null when the rate is non-positive, the
 * limit is already reached, or the projected exhaustion lands past windowEnd
 * (the window rolls over first, so it never exhausts within this window).
 */
export function projectedExhaustionAt(
  spend: number,
  limitMicros: number,
  ratePerMs: number,
  span: WindowSpan,
  now: Date,
): Date | null {
  if (ratePerMs <= 0) return null;
  if (spend >= limitMicros) return now; // already over — exhausted as of now
  const msToLimit = (limitMicros - spend) / ratePerMs;
  const at = new Date(now.getTime() + msToLimit);
  if (at.getTime() > span.windowEnd.getTime()) return null;
  return at;
}

/** §4.3 threshold ladder mapped onto a projected percent. */
export function forecastStatus(
  projectedPercent: number,
  caps: { warnAtPercent: number; criticalAtPercent: number; hardStopAtPercent: number },
): Exclude<ForecastCapStatus, "insufficient_history"> {
  if (projectedPercent >= caps.hardStopAtPercent) return "exhausted";
  if (projectedPercent >= caps.criticalAtPercent) return "critical";
  if (projectedPercent >= caps.warnAtPercent) return "warning";
  return "ok";
}

/**
 * The trailing recent-window length used by recent_window mode:
 * min(recentWindowHours, elapsed/4), floored at a sane minimum so a brand-new
 * window still has a measurable rate. Returns ms.
 */
export function recentWindowSpanMs(
  elapsedMs: number,
  recentWindowHours = DEFAULT_RECENT_WINDOW_HOURS,
): number {
  const ceilingMs = recentWindowHours * 3_600_000;
  const quarterElapsed = elapsedMs / 4;
  // clamp(elapsed/4, [1 minute, ceiling]). The 1-minute floor keeps the rate
  // defined on a brand-new window (elapsed≈0) instead of dividing recent spend
  // by the full ceiling and under-reading the run-rate to ~0.
  return Math.max(60_000, Math.min(ceilingMs, quarterElapsed));
}

export function resolveWindowSpan(window: BudgetWindow, now: Date): WindowSpan {
  if (isCalendarWindow(window)) {
    const bounds = currentCalendarWindow(window as CalendarWindow, now);
    return { windowStart: bounds.windowStart, windowEnd: bounds.windowEnd };
  }
  const bounds = rollingWindowBounds(window as RollingWindow | "total", now);
  return { windowStart: bounds.windowStart, windowEnd: bounds.windowEnd };
}

function safePercent(spend: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  return (spend / limit) * 100;
}

// cost_events filter conditions for a (scope, scopeKey) within a company. Every
// branch is company-pinned for tenant isolation; cluster scope is intentionally
// not handled here (cross-tenant, operator-only — out of scope for this endpoint).
function scopeConditions(companyId: string, scope: string, scopeKey: string) {
  const conditions = [eq(costEvents.companyId, companyId)];
  switch (scope) {
    case "company":
      break;
    case "agent":
      conditions.push(eq(costEvents.agentId, scopeKey));
      break;
    case "project":
      conditions.push(eq(costEvents.projectId, scopeKey));
      break;
    case "goal":
      conditions.push(eq(costEvents.goalId, scopeKey));
      break;
    case "issue":
      conditions.push(eq(costEvents.issueId, scopeKey));
      break;
    case "provider":
      conditions.push(eq(costEvents.provider, scopeKey));
      break;
    case "model":
      conditions.push(sql`${costEvents.provider} || ':' || ${costEvents.model} = ${scopeKey}`);
      break;
    case "billingCode":
      // §2.2: billingCode caps match a `code/%` prefix.
      conditions.push(like(costEvents.billingCode, `${scopeKey}%`));
      break;
    default:
      throw badRequest(`unsupported budget scope '${scope}'`);
  }
  return conditions;
}

function windowTimeConditions(span: WindowSpan) {
  const conditions = [];
  if (span.windowStart != null) conditions.push(gte(costEvents.occurredAt, span.windowStart));
  conditions.push(lt(costEvents.occurredAt, span.windowEnd));
  return conditions;
}

export function budgetReportService(db: Db) {
  async function sumSpendMicros(conditions: ReturnType<typeof eq>[]) {
    const [row] = await db
      .select({
        spendMicros: spendMicrosExpr,
        eventCount: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(and(...conditions));
    return { spendMicros: Number(row?.spendMicros ?? 0), eventCount: Number(row?.eventCount ?? 0) };
  }

  async function topByDimension(
    companyId: string,
    span: WindowSpan,
    dimension: BurnDimension,
    topN: number,
  ): Promise<BurnTopContributor[]> {
    const keyExpr =
      dimension === "agent"
        ? sql<string>`${costEvents.agentId}::text`
        : dimension === "project"
          ? sql<string>`${costEvents.projectId}::text`
          : dimension === "model"
            ? sql<string>`${costEvents.provider} || ':' || ${costEvents.model}`
            : dimension === "provider"
              ? sql<string>`${costEvents.provider}`
              : sql<string>`${costEvents.billingCode}`;

    const conditions = [eq(costEvents.companyId, companyId), ...windowTimeConditions(span)];
    // Skip rows with a null grouping key (e.g. unattributed project/billingCode).
    conditions.push(sql`${keyExpr} is not null`);

    const rows = await db
      .select({ key: keyExpr, spendMicros: spendMicrosExpr })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(keyExpr)
      .orderBy(desc(spendMicrosExpr))
      .limit(topN);

    return rows.map((row) => ({
      dimension,
      key: String(row.key),
      spendMicros: Number(row.spendMicros),
    }));
  }

  return {
    burn: async (
      companyId: string,
      opts: {
        scope?: string;
        scopeKey?: string;
        window?: BudgetWindow;
        dimensions?: BurnDimension[];
        topN?: number;
        now?: Date;
      } = {},
    ): Promise<BudgetBurn> => {
      const scope = opts.scope ?? "company";
      const scopeKey = opts.scopeKey ?? companyId;
      const window = opts.window ?? "month";
      const dimensions = opts.dimensions ?? [...BURN_DIMENSIONS];
      const topN = opts.topN ?? 1;
      const now = opts.now ?? new Date();

      const span = resolveWindowSpan(window, now);
      const { spendMicros } = await sumSpendMicros([
        ...scopeConditions(companyId, scope, scopeKey),
        ...windowTimeConditions(span),
      ]);

      // Limit comes from the matching active cap for this (scope, scopeKey, window).
      const cap = await db
        .select({ limitMicros: budgetCaps.limitMicros })
        .from(budgetCaps)
        .where(
          and(
            eq(budgetCaps.companyId, companyId),
            eq(budgetCaps.scope, scope),
            eq(budgetCaps.scopeKey, scopeKey),
            eq(budgetCaps.window, window),
            eq(budgetCaps.isActive, true),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const limitMicros = cap ? Number(cap.limitMicros) : null;

      const projectedSpendMicros = linearProjectedSpend(spendMicros, span, now);

      const topAttributable = (
        await Promise.all(dimensions.map((dimension) => topByDimension(companyId, span, dimension, topN)))
      ).flat();

      return {
        scope,
        scopeKey,
        window,
        windowStart: (span.windowStart ?? new Date(0)).toISOString(),
        windowEnd: span.windowEnd.toISOString(),
        spendMicros,
        limitMicros,
        percent: safePercent(spendMicros, limitMicros),
        projectedSpendMicros,
        projectedPercent: safePercent(projectedSpendMicros, limitMicros),
        topAttributable,
      };
    },

    forecast: async (
      companyId: string,
      opts: {
        mode?: ForecastMode;
        minEvents?: number;
        recentWindowHours?: number;
        now?: Date;
      } = {},
    ): Promise<BudgetForecast> => {
      const mode = opts.mode ?? DEFAULT_FORECAST_MODE;
      const minEvents = opts.minEvents ?? DEFAULT_MIN_EVENTS_FOR_FORECAST;
      const recentWindowHours = opts.recentWindowHours ?? DEFAULT_RECENT_WINDOW_HOURS;
      const now = opts.now ?? new Date();

      // Tenant caps only. Cluster caps (company_id NULL) are operator-scope and
      // cross-tenant; surfacing their spend here would leak other tenants' data.
      const caps = await db
        .select()
        .from(budgetCaps)
        .where(and(eq(budgetCaps.companyId, companyId), eq(budgetCaps.isActive, true)));

      const results: ForecastCap[] = [];
      for (const cap of caps) {
        const window = cap.window as BudgetWindow;
        if (!BUDGET_WINDOWS.includes(window)) continue;
        const span = resolveWindowSpan(window, now);

        const baseConditions = [
          ...scopeConditions(companyId, cap.scope, cap.scopeKey),
          ...windowTimeConditions(span),
        ];
        const { spendMicros, eventCount } = await sumSpendMicros(baseConditions);
        const limitMicros = Number(cap.limitMicros);
        const currentPercent = limitMicros > 0 ? (spendMicros / limitMicros) * 100 : 0;

        const base = {
          capId: cap.id,
          scope: cap.scope,
          scopeKey: cap.scopeKey,
          window,
          action: cap.action,
          windowStart: span.windowStart ? span.windowStart.toISOString() : null,
          windowEnd: span.windowEnd.toISOString(),
          limitMicros,
          spendMicros,
          eventCount,
          currentPercent,
          warnAtPercent: cap.warnAtPercent,
          criticalAtPercent: cap.criticalAtPercent,
          hardStopAtPercent: cap.hardStopAtPercent,
        };

        if (eventCount < minEvents) {
          results.push({
            ...base,
            projectedPercent: null,
            projectedExhaustionAt: null,
            status: "insufficient_history",
          });
          continue;
        }

        const elapsedMs =
          span.windowStart != null ? now.getTime() - span.windowStart.getTime() : 0;

        let projectedSpend: number;
        let ratePerMs: number;
        if (mode === "recent_window" && span.windowStart != null) {
          const spanMs = recentWindowSpanMs(elapsedMs, recentWindowHours);
          const recentStart = new Date(now.getTime() - spanMs);
          const { spendMicros: recentSpend } = await sumSpendMicros([
            ...scopeConditions(companyId, cap.scope, cap.scopeKey),
            gte(costEvents.occurredAt, recentStart),
            lt(costEvents.occurredAt, span.windowEnd),
          ]);
          projectedSpend = recentWindowProjectedSpend(spendMicros, recentSpend, spanMs, span, now);
          ratePerMs = recentSpend / spanMs;
        } else {
          projectedSpend = linearProjectedSpend(spendMicros, span, now);
          ratePerMs = elapsedMs > 0 ? spendMicros / elapsedMs : 0;
        }

        const projectedPercent = limitMicros > 0 ? (projectedSpend / limitMicros) * 100 : 0;
        const exhaustionAt = projectedExhaustionAt(spendMicros, limitMicros, ratePerMs, span, now);

        results.push({
          ...base,
          projectedPercent,
          projectedExhaustionAt: exhaustionAt ? exhaustionAt.toISOString() : null,
          status: forecastStatus(projectedPercent, cap),
        });
      }

      return { mode, minEventsForForecast: minEvents, caps: results };
    },
  };
}

export type BudgetReportService = ReturnType<typeof budgetReportService>;
