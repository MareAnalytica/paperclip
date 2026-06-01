// Account/provider-scoped fallback cooldown — the cross-run circuit breaker
// (ticket ELI-855).
//
// Within-run fallback (heartbeat `scheduleBoundedRetryForRun`) already hops to
// the next provider when one fails inside a retry chain. The gap this closes:
// a *new, unrelated root run* would still start on a Claude account that had
// already reported a session-limit reset window, burning an attempt every time.
//
// This module records each limit reset against (company, provider) and lets the
// scheduler skip providers that are still cooling down when a fresh run starts
// with no provider selected yet. The window self-expires (readers filter on
// `cooldown_until > now`), so an eligible provider simply reappears after reset.
//
// The pure helpers below carry the decision logic and are unit-tested directly;
// the DB functions are thin upsert/read wrappers around them.

import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { providerAccountCooldowns } from "@paperclipai/db";

export type ProviderCooldownSource = "provider_header" | "retryAfterMinutesDefault";

// Structural shape of a fallback chain entry — kept local so this module does
// not depend on heartbeat.ts internals.
export interface CooldownChainEntry {
  id: string;
  adapter: string;
  enabled: boolean;
  // Optional to accept the heartbeat's own fallback-chain entry shape, where
  // `account` is declared optional. Only ever read and passed through here.
  account?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  probe?: unknown;
}

export interface ProviderCooldownRecord {
  providerId: string;
  adapterType: string;
  account: string | null;
  cooldownUntil: Date;
  source: ProviderCooldownSource;
}

/**
 * Decide the cooldown to record for a provider that just failed with a limit
 * error (acceptance #1). When the provider supplied an explicit reset we honour
 * it; otherwise we back off by the configured `retryAfterMinutesDefault`. The
 * computed window is never in the past.
 */
export function computeProviderCooldownRecord(input: {
  providerId: string | null;
  adapterType: string;
  account: string | null;
  failedProviderReset: Date | null;
  now: Date;
  retryAfterMinutesDefault: number;
}): ProviderCooldownRecord | null {
  const providerId = input.providerId?.trim();
  if (!providerId) return null;

  if (input.failedProviderReset && input.failedProviderReset.getTime() > input.now.getTime()) {
    return {
      providerId,
      adapterType: input.adapterType,
      account: input.account,
      cooldownUntil: input.failedProviderReset,
      source: "provider_header",
    };
  }

  const minutes =
    Number.isFinite(input.retryAfterMinutesDefault) && input.retryAfterMinutesDefault > 0
      ? input.retryAfterMinutesDefault
      : 60;
  return {
    providerId,
    adapterType: input.adapterType,
    account: input.account,
    cooldownUntil: new Date(input.now.getTime() + minutes * 60_000),
    source: "retryAfterMinutesDefault",
  };
}

/**
 * Reduce persisted cooldown rows to the set of provider ids still cooling down
 * (acceptance #3 — a provider whose window has elapsed is no longer returned).
 */
export function activeCooledDownProviderIds(
  rows: ReadonlyArray<{ providerId: string; cooldownUntil: Date }>,
  now: Date,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.cooldownUntil.getTime() > now.getTime()) out.add(row.providerId);
  }
  return out;
}

/**
 * Pick the provider a *new root run* should start on, skipping any that are
 * cooling down (acceptance #2).
 *
 * Returns `null` when no override is needed — the run should start on its
 * natural primary (the chain entry matching the agent adapter, else the chain
 * head). Returns a chain entry when the natural primary is cooling down and a
 * healthier provider exists later in the chain. If every enabled provider is
 * cooling down we also return `null`: there is no better choice, so we let the
 * normal path run and the within-run fallback / exhaustion handling take over
 * rather than block the run here.
 */
export function pickRootRunProviderSelection(input: {
  chain: ReadonlyArray<CooldownChainEntry>;
  adapterType: string;
  cooledDownProviderIds: ReadonlySet<string>;
}): CooldownChainEntry | null {
  const enabled = input.chain.filter((entry) => entry.enabled);
  if (enabled.length === 0) return null;

  const primary =
    enabled.find((entry) => entry.adapter === input.adapterType) ?? enabled[0] ?? null;
  if (!primary) return null;

  // Natural primary is healthy → no override.
  if (!input.cooledDownProviderIds.has(primary.id)) return null;

  // Primary is cooling down → first healthy provider at/after the primary's
  // position in chain order.
  const primaryIndex = enabled.findIndex((entry) => entry.id === primary.id);
  for (let i = primaryIndex; i < enabled.length; i++) {
    const entry = enabled[i];
    if (!input.cooledDownProviderIds.has(entry.id)) return entry;
  }
  return null;
}

/**
 * Record (or extend) the cooldown for a provider. The window is only ever
 * pushed later — `GREATEST(...)` keeps any longer existing window so a shorter
 * back-off from a later hop never shortens an honoured provider reset.
 */
export async function upsertProviderAccountCooldown(
  db: Db,
  input: ProviderCooldownRecord & {
    companyId: string;
    reason?: string | null;
    lastRunId?: string | null;
    lastIssueId?: string | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .insert(providerAccountCooldowns)
    .values({
      companyId: input.companyId,
      providerId: input.providerId,
      adapterType: input.adapterType,
      account: input.account ?? null,
      cooldownUntil: input.cooldownUntil,
      source: input.source,
      reason: input.reason ?? null,
      lastRunId: input.lastRunId ?? null,
      lastIssueId: input.lastIssueId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [providerAccountCooldowns.companyId, providerAccountCooldowns.providerId],
      set: {
        cooldownUntil: sql`GREATEST(${providerAccountCooldowns.cooldownUntil}, excluded.cooldown_until)`,
        adapterType: input.adapterType,
        account: input.account ?? null,
        source: input.source,
        reason: input.reason ?? null,
        lastRunId: input.lastRunId ?? null,
        lastIssueId: input.lastIssueId ?? null,
        updatedAt: now,
      },
    });
}

/**
 * Read the set of provider ids currently cooling down for a company. Filters on
 * the DB side so expired rows are never returned.
 */
export async function getActiveProviderCooldownIds(
  db: Db,
  companyId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  const rows = await db
    .select({ providerId: providerAccountCooldowns.providerId })
    .from(providerAccountCooldowns)
    .where(
      and(
        eq(providerAccountCooldowns.companyId, companyId),
        gt(providerAccountCooldowns.cooldownUntil, now),
      ),
    );
  return new Set(rows.map((row) => row.providerId));
}
