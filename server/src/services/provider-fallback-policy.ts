import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { logger } from "../middleware/logger.js";

export const PROVIDER_FALLBACK_ADAPTER_TYPES = [
  "claude_local",
  "codex_local",
  "grok_local",
] as const;

export type ProviderFallbackAdapterType = (typeof PROVIDER_FALLBACK_ADAPTER_TYPES)[number];

// Per-provider authentication model (ELI-867 / ADR-0005). It is an advisory,
// secret-free routing fact — never a credential. The blueprint carries it to the
// runtime as the `PROVIDER_AUTH_MODES` env value (comma-joined `id:mode`, in chain
// order); see the provider-fallback-chain spec §2.1. The runtime uses it to make
// detection precedence auth-model-aware (ELI-901): an oauth-session cap/expiry is
// limit-like and self-clears on reset (hop), whereas a raw-key auth failure is a
// permanent bad-credential error (normal failure path, do not consume the chain).
export const PROVIDER_AUTH_MODES = ["oauth-session", "raw-key"] as const;

export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

// The spec §2.1 default when a provider declares no explicit mode. The eli-board
// blueprint's `DEFAULT_PROVIDER_AUTH_MODES` mirrors this; keeping the default here
// means an absent/partial `PROVIDER_AUTH_MODES` env preserves the prior hop
// behavior (every provider treated as oauth-session) rather than silently changing
// production recovery.
export const DEFAULT_PROVIDER_AUTH_MODE: ProviderAuthMode = "oauth-session";

function isProviderAuthMode(value: unknown): value is ProviderAuthMode {
  return PROVIDER_AUTH_MODES.includes(value as ProviderAuthMode);
}

// Parse the `PROVIDER_AUTH_MODES` env value — a comma-joined list of
// `providerId:authMode` pairs (ELI-867) — into a provider-id → auth-model map.
// Non-string input, blank/malformed pairs, and unrecognised modes are skipped so a
// misconfigured env can never throw on the recovery path; the first valid pair for
// a given id wins.
export function parseProviderAuthModes(value: unknown): Map<string, ProviderAuthMode> {
  const out = new Map<string, ProviderAuthMode>();
  if (typeof value !== "string") return out;
  for (const pair of value.split(",")) {
    const sep = pair.indexOf(":");
    if (sep < 0) continue;
    const id = pair.slice(0, sep).trim();
    const mode = pair.slice(sep + 1).trim();
    if (!id || out.has(id) || !isProviderAuthMode(mode)) continue;
    out.set(id, mode);
  }
  return out;
}

export interface ProviderFallbackEntry {
  id: string;
  adapter: ProviderFallbackAdapterType;
  enabled: boolean;
  account: string | null;
  adapterConfig: Record<string, unknown> | null;
}

export interface ProviderFallbackPolicy {
  chain: ProviderFallbackEntry[];
}

export const PROVIDER_FALLBACK_NOTIFY_KINDS = [
  "comment",
  "wake",
  "approval",
  "digest",
] as const;

export type ProviderFallbackNotifyKind = (typeof PROVIDER_FALLBACK_NOTIFY_KINDS)[number];

export interface ProviderFallbackBoardEscalation {
  enabled: boolean;
  notifyKind: ProviderFallbackNotifyKind;
}

export const PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_MIN = 1;
export const PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_MAX = 1440;
export const PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_DEFAULT = 60;

// ELI-1076 (follow-up to ELI-1075): the dedicated `provider_disabled` cooldown
// window, in minutes. The org/subscription-disabled block is permanent-per-account
// — it self-heals only when an admin re-enables access — so the dead account is
// parked far longer than the transient ~60m back-off to stop a fresh root run
// re-probing + re-parking it every cycle. The default (24h) re-probes the account
// once a day (a bounded "until-cleared" approximation) instead of hourly; the max
// (14 days) bounds the worst-case staleness after access is restored.
export const PROVIDER_FALLBACK_DISABLED_COOLDOWN_MINUTES_MIN = 1;
export const PROVIDER_FALLBACK_DISABLED_COOLDOWN_MINUTES_MAX = 20_160; // 14 days
export const PROVIDER_FALLBACK_DISABLED_COOLDOWN_MINUTES_DEFAULT = 1_440; // 24h

// Spec §2.1 default `limitDetection.limitMarkers` list. These are the engine's
// advisory safety-net markers (ELI-902 / G2): case-insensitive substrings tested
// against an adapter failure message/status *only when* the active adapter
// returned no native limit classification of its own. Native per-adapter
// detection always wins; this list catches limit strings an adapter missed so a
// non-detecting adapter in the chain still hops instead of failing the run.
export const PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS: readonly string[] = [
  "usage limit",
  "rate limit",
  "max reached",
  "quota exceeded",
  "insufficient_quota",
  "429",
  "529",
  "overloaded",
];
const DEFAULT_BOARD_ESCALATION: ProviderFallbackBoardEscalation = {
  enabled: true,
  notifyKind: "approval",
};

export interface ProviderFallbackAccountCooldown {
  // When true (default), a limit error records an account/provider cooldown and
  // new root runs skip providers still cooling down (ticket ELI-855). Set false
  // to fall back to legacy behaviour (every root run starts on the primary).
  enabled: boolean;
  // ELI-1076: the dedicated park window (minutes) for a `provider_disabled`
  // org/subscription-disabled block — a permanent-per-account class that does not
  // self-heal on the transient `retryAfterMinutesDefault` timer. Defaults to 24h.
  providerDisabledCooldownMinutes: number;
}

const DEFAULT_ACCOUNT_COOLDOWN: ProviderFallbackAccountCooldown = {
  enabled: true,
  providerDisabledCooldownMinutes: PROVIDER_FALLBACK_DISABLED_COOLDOWN_MINUTES_DEFAULT,
};

// Provider-health fail-fast + recovery loop-breaker policy (blueprint spec
// `eli-board.provider-health.v1`, ELI-961 / PR #208; runtime enforcement is the
// ELI-947 Contract A–C tree). The block carries only ms durations, counts, and
// public provider-id slugs — no secrets, hosts, or paths — so the posture stays
// portable across clusters. The whole block is OPTIONAL: when omitted the
// disabled default below preserves pre-ELI-961 behavior (no client-side
// deadline, no unresponsive→cooldown coupling, no loop-breaker bound).
export const PROVIDER_HEALTH_INVOCATION_TIMEOUT_MS_MAX = 3_600_000; // ≤ 1h
export const PROVIDER_HEALTH_COOLDOWN_MS_MAX = 86_400_000; // ≤ 24h
export const PROVIDER_HEALTH_MAX_UNRESPONSIVE_RETRIES_MAX = 10;
// Opt-in defaults applied only when the block IS present but a field is omitted
// (spec §2) so a partial block is still safe. `invocationTimeoutMsDefault` has
// NO opt-in default — it must be set explicitly to arm fail-fast.
export const PROVIDER_HEALTH_DEFAULT_COOLDOWN_MS = 300_000; // 5 min
export const PROVIDER_HEALTH_DEFAULT_MAX_UNRESPONSIVE_RETRIES = 2;

// Slug shape for a fallback-chain provider id used as a per-provider key.
const PROVIDER_ID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export interface ProviderHealthPolicy {
  // Global client-side adapter-invocation deadline (ms). `0` ⇒ no deadline.
  invocationTimeoutMsDefault: number;
  // Per-provider deadline override keyed by chain provider id; `0` for a
  // provider ⇒ no deadline for it even when the global default is non-zero.
  perProviderInvocationTimeoutMs: Map<string, number>;
  // Cooldown applied to a (provider, account) on a `provider_unresponsive`
  // demerit, in the SAME store as the ELI-855/856 cross-run breaker. `0` ⇒ the
  // unresponsive→cooldown coupling is disabled (no behavior change).
  cooldownMs: number;
  recovery: {
    // Loop-breaker bound: max consecutive `provider_unresponsive` recoveries for
    // a single (issue, provider) pair before recovery must fail over / escalate
    // instead of re-queuing the same pair. `0` ⇒ bound disabled.
    maxUnresponsiveRetriesPerProvider: number;
  };
}

// The disabled default (spec §2): an omitted block ⇒ pre-ELI-961 behavior.
export function disabledProviderHealthPolicy(): ProviderHealthPolicy {
  return {
    invocationTimeoutMsDefault: 0,
    perProviderInvocationTimeoutMs: new Map(),
    cooldownMs: 0,
    recovery: { maxUnresponsiveRetriesPerProvider: 0 },
  };
}

export interface ResolvedProviderFallbackPolicy {
  schemaVersion: "1";
  default: ProviderFallbackPolicy;
  overrides: Map<string, ProviderFallbackPolicy>;
  // §4 exhaustion handling (spec ELI-382). Company-wide for v1; per-company
  // override of these is a documented follow-up.
  retryAfterMinutesDefault: number;
  // Engine-level safety-net markers (spec §2.1, ELI-902 / G2). Lowercased,
  // de-duplicated; defaults to PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS.
  limitMarkers: string[];
  boardEscalation: ProviderFallbackBoardEscalation;
  // Account/provider cooldown for new root runs (ticket ELI-855).
  accountCooldown: ProviderFallbackAccountCooldown;
  // Provider-health fail-fast + recovery loop-breaker (spec
  // `eli-board.provider-health.v1`, ELI-961 / ELI-947 Contracts A–C).
  providerHealth: ProviderHealthPolicy;
}

export interface ProviderFallbackLoadOptions {
  env?: NodeJS.ProcessEnv;
  strictEnv?: boolean;
  onWarn?: (message: string) => void;
}

const BUILTIN_DEFAULT_CHAIN: ProviderFallbackEntry[] = [
  {
    id: "claude-code-personal",
    adapter: "claude_local",
    enabled: true,
    account: "personal",
    adapterConfig: null,
  },
  {
    id: "claude-code-aflabox",
    adapter: "claude_local",
    enabled: true,
    account: "aflabox",
    adapterConfig: null,
  },
  {
    id: "codex-local",
    adapter: "codex_local",
    enabled: true,
    account: null,
    adapterConfig: null,
  },
  {
    id: "grok-local",
    adapter: "grok_local",
    enabled: true,
    account: null,
    adapterConfig: null,
  },
];

const PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const UNRESOLVED = Symbol("unresolved-placeholder");

function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  strictEnv: boolean,
  onWarn: (message: string) => void,
  context: string,
): string | typeof UNRESOLVED {
  let unresolved = false;
  const out = value.replace(PLACEHOLDER, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      if (strictEnv) {
        throw new Error(
          `[provider-fallback-policy] env var \${${name}} is required at ${context} but is not set`,
        );
      }
      onWarn(
        `[provider-fallback-policy] env var \${${name}} not set; skipping ${context}`,
      );
      unresolved = true;
      return "";
    }
    return v;
  });
  return unresolved ? UNRESOLVED : out;
}

function substituteDeep<T>(
  value: T,
  env: NodeJS.ProcessEnv,
  strictEnv: boolean,
  onWarn: (message: string) => void,
  context: string,
): T | typeof UNRESOLVED {
  if (typeof value === "string") {
    return substituteString(value, env, strictEnv, onWarn, context) as T | typeof UNRESOLVED;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      const r = substituteDeep(value[i], env, strictEnv, onWarn, `${context}[${i}]`);
      if (r === UNRESOLVED) return UNRESOLVED;
      out.push(r);
    }
    return out as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = substituteDeep(v, env, strictEnv, onWarn, `${context}.${k}`);
      if (r === UNRESOLVED) return UNRESOLVED;
      out[k] = r;
    }
    return out as unknown as T;
  }
  return value;
}

function isAdapterType(value: unknown): value is ProviderFallbackAdapterType {
  return PROVIDER_FALLBACK_ADAPTER_TYPES.includes(value as ProviderFallbackAdapterType);
}

function normalizeAdapterType(value: unknown): ProviderFallbackAdapterType | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  if (isAdapterType(lower)) return lower;
  const dashed = lower.replace(/_/g, "-");
  switch (dashed) {
    case "claude-code":
    case "anthropic-claude-code":
      return "claude_local";
    case "codex":
    case "openai-codex-local":
      return "codex_local";
    case "grok":
    case "xai-grok-local":
      return "grok_local";
    default:
      return null;
  }
}

function assertEntry(value: unknown, ctx: string): ProviderFallbackEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`[provider-fallback-policy] ${ctx} must be an object`);
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim().length === 0) {
    throw new Error(`[provider-fallback-policy] ${ctx}.id must be a non-empty string`);
  }
  const adapter = normalizeAdapterType(o.adapter);
  if (!adapter) {
    throw new Error(
      `[provider-fallback-policy] ${ctx}.adapter must be one of ${PROVIDER_FALLBACK_ADAPTER_TYPES.join("|")}`,
    );
  }
  const enabled = o.enabled === undefined ? true : Boolean(o.enabled);
  let account: string | null = null;
  if (o.account !== undefined && o.account !== null) {
    if (typeof o.account !== "string") {
      throw new Error(`[provider-fallback-policy] ${ctx}.account must be a string or null`);
    }
    const trimmed = o.account.trim();
    account = trimmed.length > 0 ? trimmed : null;
  }
  let adapterConfig: Record<string, unknown> | null = null;
  if (o.adapterConfig !== undefined && o.adapterConfig !== null) {
    if (typeof o.adapterConfig !== "object" || Array.isArray(o.adapterConfig)) {
      throw new Error(
        `[provider-fallback-policy] ${ctx}.adapterConfig must be an object or null`,
      );
    }
    adapterConfig = o.adapterConfig as Record<string, unknown>;
  }
  return { id: o.id.trim(), adapter, enabled, account, adapterConfig };
}

function assertChain(value: unknown, ctx: string): ProviderFallbackEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`[provider-fallback-policy] ${ctx} must be an array`);
  }
  const seen = new Set<string>();
  const out: ProviderFallbackEntry[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = assertEntry(value[i], `${ctx}[${i}]`);
    if (seen.has(entry.id)) {
      throw new Error(`[provider-fallback-policy] duplicate entry id ${entry.id} in ${ctx}`);
    }
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

function parseRetryAfterMinutes(limitDetection: unknown): number {
  if (limitDetection === undefined || limitDetection === null) {
    return PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_DEFAULT;
  }
  if (typeof limitDetection !== "object" || Array.isArray(limitDetection)) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.limitDetection must be an object",
    );
  }
  const raw = (limitDetection as Record<string, unknown>).retryAfterMinutesDefault;
  if (raw === undefined || raw === null) {
    return PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_DEFAULT;
  }
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_MIN ||
    raw > PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_MAX
  ) {
    throw new Error(
      `[provider-fallback-policy] providerFallback.limitDetection.retryAfterMinutesDefault must be an integer in [${PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_MIN}, ${PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_MAX}]`,
    );
  }
  return raw;
}

function parseLimitMarkers(limitDetection: unknown): string[] {
  if (limitDetection === undefined || limitDetection === null) {
    return [...PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS];
  }
  if (typeof limitDetection !== "object" || Array.isArray(limitDetection)) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.limitDetection must be an object",
    );
  }
  const raw = (limitDetection as Record<string, unknown>).limitMarkers;
  if (raw === undefined || raw === null) {
    return [...PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS];
  }
  if (!Array.isArray(raw)) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.limitDetection.limitMarkers must be an array of non-empty strings",
    );
  }
  const markers: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(
        "[provider-fallback-policy] providerFallback.limitDetection.limitMarkers must be an array of non-empty strings",
      );
    }
    const normalized = item.trim().toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    markers.push(normalized);
  }
  if (markers.length === 0) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.limitDetection.limitMarkers must contain at least one non-empty marker",
    );
  }
  return markers;
}

function parseBoardEscalation(boardEscalation: unknown): ProviderFallbackBoardEscalation {
  if (boardEscalation === undefined || boardEscalation === null) {
    return { ...DEFAULT_BOARD_ESCALATION };
  }
  if (typeof boardEscalation !== "object" || Array.isArray(boardEscalation)) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.boardEscalation must be an object",
    );
  }
  const o = boardEscalation as Record<string, unknown>;
  const enabled = o.enabled === undefined ? DEFAULT_BOARD_ESCALATION.enabled : Boolean(o.enabled);
  let notifyKind = DEFAULT_BOARD_ESCALATION.notifyKind;
  if (o.notifyKind !== undefined && o.notifyKind !== null) {
    if (
      typeof o.notifyKind !== "string" ||
      !PROVIDER_FALLBACK_NOTIFY_KINDS.includes(o.notifyKind as ProviderFallbackNotifyKind)
    ) {
      throw new Error(
        `[provider-fallback-policy] providerFallback.boardEscalation.notifyKind must be one of ${PROVIDER_FALLBACK_NOTIFY_KINDS.join("|")}`,
      );
    }
    notifyKind = o.notifyKind as ProviderFallbackNotifyKind;
  }
  return { enabled, notifyKind };
}

function parseAccountCooldown(accountCooldown: unknown): ProviderFallbackAccountCooldown {
  if (accountCooldown === undefined || accountCooldown === null) {
    return { ...DEFAULT_ACCOUNT_COOLDOWN };
  }
  if (typeof accountCooldown !== "object" || Array.isArray(accountCooldown)) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.accountCooldown must be an object",
    );
  }
  const o = accountCooldown as Record<string, unknown>;
  const enabled = o.enabled === undefined ? DEFAULT_ACCOUNT_COOLDOWN.enabled : Boolean(o.enabled);
  const providerDisabledCooldownMinutes = parseBoundedInteger(
    o.providerDisabledCooldownMinutes,
    PROVIDER_FALLBACK_DISABLED_COOLDOWN_MINUTES_MIN,
    PROVIDER_FALLBACK_DISABLED_COOLDOWN_MINUTES_MAX,
    DEFAULT_ACCOUNT_COOLDOWN.providerDisabledCooldownMinutes,
    "providerFallback.accountCooldown.providerDisabledCooldownMinutes",
  );
  return { enabled, providerDisabledCooldownMinutes };
}

// Validate an optional bounded integer field. `undefined`/`null` ⇒ `fallback`.
function parseBoundedInteger(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
  ctx: string,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new Error(
      `[provider-fallback-policy] ${ctx} must be an integer in [${min}, ${max}]`,
    );
  }
  return raw;
}

// Parse `providerFallback.providerHealth` (spec §2 / §6). Omitted ⇒ the disabled
// default. Present-but-partial ⇒ conservative opt-in defaults per spec §2.
function parseProviderHealth(providerHealth: unknown): ProviderHealthPolicy {
  if (providerHealth === undefined || providerHealth === null) {
    return disabledProviderHealthPolicy();
  }
  if (typeof providerHealth !== "object" || Array.isArray(providerHealth)) {
    throw new Error(
      "[provider-fallback-policy] providerFallback.providerHealth must be an object",
    );
  }
  const o = providerHealth as Record<string, unknown>;

  // No opt-in default: leaving this 0 keeps fail-fast off even with the block
  // present (spec §2).
  const invocationTimeoutMsDefault = parseBoundedInteger(
    o.invocationTimeoutMsDefault,
    0,
    PROVIDER_HEALTH_INVOCATION_TIMEOUT_MS_MAX,
    0,
    "providerFallback.providerHealth.invocationTimeoutMsDefault",
  );

  const perProviderInvocationTimeoutMs = new Map<string, number>();
  const rawPerProvider = o.perProviderInvocationTimeoutMs;
  if (rawPerProvider !== undefined && rawPerProvider !== null) {
    if (typeof rawPerProvider !== "object" || Array.isArray(rawPerProvider)) {
      throw new Error(
        "[provider-fallback-policy] providerFallback.providerHealth.perProviderInvocationTimeoutMs must be an object",
      );
    }
    for (const [id, value] of Object.entries(rawPerProvider as Record<string, unknown>)) {
      if (!PROVIDER_ID_SLUG.test(id)) {
        throw new Error(
          `[provider-fallback-policy] providerFallback.providerHealth.perProviderInvocationTimeoutMs key "${id}" must be a provider-id slug`,
        );
      }
      perProviderInvocationTimeoutMs.set(
        id,
        parseBoundedInteger(
          value,
          0,
          PROVIDER_HEALTH_INVOCATION_TIMEOUT_MS_MAX,
          0,
          `providerFallback.providerHealth.perProviderInvocationTimeoutMs.${id}`,
        ),
      );
    }
  }

  const cooldownMs = parseBoundedInteger(
    o.cooldownMs,
    0,
    PROVIDER_HEALTH_COOLDOWN_MS_MAX,
    PROVIDER_HEALTH_DEFAULT_COOLDOWN_MS,
    "providerFallback.providerHealth.cooldownMs",
  );

  let maxUnresponsiveRetriesPerProvider = PROVIDER_HEALTH_DEFAULT_MAX_UNRESPONSIVE_RETRIES;
  const rawRecovery = o.recovery;
  if (rawRecovery !== undefined && rawRecovery !== null) {
    if (typeof rawRecovery !== "object" || Array.isArray(rawRecovery)) {
      throw new Error(
        "[provider-fallback-policy] providerFallback.providerHealth.recovery must be an object",
      );
    }
    maxUnresponsiveRetriesPerProvider = parseBoundedInteger(
      (rawRecovery as Record<string, unknown>).maxUnresponsiveRetriesPerProvider,
      0,
      PROVIDER_HEALTH_MAX_UNRESPONSIVE_RETRIES_MAX,
      PROVIDER_HEALTH_DEFAULT_MAX_UNRESPONSIVE_RETRIES,
      "providerFallback.providerHealth.recovery.maxUnresponsiveRetriesPerProvider",
    );
  }

  return {
    invocationTimeoutMsDefault,
    perProviderInvocationTimeoutMs,
    cooldownMs,
    recovery: { maxUnresponsiveRetriesPerProvider },
  };
}

export function parseProviderFallbackPolicy(
  raw: unknown,
  options: ProviderFallbackLoadOptions = {},
): ResolvedProviderFallbackPolicy {
  const env = options.env ?? process.env;
  const strictEnv = options.strictEnv ?? false;
  const onWarn = options.onWarn ?? ((m) => logger.warn(m));

  if (!raw || typeof raw !== "object") {
    throw new Error("[provider-fallback-policy] file must contain a YAML mapping");
  }
  const file = raw as Record<string, unknown>;
  if (file.schemaVersion !== "1") {
    throw new Error(
      `[provider-fallback-policy] unsupported schemaVersion ${String(file.schemaVersion)} (expected "1")`,
    );
  }
  const block = file.providerFallback as Record<string, unknown> | undefined;
  if (!block || typeof block !== "object") {
    throw new Error("[provider-fallback-policy] providerFallback block is required");
  }
  const defaultBlock = block.default;
  if (!defaultBlock || typeof defaultBlock !== "object" || Array.isArray(defaultBlock)) {
    throw new Error("[provider-fallback-policy] providerFallback.default must be an object");
  }
  const defaultChain = assertChain(
    (defaultBlock as Record<string, unknown>).chain,
    "providerFallback.default.chain",
  );

  const overrides = new Map<string, ProviderFallbackPolicy>();
  const rawOverrides = (block.overrides ?? []) as unknown;
  if (!Array.isArray(rawOverrides)) {
    throw new Error("[provider-fallback-policy] providerFallback.overrides must be an array");
  }
  for (let i = 0; i < rawOverrides.length; i++) {
    const ctx = `providerFallback.overrides[${i}]`;
    const resolved = substituteDeep(rawOverrides[i], env, strictEnv, onWarn, ctx);
    if (resolved === UNRESOLVED) continue;
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      throw new Error(`[provider-fallback-policy] ${ctx} must be an object`);
    }
    const o = resolved as Record<string, unknown>;
    if (typeof o.companyId !== "string" || o.companyId.length === 0) {
      throw new Error(`[provider-fallback-policy] ${ctx}.companyId is required`);
    }
    if (overrides.has(o.companyId)) {
      throw new Error(
        `[provider-fallback-policy] duplicate override for companyId ${o.companyId}`,
      );
    }
    const chain = assertChain(o.chain, `${ctx}.chain`);
    overrides.set(o.companyId, { chain });
  }

  return {
    schemaVersion: "1",
    default: { chain: defaultChain },
    overrides,
    retryAfterMinutesDefault: parseRetryAfterMinutes(block.limitDetection),
    limitMarkers: parseLimitMarkers(block.limitDetection),
    boardEscalation: parseBoardEscalation(block.boardEscalation),
    accountCooldown: parseAccountCooldown(block.accountCooldown),
    providerHealth: parseProviderHealth(block.providerHealth),
  };
}

export function loadProviderFallbackPolicyFromString(
  yamlText: string,
  options: ProviderFallbackLoadOptions = {},
): ResolvedProviderFallbackPolicy {
  const parsed = parseYaml(yamlText);
  return parseProviderFallbackPolicy(parsed, options);
}

export function loadProviderFallbackPolicy(
  path: string,
  options: ProviderFallbackLoadOptions = {},
): ResolvedProviderFallbackPolicy {
  const text = readFileSync(path, "utf8");
  return loadProviderFallbackPolicyFromString(text, options);
}

export function builtinDefaultProviderFallbackPolicy(): ResolvedProviderFallbackPolicy {
  return {
    schemaVersion: "1",
    default: { chain: BUILTIN_DEFAULT_CHAIN.map((entry) => ({ ...entry })) },
    overrides: new Map(),
    retryAfterMinutesDefault: PROVIDER_FALLBACK_RETRY_AFTER_MINUTES_DEFAULT,
    limitMarkers: [...PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS],
    boardEscalation: { ...DEFAULT_BOARD_ESCALATION },
    accountCooldown: { ...DEFAULT_ACCOUNT_COOLDOWN },
    providerHealth: disabledProviderHealthPolicy(),
  };
}

/**
 * Resolve the §4 exhaustion escalation config for a company. Company-wide for
 * v1 (per-company override of retry/board settings is a follow-up); `companyId`
 * is accepted now so callers do not change when overrides land.
 */
export function resolveProviderFallbackEscalation(
  companyId: string,
  resolved: ResolvedProviderFallbackPolicy = getProviderFallbackPolicy(),
): { retryAfterMinutesDefault: number; boardEscalation: ProviderFallbackBoardEscalation } {
  void companyId;
  return {
    retryAfterMinutesDefault: resolved.retryAfterMinutesDefault,
    boardEscalation: { ...resolved.boardEscalation },
  };
}

/**
 * Resolve the engine-level safety-net `limitMarkers` for a company (ELI-902 /
 * G2). Company-wide for v1; `companyId` is accepted now so callers do not change
 * when per-company overrides land.
 */
export function resolveProviderFallbackLimitMarkers(
  companyId: string,
  resolved: ResolvedProviderFallbackPolicy = getProviderFallbackPolicy(),
): string[] {
  void companyId;
  return [...resolved.limitMarkers];
}

/**
 * Engine-level safety-net classifier (ELI-902 / G2). Returns true when the
 * lowercased failure text contains any configured `limitMarker`. This is layered
 * *under* each adapter's native limit detection: callers consult it only when the
 * active adapter produced no native usage-limit classification of its own.
 */
export function matchesConfiguredLimitMarker(
  failureText: string,
  markers: readonly string[],
): boolean {
  if (!failureText || markers.length === 0) return false;
  const haystack = failureText.toLowerCase();
  return markers.some((marker) => haystack.includes(marker));
}

/**
 * Resolve the account/provider cooldown config for a company (ticket ELI-855).
 * Company-wide for v1; `companyId` is accepted now so callers do not change
 * when per-company overrides land.
 */
export function resolveProviderFallbackAccountCooldown(
  companyId: string,
  resolved: ResolvedProviderFallbackPolicy = getProviderFallbackPolicy(),
): ProviderFallbackAccountCooldown {
  void companyId;
  return { ...resolved.accountCooldown };
}

/**
 * Resolve the provider-health policy for a company (spec
 * `eli-board.provider-health.v1`). Company-wide for v1; `companyId` is accepted
 * now so callers do not change when per-company overrides land. Returns a deep
 * copy so callers never mutate the shared registry value.
 */
export function resolveProviderHealthPolicy(
  companyId: string,
  resolved: ResolvedProviderFallbackPolicy = getProviderFallbackPolicy(),
): ProviderHealthPolicy {
  void companyId;
  const ph = resolved.providerHealth;
  return {
    invocationTimeoutMsDefault: ph.invocationTimeoutMsDefault,
    perProviderInvocationTimeoutMs: new Map(ph.perProviderInvocationTimeoutMs),
    cooldownMs: ph.cooldownMs,
    recovery: { ...ph.recovery },
  };
}

/**
 * Resolve the client-side invocation deadline (ms) for a provider (spec §5):
 * the per-provider override else the global default. `0` ⇒ no deadline.
 */
export function resolveInvocationTimeoutMs(
  providerId: string | null | undefined,
  health: ProviderHealthPolicy,
): number {
  const id = providerId?.trim();
  if (id) {
    const override = health.perProviderInvocationTimeoutMs.get(id);
    if (override !== undefined) return override;
  }
  return health.invocationTimeoutMsDefault;
}

export function policyForCompany(
  resolved: ResolvedProviderFallbackPolicy,
  companyId: string,
): ProviderFallbackPolicy {
  return resolved.overrides.get(companyId) ?? resolved.default;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableSerialize(v)}`);
  return `{${entries.join(",")}}`;
}

export function computePolicyHash(policy: ProviderFallbackPolicy): string {
  return createHash("sha256").update(stableSerialize(policy)).digest("hex");
}

const REGISTRY_KEY = Symbol.for("paperclipai.server.providerFallbackPolicyRegistry");

interface Registry {
  resolved: ResolvedProviderFallbackPolicy;
  path: string | null;
  loadedAt: Date;
  sighupListenerInstalled: boolean;
}

function getGlobalRegistry(): { [REGISTRY_KEY]?: Registry } {
  return globalThis as unknown as { [REGISTRY_KEY]?: Registry };
}

function loadFromEnv(
  env: NodeJS.ProcessEnv,
): { resolved: ResolvedProviderFallbackPolicy; path: string | null } {
  const path = env.ELI_PROVIDER_FALLBACK_POLICY_PATH?.trim() || null;
  if (!path) {
    return { resolved: builtinDefaultProviderFallbackPolicy(), path: null };
  }
  try {
    const resolved = loadProviderFallbackPolicy(path, {
      env,
      onWarn: (m) => logger.warn(m),
    });
    return { resolved, path };
  } catch (err) {
    logger.error(
      { err, policyPath: path },
      "[provider-fallback-policy] failed to load policy file; falling back to built-in defaults",
    );
    return { resolved: builtinDefaultProviderFallbackPolicy(), path };
  }
}

export function initProviderFallbackPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderFallbackPolicy {
  const registryHost = getGlobalRegistry();
  const { resolved, path } = loadFromEnv(env);
  const existing = registryHost[REGISTRY_KEY];
  const sighupListenerInstalled = existing?.sighupListenerInstalled ?? false;
  registryHost[REGISTRY_KEY] = {
    resolved,
    path,
    loadedAt: new Date(),
    sighupListenerInstalled,
  };
  if (!sighupListenerInstalled && typeof process.on === "function") {
    process.on("SIGHUP", () => {
      try {
        reloadProviderFallbackPolicy(env);
      } catch (err) {
        logger.error({ err }, "[provider-fallback-policy] SIGHUP reload failed");
      }
    });
    registryHost[REGISTRY_KEY]!.sighupListenerInstalled = true;
  }
  logger.info(
    {
      providerFallbackPolicyPath: path,
      providerFallbackPolicyHash: computePolicyHash(resolved.default),
      providerFallbackOverrides: resolved.overrides.size,
      providerFallbackDefaultChainLength: resolved.default.chain.length,
    },
    path
      ? "[provider-fallback-policy] loaded policy from file"
      : "[provider-fallback-policy] ELI_PROVIDER_FALLBACK_POLICY_PATH unset; using built-in defaults",
  );
  return resolved;
}

export function reloadProviderFallbackPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviderFallbackPolicy {
  const registryHost = getGlobalRegistry();
  const { resolved, path } = loadFromEnv(env);
  const existing = registryHost[REGISTRY_KEY];
  registryHost[REGISTRY_KEY] = {
    resolved,
    path,
    loadedAt: new Date(),
    sighupListenerInstalled: existing?.sighupListenerInstalled ?? false,
  };
  logger.info(
    {
      providerFallbackPolicyPath: path,
      providerFallbackPolicyHash: computePolicyHash(resolved.default),
      providerFallbackOverrides: resolved.overrides.size,
    },
    "[provider-fallback-policy] reloaded policy",
  );
  return resolved;
}

export function getProviderFallbackPolicy(): ResolvedProviderFallbackPolicy {
  const registryHost = getGlobalRegistry();
  const existing = registryHost[REGISTRY_KEY];
  if (existing) return existing.resolved;
  return initProviderFallbackPolicy();
}

export function __setProviderFallbackPolicyForTests(
  resolved: ResolvedProviderFallbackPolicy,
): () => void {
  const registryHost = getGlobalRegistry();
  const previous = registryHost[REGISTRY_KEY];
  registryHost[REGISTRY_KEY] = {
    resolved,
    path: null,
    loadedAt: new Date(),
    sighupListenerInstalled: previous?.sighupListenerInstalled ?? false,
  };
  return () => {
    if (previous) {
      registryHost[REGISTRY_KEY] = previous;
    } else {
      delete registryHost[REGISTRY_KEY];
    }
  };
}

/**
 * Pick the next eligible chain entry to use after the current entry has
 * failed in a fallback-eligible way. If `currentId` is null, picks the first
 * enabled entry whose adapter does not match `currentAdapterType` (rotation
 * starts after the agent's primary adapter). Returns null when the chain is
 * exhausted.
 */
export function selectNextProviderFallbackEntry(input: {
  chain: ProviderFallbackEntry[];
  currentId: string | null;
  currentAdapterType: string;
}): ProviderFallbackEntry | null {
  const enabled = input.chain.filter((entry) => entry.enabled);
  if (enabled.length === 0) return null;
  if (input.currentId) {
    const idx = enabled.findIndex((entry) => entry.id === input.currentId);
    if (idx >= 0) return enabled[idx + 1] ?? null;
    return enabled[0] ?? null;
  }
  // No prior fallback selection: pick the first entry whose id/account doesn't
  // already match the agent's primary adapter, otherwise start from index 1.
  const primaryIdx = enabled.findIndex((entry) => entry.adapter === input.currentAdapterType);
  if (primaryIdx < 0) return enabled[0] ?? null;
  return enabled[primaryIdx + 1] ?? null;
}

/**
 * Build the runtimeConfig.providerFallback block to seed onto a new agent so
 * the per-agent default chain matches the resolved company default unless the
 * caller already supplied one.
 */
export function buildDefaultRuntimeConfigBlock(
  companyId: string,
  resolved: ResolvedProviderFallbackPolicy = getProviderFallbackPolicy(),
): { chain: ProviderFallbackEntry[] } {
  const effective = policyForCompany(resolved, companyId);
  return { chain: effective.chain.map((entry) => ({ ...entry })) };
}
