// Pure helpers for the provider-fallback chain exhaustion report + back-off
// (spec docs/specs/2026-05-28-provider-fallback-chain.md §3.4 + §4, ticket
// ELI-396). The runtime detects exhaustion in heartbeat's
// `scheduleBoundedRetryForRun`; these helpers shape the §4 report and compute
// the reset back-off without touching any I/O so they are trivially testable.

export type ProviderFallbackResetSource = "provider_header" | "retryAfterMinutesDefault";

export interface ProviderFallbackExhaustedReport {
  kind: "provider_fallback_exhausted";
  agentNameKey: string;
  companyId: string;
  exhaustedProviders: string[];
  nextResetAt: string;
  nextResetSource: ProviderFallbackResetSource;
}

function toValidDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Compute the back-off after the chain is exhausted (§4.3):
 *   nextResetAt   = earliest of the per-provider provider-supplied resets,
 *                   else now + retryAfterMinutesDefault minutes.
 *   nextResetSource = whether that time came from a provider header or default.
 */
export function computeProviderFallbackBackoff(input: {
  perProviderResets: ReadonlyArray<string | number | Date | null | undefined>;
  now: Date;
  retryAfterMinutesDefault: number;
}): { nextResetAt: Date; nextResetSource: ProviderFallbackResetSource } {
  let earliest: Date | null = null;
  for (const raw of input.perProviderResets) {
    const parsed = toValidDate(raw);
    if (!parsed) continue;
    if (!earliest || parsed.getTime() < earliest.getTime()) earliest = parsed;
  }
  if (earliest) {
    return { nextResetAt: earliest, nextResetSource: "provider_header" };
  }
  const minutes =
    Number.isFinite(input.retryAfterMinutesDefault) && input.retryAfterMinutesDefault > 0
      ? input.retryAfterMinutesDefault
      : 60;
  return {
    nextResetAt: new Date(input.now.getTime() + minutes * 60_000),
    nextResetSource: "retryAfterMinutesDefault",
  };
}

export function buildProviderFallbackExhaustedReport(input: {
  agentNameKey: string;
  companyId: string;
  exhaustedProviders: string[];
  nextResetAt: Date;
  nextResetSource: ProviderFallbackResetSource;
}): ProviderFallbackExhaustedReport {
  return {
    kind: "provider_fallback_exhausted",
    agentNameKey: input.agentNameKey,
    companyId: input.companyId,
    exhaustedProviders: [...input.exhaustedProviders],
    nextResetAt: input.nextResetAt.toISOString(),
    nextResetSource: input.nextResetSource,
  };
}

// Render an ISO timestamp to the board one-liner's minute precision, e.g.
// "2026-05-28T14:00:00.000Z" -> "2026-05-28T14:00Z" (spec §4).
function formatMinuteUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z");
}

/**
 * The concise board one-liner of spec §4.
 */
export function renderProviderFallbackExhaustedMarkdown(
  report: ProviderFallbackExhaustedReport,
): string {
  const providers =
    report.exhaustedProviders.length > 0 ? report.exhaustedProviders.join(" → ") : "(none)";
  const sourceLabel = report.nextResetSource === "provider_header" ? "from provider" : "from default";
  return `⚠️ Provider fallback exhausted — agent \`${report.agentNameKey}\` (${report.companyId}). Exhausted: ${providers}. Next reset: ${formatMinuteUtc(report.nextResetAt)} (${sourceLabel}). Work is paused for this agent until reset.`;
}
