import type { PreflightResult, ChargeResult } from "@paperclipai/paperclip-cost-client";

/**
 * Cached burn / headroom hint (ELI-943).
 *
 * PR #121 (ELI-938) wired `forcePreflightAbovePercent` into the cost client, but
 * the path is dormant end-to-end: no adapter call site passes `capUsedPercent`,
 * so a near-exhausted cap on a stream of *cheap* calls (each below
 * `estimateThresholdMicros`) never triggers a preflight and can overshoot the cap.
 *
 * This module closes that gap with a tiny in-process cache of the most-binding
 * cap's current utilization, populated from the server-authoritative signals that
 * already come back on every preflight/charge response:
 *   - PreflightResult.warnings[].percent  -> current utilization of each warned cap
 *   - PreflightResult.preflightRequired   -> server says "this was critical/above threshold"
 *   - ChargeResult.alertsFired            -> a cap action fired on this charge
 *
 * The next preflight call reads this cache and supplies `capUsedPercent` (and, when
 * the server previously flagged `preflightRequired`/an alert, `forcePreflight`) as a
 * CLIENT-ONLY hint. The client never sends these in the request body — the server
 * recomputes utilization authoritatively — so this only changes *whether* a cheap
 * call does a real preflight roundtrip, never the enforcement decision itself.
 *
 * Safe-by-default: when a cap is healthy no warnings/alerts come back, the cached
 * percent stays low (or absent), and the common cheap-call path skips preflight
 * exactly as before. Extra roundtrips happen only once a cap is already near its
 * critical percent.
 */

export interface BurnHint {
  /** Most-binding cap utilization (0-100) observed on the last response, or null if unknown. */
  capUsedPercent: number | null;
  /** Server asked for a forced preflight on the next call (preflightRequired / an alert fired). */
  preflightRequired: boolean;
}

interface BurnHintEntry extends BurnHint {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60_000;

/** Module-level cache keyed by companyId. Process-local, best-effort, no persistence. */
const cache = new Map<string, BurnHintEntry>();

function now(nowMs?: number): number {
  return typeof nowMs === "number" ? nowMs : Date.now();
}

/** Max utilization across warned caps = the most-binding cap's current percent. */
function maxWarningPercent(warnings: PreflightResult["warnings"] | undefined): number | null {
  if (!warnings || warnings.length === 0) return null;
  let max = -1;
  for (const w of warnings) {
    if (typeof w?.percent === "number" && w.percent > max) max = w.percent;
  }
  return max >= 0 ? max : null;
}

/** Read the current (non-expired) hint for a company, or null if none/expired. */
export function getBurnHint(companyId: string | null | undefined, nowMs?: number): BurnHint | null {
  if (!companyId) return null;
  const entry = cache.get(companyId);
  if (!entry) return null;
  if (entry.expiresAt <= now(nowMs)) {
    cache.delete(companyId);
    return null;
  }
  return { capUsedPercent: entry.capUsedPercent, preflightRequired: entry.preflightRequired };
}

/** Fold a preflight response into the cache (warnings percent + preflightRequired). */
export function recordPreflightResult(
  companyId: string | null | undefined,
  result: Pick<PreflightResult, "warnings" | "preflightRequired"> | null | undefined,
  ttlMs: number = DEFAULT_TTL_MS,
  nowMs?: number,
): void {
  if (!companyId || !result) return;
  cache.set(companyId, {
    capUsedPercent: maxWarningPercent(result.warnings),
    preflightRequired: result.preflightRequired === true,
    expiresAt: now(nowMs) + Math.max(0, ttlMs),
  });
}

/**
 * Fold a charge response into the cache. A charge carries no utilization percent,
 * but `alertsFired` means a cap action tripped on this charge — so we keep any prior
 * percent and (re)assert `preflightRequired` to force the next cheap call to preflight.
 */
export function recordChargeResult(
  companyId: string | null | undefined,
  result: Pick<ChargeResult, "alertsFired"> | null | undefined,
  ttlMs: number = DEFAULT_TTL_MS,
  nowMs?: number,
): void {
  if (!companyId || !result) return;
  const fired = Array.isArray(result.alertsFired) && result.alertsFired.length > 0;
  const prior = getBurnHint(companyId, nowMs);
  // Only (re)write when an alert fired; a clean charge should not extend a stale hint.
  if (!fired) return;
  cache.set(companyId, {
    capUsedPercent: prior?.capUsedPercent ?? null,
    preflightRequired: true,
    expiresAt: now(nowMs) + Math.max(0, ttlMs),
  });
}

/** Test/seam helper: clear all cached hints. */
export function __resetBurnHintCacheForTests(): void {
  cache.clear();
}

export const BURN_HINT_DEFAULT_TTL_MS = DEFAULT_TTL_MS;
