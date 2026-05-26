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

export interface ResolvedProviderFallbackPolicy {
  schemaVersion: "1";
  default: ProviderFallbackPolicy;
  overrides: Map<string, ProviderFallbackPolicy>;
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

  return { schemaVersion: "1", default: { chain: defaultChain }, overrides };
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
  };
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
