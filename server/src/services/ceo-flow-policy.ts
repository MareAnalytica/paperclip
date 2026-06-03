import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import { logger } from "../middleware/logger.js";

export const CEO_HEARTBEAT_MIN_SEC = 60;
export const CEO_HEARTBEAT_MAX_SEC = 3600;

export const AUDITABLE_STATUSES = ["backlog", "blocked", "done", "cancelled"] as const;
export type AuditableStatus = (typeof AUDITABLE_STATUSES)[number];

export interface CeoFlowChecks {
  assignUnassignedActive: boolean;
  wakeStaleAssignees: boolean;
  auditMisclassified: AuditableStatus[];
  misclassifyWindowSec: number;
}

export interface CeoFlowGuards {
  respectApprovalGates: boolean;
  respectCooldowns: boolean;
  respectBudgets: boolean;
  noDuplicateActiveRuns: boolean;
}

export interface CeoFlowPolicy {
  enabled: boolean;
  heartbeatSec: number;
  flowChecks: CeoFlowChecks;
  guards: CeoFlowGuards;
  auditMaxIssuesPerHeartbeat: number;
  promptInsertKey: string;
}

export interface ResolvedCeoFlowPolicy {
  schemaVersion: "1";
  default: CeoFlowPolicy;
  overrides: Map<string, CeoFlowPolicy>;
}

export type EffectivePolicySource = "default" | "override";

export interface EffectivePolicyResponse {
  companyId: string;
  source: EffectivePolicySource;
  /** SHA-256 hex hash of the resolved policy fields. Stable across runs for the same config. */
  policyHash: string;
  policy: CeoFlowPolicy;
}

export interface CeoFlowLoadOptions {
  env?: NodeJS.ProcessEnv;
  strictEnv?: boolean;
  onWarn?: (message: string) => void;
}

const DEFAULT_POLICY: CeoFlowPolicy = {
  enabled: true,
  heartbeatSec: 300,
  flowChecks: {
    assignUnassignedActive: true,
    wakeStaleAssignees: true,
    auditMisclassified: ["backlog", "blocked", "done", "cancelled"],
    misclassifyWindowSec: 86400,
  },
  guards: {
    respectApprovalGates: true,
    respectCooldowns: true,
    respectBudgets: true,
    noDuplicateActiveRuns: true,
  },
  auditMaxIssuesPerHeartbeat: 50,
  promptInsertKey: "ceo-flow-ownership-v1",
};

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
          `[ceo-flow-policy] env var \${${name}} is required at ${context} but is not set`,
        );
      }
      onWarn(`[ceo-flow-policy] env var \${${name}} not set; skipping ${context}`);
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

function assertBool(value: unknown, ctx: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`[ceo-flow-policy] ${ctx} must be a boolean`);
  }
  return value;
}

function assertPositiveInt(value: unknown, ctx: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`[ceo-flow-policy] ${ctx} must be a positive integer`);
  }
  return value;
}

function assertHeartbeatSec(value: unknown, ctx: string): number {
  const n = assertPositiveInt(value, ctx);
  if (n < CEO_HEARTBEAT_MIN_SEC || n > CEO_HEARTBEAT_MAX_SEC) {
    throw new Error(
      `[ceo-flow-policy] ${ctx} must be in [${CEO_HEARTBEAT_MIN_SEC}, ${CEO_HEARTBEAT_MAX_SEC}] seconds`,
    );
  }
  return n;
}

function assertAuditableStatuses(value: unknown, ctx: string): AuditableStatus[] {
  if (!Array.isArray(value)) {
    throw new Error(`[ceo-flow-policy] ${ctx} must be an array`);
  }
  const allowed = new Set<string>(AUDITABLE_STATUSES);
  const seen = new Set<string>();
  const out: AuditableStatus[] = [];
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "string" || !allowed.has(v)) {
      throw new Error(
        `[ceo-flow-policy] ${ctx}[${i}] must be one of ${AUDITABLE_STATUSES.join("|")}`,
      );
    }
    if (seen.has(v)) {
      throw new Error(`[ceo-flow-policy] ${ctx} contains duplicate value ${v}`);
    }
    seen.add(v);
    out.push(v as AuditableStatus);
  }
  return out;
}

function assertFlowChecks(value: unknown, ctx: string): CeoFlowChecks {
  if (!value || typeof value !== "object") {
    throw new Error(`[ceo-flow-policy] ${ctx} must be an object`);
  }
  const o = value as Record<string, unknown>;
  return {
    assignUnassignedActive: assertBool(o.assignUnassignedActive, `${ctx}.assignUnassignedActive`),
    wakeStaleAssignees: assertBool(o.wakeStaleAssignees, `${ctx}.wakeStaleAssignees`),
    auditMisclassified: assertAuditableStatuses(o.auditMisclassified, `${ctx}.auditMisclassified`),
    misclassifyWindowSec: assertPositiveInt(o.misclassifyWindowSec, `${ctx}.misclassifyWindowSec`),
  };
}

function assertGuards(value: unknown, ctx: string): CeoFlowGuards {
  if (!value || typeof value !== "object") {
    throw new Error(`[ceo-flow-policy] ${ctx} must be an object`);
  }
  const o = value as Record<string, unknown>;
  return {
    respectApprovalGates: assertBool(o.respectApprovalGates, `${ctx}.respectApprovalGates`),
    respectCooldowns: assertBool(o.respectCooldowns, `${ctx}.respectCooldowns`),
    respectBudgets: assertBool(o.respectBudgets, `${ctx}.respectBudgets`),
    noDuplicateActiveRuns: assertBool(o.noDuplicateActiveRuns, `${ctx}.noDuplicateActiveRuns`),
  };
}

function assertDefaultPolicy(value: unknown): CeoFlowPolicy {
  if (!value || typeof value !== "object") {
    throw new Error("[ceo-flow-policy] ceoFlow.default must be an object");
  }
  const o = value as Record<string, unknown>;
  const promptInsertKey = o.promptInsertKey;
  if (typeof promptInsertKey !== "string" || promptInsertKey.length === 0) {
    throw new Error("[ceo-flow-policy] ceoFlow.default.promptInsertKey must be a non-empty string");
  }
  return {
    enabled: assertBool(o.enabled, "ceoFlow.default.enabled"),
    heartbeatSec: assertHeartbeatSec(o.heartbeatSec, "ceoFlow.default.heartbeatSec"),
    flowChecks: assertFlowChecks(o.flowChecks, "ceoFlow.default.flowChecks"),
    guards: assertGuards(o.guards, "ceoFlow.default.guards"),
    auditMaxIssuesPerHeartbeat: assertPositiveInt(
      o.auditMaxIssuesPerHeartbeat,
      "ceoFlow.default.auditMaxIssuesPerHeartbeat",
    ),
    promptInsertKey,
  };
}

interface CeoFlowOverride {
  companyId: string;
  enabled?: boolean;
  heartbeatSec?: number;
  flowChecks?: Partial<CeoFlowChecks>;
  guards?: Partial<CeoFlowGuards>;
  auditMaxIssuesPerHeartbeat?: number;
  promptInsertKey?: string;
}

function assertOverrideShape(value: unknown, ctx: string): CeoFlowOverride {
  if (!value || typeof value !== "object") {
    throw new Error(`[ceo-flow-policy] ${ctx} must be an object`);
  }
  const o = value as Record<string, unknown>;
  if (typeof o.companyId !== "string" || o.companyId.length === 0) {
    throw new Error(`[ceo-flow-policy] ${ctx}.companyId is required`);
  }
  const out: CeoFlowOverride = { companyId: o.companyId };
  if (o.enabled !== undefined) out.enabled = assertBool(o.enabled, `${ctx}.enabled`);
  if (o.heartbeatSec !== undefined) {
    out.heartbeatSec = assertHeartbeatSec(o.heartbeatSec, `${ctx}.heartbeatSec`);
  }
  if (o.auditMaxIssuesPerHeartbeat !== undefined) {
    out.auditMaxIssuesPerHeartbeat = assertPositiveInt(
      o.auditMaxIssuesPerHeartbeat,
      `${ctx}.auditMaxIssuesPerHeartbeat`,
    );
  }
  if (o.promptInsertKey !== undefined) {
    if (typeof o.promptInsertKey !== "string" || o.promptInsertKey.length === 0) {
      throw new Error(`[ceo-flow-policy] ${ctx}.promptInsertKey must be a non-empty string`);
    }
    out.promptInsertKey = o.promptInsertKey;
  }
  if (o.flowChecks !== undefined) {
    const fc = o.flowChecks as Record<string, unknown>;
    if (!fc || typeof fc !== "object") {
      throw new Error(`[ceo-flow-policy] ${ctx}.flowChecks must be an object`);
    }
    const partial: Partial<CeoFlowChecks> = {};
    if (fc.assignUnassignedActive !== undefined) {
      partial.assignUnassignedActive = assertBool(
        fc.assignUnassignedActive,
        `${ctx}.flowChecks.assignUnassignedActive`,
      );
    }
    if (fc.wakeStaleAssignees !== undefined) {
      partial.wakeStaleAssignees = assertBool(
        fc.wakeStaleAssignees,
        `${ctx}.flowChecks.wakeStaleAssignees`,
      );
    }
    if (fc.auditMisclassified !== undefined) {
      partial.auditMisclassified = assertAuditableStatuses(
        fc.auditMisclassified,
        `${ctx}.flowChecks.auditMisclassified`,
      );
    }
    if (fc.misclassifyWindowSec !== undefined) {
      partial.misclassifyWindowSec = assertPositiveInt(
        fc.misclassifyWindowSec,
        `${ctx}.flowChecks.misclassifyWindowSec`,
      );
    }
    out.flowChecks = partial;
  }
  if (o.guards !== undefined) {
    const g = o.guards as Record<string, unknown>;
    if (!g || typeof g !== "object") {
      throw new Error(`[ceo-flow-policy] ${ctx}.guards must be an object`);
    }
    const partial: Partial<CeoFlowGuards> = {};
    if (g.respectApprovalGates !== undefined) {
      partial.respectApprovalGates = assertBool(
        g.respectApprovalGates,
        `${ctx}.guards.respectApprovalGates`,
      );
    }
    if (g.respectCooldowns !== undefined) {
      partial.respectCooldowns = assertBool(g.respectCooldowns, `${ctx}.guards.respectCooldowns`);
    }
    if (g.respectBudgets !== undefined) {
      partial.respectBudgets = assertBool(g.respectBudgets, `${ctx}.guards.respectBudgets`);
    }
    if (g.noDuplicateActiveRuns !== undefined) {
      partial.noDuplicateActiveRuns = assertBool(
        g.noDuplicateActiveRuns,
        `${ctx}.guards.noDuplicateActiveRuns`,
      );
    }
    out.guards = partial;
  }
  return out;
}

function mergePolicy(base: CeoFlowPolicy, override: CeoFlowOverride): CeoFlowPolicy {
  return {
    enabled: override.enabled ?? base.enabled,
    heartbeatSec: override.heartbeatSec ?? base.heartbeatSec,
    flowChecks: { ...base.flowChecks, ...(override.flowChecks ?? {}) },
    guards: { ...base.guards, ...(override.guards ?? {}) },
    auditMaxIssuesPerHeartbeat:
      override.auditMaxIssuesPerHeartbeat ?? base.auditMaxIssuesPerHeartbeat,
    promptInsertKey: override.promptInsertKey ?? base.promptInsertKey,
  };
}

export function parseCeoFlowPolicy(
  raw: unknown,
  options: CeoFlowLoadOptions = {},
): ResolvedCeoFlowPolicy {
  const env = options.env ?? process.env;
  const strictEnv = options.strictEnv ?? false;
  const onWarn = options.onWarn ?? ((m) => logger.warn(m));

  if (!raw || typeof raw !== "object") {
    throw new Error("[ceo-flow-policy] file must contain a YAML mapping");
  }
  const file = raw as Record<string, unknown>;
  if (file.schemaVersion !== "1") {
    throw new Error(
      `[ceo-flow-policy] unsupported schemaVersion ${String(file.schemaVersion)} (expected "1")`,
    );
  }
  const ceoFlow = file.ceoFlow as Record<string, unknown> | undefined;
  if (!ceoFlow || typeof ceoFlow !== "object") {
    throw new Error("[ceo-flow-policy] ceoFlow block is required");
  }

  const defaultPolicy = assertDefaultPolicy(ceoFlow.default);
  const overrides = new Map<string, CeoFlowPolicy>();

  const rawOverrides = (ceoFlow.overrides ?? []) as unknown;
  if (!Array.isArray(rawOverrides)) {
    throw new Error("[ceo-flow-policy] ceoFlow.overrides must be an array");
  }

  for (let i = 0; i < rawOverrides.length; i++) {
    const entry = rawOverrides[i];
    const ctx = `ceoFlow.overrides[${i}]`;
    const resolved = substituteDeep(entry, env, strictEnv, onWarn, ctx);
    if (resolved === UNRESOLVED) continue;
    const o = assertOverrideShape(resolved, ctx);
    if (overrides.has(o.companyId)) {
      throw new Error(`[ceo-flow-policy] duplicate override for companyId ${o.companyId}`);
    }
    overrides.set(o.companyId, mergePolicy(defaultPolicy, o));
  }

  return { schemaVersion: "1", default: defaultPolicy, overrides };
}

export function loadCeoFlowPolicyFromString(
  yamlText: string,
  options: CeoFlowLoadOptions = {},
): ResolvedCeoFlowPolicy {
  const parsed = parseYaml(yamlText);
  return parseCeoFlowPolicy(parsed, options);
}

export function loadCeoFlowPolicy(
  path: string,
  options: CeoFlowLoadOptions = {},
): ResolvedCeoFlowPolicy {
  const text = readFileSync(path, "utf8");
  return loadCeoFlowPolicyFromString(text, options);
}

export function policyForCompany(
  resolved: ResolvedCeoFlowPolicy,
  companyId: string,
): CeoFlowPolicy {
  return resolved.overrides.get(companyId) ?? resolved.default;
}

/**
 * Build the response body for
 * `GET /api/companies/{companyId}/effective-ceo-flow-policy`. The `source`
 * field is `"override"` when a per-company entry exists, `"default"`
 * otherwise. Mirrors the eli-board blueprint helper of the same name
 * (src/ceo-policy/loader.ts) so the endpoint, the dashboard, and the
 * reconciler all agree on the resolved policy and its hash.
 */
export function effectivePolicyResponse(
  resolved: ResolvedCeoFlowPolicy,
  companyId: string,
): EffectivePolicyResponse {
  const isOverride = resolved.overrides.has(companyId);
  const policy = isOverride ? resolved.overrides.get(companyId)! : resolved.default;
  return {
    companyId,
    source: isOverride ? "override" : "default",
    policyHash: computePolicyHash(policy),
    policy,
  };
}

function stablePolicySerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stablePolicySerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stablePolicySerialize(v)}`);
  return `{${entries.join(",")}}`;
}

export function computePolicyHash(policy: CeoFlowPolicy): string {
  return createHash("sha256").update(stablePolicySerialize(policy)).digest("hex");
}

export function renderCeoPromptFragment(policy: CeoFlowPolicy): string {
  return [
    `CEO operating policy: heartbeat every ${policy.heartbeatSec} seconds.`,
    `You own company flow. On every heartbeat, inspect issues and active runs;`,
    `all non-backlog, non-blocked, non-done/non-cancelled tickets should be moving.`,
    `Assign unassigned active work, wake relevant assignees when no active run`,
    `exists, and review backlog/blocked/done/cancelled tickets for`,
    `misclassification. Only leave work not moving when it is correctly backlog,`,
    `blocked, done, or cancelled. Respect approval gates, cooldowns, budgets,`,
    `and do not wake duplicate active runs.`,
  ].join(" ");
}

/**
 * Built-in default ResolvedCeoFlowPolicy used when `ELI_CEO_FLOW_POLICY_PATH`
 * is unset. Keeps the eli-board blueprint optional but authoritative when
 * present.
 */
export function builtinDefaultCeoFlowPolicy(): ResolvedCeoFlowPolicy {
  return { schemaVersion: "1", default: DEFAULT_POLICY, overrides: new Map() };
}

const REGISTRY_KEY = Symbol.for("paperclipai.server.ceoFlowPolicyRegistry");

interface CeoFlowPolicyRegistry {
  resolved: ResolvedCeoFlowPolicy;
  path: string | null;
  loadedAt: Date;
  /**
   * Non-null when the configured policy file failed to load and the server
   * fell back to built-in defaults. Lets the effective-policy endpoint return
   * `503` instead of silently serving defaults.
   */
  loadError: string | null;
  sighupListenerInstalled: boolean;
}

function getGlobalRegistry(): { [REGISTRY_KEY]?: CeoFlowPolicyRegistry } {
  return globalThis as unknown as { [REGISTRY_KEY]?: CeoFlowPolicyRegistry };
}

function loadFromEnv(
  env: NodeJS.ProcessEnv,
): { resolved: ResolvedCeoFlowPolicy; path: string | null; loadError: string | null } {
  const path = env.ELI_CEO_FLOW_POLICY_PATH?.trim() || null;
  if (!path) {
    return { resolved: builtinDefaultCeoFlowPolicy(), path: null, loadError: null };
  }
  try {
    const resolved = loadCeoFlowPolicy(path, {
      env,
      onWarn: (m) => logger.warn(m),
    });
    return { resolved, path, loadError: null };
  } catch (err) {
    logger.error(
      { err, policyPath: path },
      "[ceo-flow-policy] failed to load policy file; falling back to built-in defaults",
    );
    return {
      resolved: builtinDefaultCeoFlowPolicy(),
      path,
      loadError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Initialize the policy registry on server boot. Installs a SIGHUP listener
 * that reloads the policy file. Safe to call multiple times; subsequent calls
 * reload the policy synchronously.
 */
export function initCeoFlowPolicy(env: NodeJS.ProcessEnv = process.env): ResolvedCeoFlowPolicy {
  const registryHost = getGlobalRegistry();
  const { resolved, path, loadError } = loadFromEnv(env);
  const existing = registryHost[REGISTRY_KEY];
  const sighupListenerInstalled = existing?.sighupListenerInstalled ?? false;
  registryHost[REGISTRY_KEY] = {
    resolved,
    path,
    loadedAt: new Date(),
    loadError,
    sighupListenerInstalled,
  };
  if (!sighupListenerInstalled && typeof process.on === "function") {
    process.on("SIGHUP", () => {
      try {
        reloadCeoFlowPolicy(env);
      } catch (err) {
        logger.error({ err }, "[ceo-flow-policy] SIGHUP reload failed");
      }
    });
    registryHost[REGISTRY_KEY]!.sighupListenerInstalled = true;
  }
  logger.info(
    {
      ceoFlowPolicyPath: path,
      ceoFlowPolicyHash: computePolicyHash(resolved.default),
      ceoFlowOverrides: resolved.overrides.size,
    },
    path
      ? "[ceo-flow-policy] loaded policy from file"
      : "[ceo-flow-policy] ELI_CEO_FLOW_POLICY_PATH unset; using built-in defaults",
  );
  return resolved;
}

export function reloadCeoFlowPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCeoFlowPolicy {
  const registryHost = getGlobalRegistry();
  const { resolved, path, loadError } = loadFromEnv(env);
  const existing = registryHost[REGISTRY_KEY];
  registryHost[REGISTRY_KEY] = {
    resolved,
    path,
    loadedAt: new Date(),
    loadError,
    sighupListenerInstalled: existing?.sighupListenerInstalled ?? false,
  };
  logger.info(
    {
      ceoFlowPolicyPath: path,
      ceoFlowPolicyHash: computePolicyHash(resolved.default),
      ceoFlowOverrides: resolved.overrides.size,
    },
    "[ceo-flow-policy] reloaded policy",
  );
  return resolved;
}

export function getCeoFlowPolicy(): ResolvedCeoFlowPolicy {
  const registryHost = getGlobalRegistry();
  const existing = registryHost[REGISTRY_KEY];
  if (existing) return existing.resolved;
  return initCeoFlowPolicy();
}

export interface CeoFlowPolicyState {
  resolved: ResolvedCeoFlowPolicy;
  /**
   * Non-null when the configured policy file failed to load and the server is
   * serving built-in defaults. The effective-policy endpoint returns `503`
   * when this is set so operators can distinguish a degraded config from an
   * intentional default.
   */
  loadError: string | null;
}

/**
 * Like {@link getCeoFlowPolicy} but also reports whether the configured policy
 * file failed to load. Used by the effective-policy endpoint to honor the
 * `503` contract instead of silently serving defaults.
 */
export function getCeoFlowPolicyState(): CeoFlowPolicyState {
  const registryHost = getGlobalRegistry();
  let existing = registryHost[REGISTRY_KEY];
  if (!existing) {
    initCeoFlowPolicy();
    existing = registryHost[REGISTRY_KEY]!;
  }
  return { resolved: existing.resolved, loadError: existing.loadError };
}

/**
 * Test-only: replace the in-process policy registry with a specific resolved
 * policy. Returns a disposer that restores the previous value.
 */
export function __setCeoFlowPolicyForTests(
  resolved: ResolvedCeoFlowPolicy,
  options: { loadError?: string | null } = {},
): () => void {
  const registryHost = getGlobalRegistry();
  const previous = registryHost[REGISTRY_KEY];
  registryHost[REGISTRY_KEY] = {
    resolved,
    path: null,
    loadedAt: new Date(),
    loadError: options.loadError ?? null,
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

export interface CeoBootstrapDecorationInput {
  companyId: string;
  adapterConfig: Record<string, unknown>;
}

export interface CeoBootstrapDecorationResult {
  adapterConfig: Record<string, unknown>;
  policyHash: string;
  promptInsertKey: string;
  resolvedHeartbeatSec: number;
  enabled: boolean;
  promptFragment: string;
}

const CEO_FLOW_ADAPTER_CONFIG_KEY = "ceoFlowPolicy";

/**
 * Apply the effective CEO flow policy to a CEO agent's adapterConfig at
 * hire/bootstrap time and log the resolution. Returns the patched
 * adapterConfig plus structured policy metadata for callers that want to
 * emit additional audit events.
 */
export function applyCeoFlowPolicyToAdapterConfig(
  input: CeoBootstrapDecorationInput,
  resolved: ResolvedCeoFlowPolicy = getCeoFlowPolicy(),
): CeoBootstrapDecorationResult {
  const effective = policyForCompany(resolved, input.companyId);
  const policyHash = computePolicyHash(effective);
  const promptFragment = renderCeoPromptFragment(effective);

  const existing = input.adapterConfig ?? {};
  const adapterConfig: Record<string, unknown> = {
    ...existing,
    heartbeatSec: effective.heartbeatSec,
    heartbeatEnabled: effective.enabled,
    [CEO_FLOW_ADAPTER_CONFIG_KEY]: {
      policyHash,
      promptInsertKey: effective.promptInsertKey,
      resolvedHeartbeatSec: effective.heartbeatSec,
      enabled: effective.enabled,
      promptFragment,
    },
  };

  // If the caller already supplied a promptTemplate (custom CEO prompt), append
  // the fragment so it still reaches that adapter path. When promptTemplate is
  // absent the bundle-materialization step injects the fragment into AGENTS.md.
  const existingPromptTemplate =
    typeof existing.promptTemplate === "string" ? existing.promptTemplate.trim() : "";
  if (existingPromptTemplate.length > 0) {
    adapterConfig.promptTemplate = `${existingPromptTemplate}\n\n${promptFragment}`;
  }

  logger.info(
    {
      companyId: input.companyId,
      policyHash,
      promptInsertKey: effective.promptInsertKey,
      resolvedHeartbeatSec: effective.heartbeatSec,
    },
    "[ceo-flow-policy] rendered CEO bootstrap policy",
  );

  return {
    adapterConfig,
    policyHash,
    promptInsertKey: effective.promptInsertKey,
    resolvedHeartbeatSec: effective.heartbeatSec,
    enabled: effective.enabled,
    promptFragment,
  };
}
