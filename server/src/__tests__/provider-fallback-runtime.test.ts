import { afterEach, describe, expect, it } from "vitest";

import {
  isProviderFallbackEligibleError,
  mergeModelProfileAdapterConfig,
  parseProviderFallbackChainEnv,
  resolveEffectiveProviderFallbackChain,
  resolveFailedProviderAuthMode,
  enforceFallbackAdapterModel,
} from "../services/heartbeat.ts";
import {
  __setProviderFallbackPolicyForTests,
  builtinDefaultProviderFallbackPolicy,
  PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS,
} from "../services/provider-fallback-policy.ts";

const FULL_RUNTIME_CHAIN = {
  providerFallback: {
    chain: [
      { id: "claude-code-personal", adapter: "claude_local", enabled: true, account: "personal", adapterConfig: { foo: "bar" } },
      { id: "claude-code-aflabox", adapter: "claude_local", enabled: true, account: "aflabox", adapterConfig: null },
      { id: "grok-local", adapter: "grok_local", enabled: true, account: null, adapterConfig: null },
      { id: "codex-local", adapter: "codex_local", enabled: true, account: null, adapterConfig: null },
    ],
  },
};

describe("parseProviderFallbackChainEnv", () => {
  it("splits, trims, lowercases, and preserves order", () => {
    expect(parseProviderFallbackChainEnv(" Claude-Code-Personal , codex-local ")).toEqual([
      "claude-code-personal",
      "codex-local",
    ]);
  });

  it("de-duplicates while keeping first occurrence order", () => {
    expect(parseProviderFallbackChainEnv("aa,bb,aa,cc,bb")).toEqual(["aa", "bb", "cc"]);
  });

  it("drops empties and non-slug entries", () => {
    expect(parseProviderFallbackChainEnv("claude-code-personal,,Bad Id,_x,codex-local")).toEqual([
      "claude-code-personal",
      "codex-local",
    ]);
  });

  it("returns [] for non-string / empty input", () => {
    expect(parseProviderFallbackChainEnv(undefined)).toEqual([]);
    expect(parseProviderFallbackChainEnv(null)).toEqual([]);
    expect(parseProviderFallbackChainEnv("")).toEqual([]);
    expect(parseProviderFallbackChainEnv(123)).toEqual([]);
  });
});

describe("resolveEffectiveProviderFallbackChain", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
  });

  it("returns the runtimeConfig chain unchanged when no env surface is present", () => {
    const chain = resolveEffectiveProviderFallbackChain({
      runtimeConfig: FULL_RUNTIME_CHAIN,
      adapterConfig: {},
      companyId: "co-1",
    });
    expect(chain.map((e) => e.id)).toEqual([
      "claude-code-personal",
      "claude-code-aflabox",
      "grok-local",
      "codex-local",
    ]);
  });

  it("honors the blueprint env chain ordering and shortening, sourcing entry details from runtimeConfig", () => {
    const chain = resolveEffectiveProviderFallbackChain({
      runtimeConfig: FULL_RUNTIME_CHAIN,
      adapterConfig: { env: { PROVIDER_FALLBACK_CHAIN: "claude-code-personal,codex-local" } },
      companyId: "co-1",
    });
    expect(chain.map((e) => e.id)).toEqual(["claude-code-personal", "codex-local"]);
    // entry credentials carry over from the runtimeConfig chain
    expect(chain[0].account).toBe("personal");
    expect(chain[0].adapterConfig).toEqual({ foo: "bar" });
    expect(chain[1].adapter).toBe("codex_local");
  });

  it("resolves env ids absent from runtimeConfig via the company policy registry", () => {
    disposers.push(__setProviderFallbackPolicyForTests(builtinDefaultProviderFallbackPolicy()));
    const chain = resolveEffectiveProviderFallbackChain({
      // runtimeConfig has no provider fallback at all
      runtimeConfig: {},
      adapterConfig: { env: { PROVIDER_FALLBACK_CHAIN: "claude-code-personal,grok-local" } },
      companyId: "co-1",
    });
    expect(chain.map((e) => e.id)).toEqual(["claude-code-personal", "grok-local"]);
    expect(chain[0].adapter).toBe("claude_local");
    expect(chain[0].account).toBe("personal");
    expect(chain[1].adapter).toBe("grok_local");
  });

  it("falls back to the runtimeConfig chain when env ids cannot be resolved at all", () => {
    disposers.push(__setProviderFallbackPolicyForTests(builtinDefaultProviderFallbackPolicy()));
    const chain = resolveEffectiveProviderFallbackChain({
      runtimeConfig: FULL_RUNTIME_CHAIN,
      adapterConfig: { env: { PROVIDER_FALLBACK_CHAIN: "nonexistent-a,nonexistent-b" } },
      companyId: "co-1",
    });
    expect(chain.map((e) => e.id)).toEqual([
      "claude-code-personal",
      "claude-code-aflabox",
      "grok-local",
      "codex-local",
    ]);
  });

  it("returns [] when neither env nor runtimeConfig provide a chain", () => {
    const chain = resolveEffectiveProviderFallbackChain({
      runtimeConfig: {},
      adapterConfig: {},
      companyId: "co-1",
    });
    expect(chain).toEqual([]);
  });
});

const NOOP_MODEL_PROFILE = {
  requested: null,
  requestedBy: null,
  applied: null,
  configSource: null,
  fallbackReason: null,
  adapterConfig: null,
} as const;

describe("enforceFallbackAdapterModel", () => {
  it("drops an inherited claude model on a claude_local -> grok_local failover", () => {
    expect(
      enforceFallbackAdapterModel({
        config: { model: "claude-opus-4-8", command: "/paperclip/.grok/bin/grok" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterModel: null,
      }),
    ).toEqual({ command: "/paperclip/.grok/bin/grok" });
  });

  it("drops an inherited NON-claude model on a codex_local -> grok_local failover", () => {
    // Regression for the Codex review: a codex model id must not survive into
    // the grok adapter just because it is not claude-family.
    expect(
      enforceFallbackAdapterModel({
        config: { model: "gpt-5.3-codex", command: "/paperclip/.grok/bin/grok" },
        agentAdapterType: "codex_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterModel: null,
      }),
    ).toEqual({ command: "/paperclip/.grok/bin/grok" });
  });

  it("drops an inherited claude model that arrived via an issue override", () => {
    // The override model is provider-specific to the PRIMARY adapter and must
    // not survive into a cross-provider fallback adapter.
    expect(
      enforceFallbackAdapterModel({
        config: { model: "claude-opus-4-8", account: "x" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "codex_local",
        fallbackAdapterModel: null,
      }),
    ).toEqual({ account: "x" });
  });

  it("uses the fallback adapter's own model when one is supplied", () => {
    expect(
      enforceFallbackAdapterModel({
        config: { model: "claude-opus-4-8" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterModel: "grok-4-latest",
      }),
    ).toEqual({ model: "grok-4-latest" });
  });

  it("leaves the config untouched for a same-adapter failover (claude account rotation)", () => {
    const config = { model: "claude-opus-4-8", account: "aflabox" };
    expect(
      enforceFallbackAdapterModel({
        config,
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "claude_local",
        fallbackAdapterModel: null,
      }),
    ).toBe(config);
  });

  it("leaves the config untouched when no fallback is engaged", () => {
    const config = { model: "claude-opus-4-8" };
    expect(
      enforceFallbackAdapterModel({
        config,
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: null,
        fallbackAdapterModel: null,
      }),
    ).toBe(config);
  });

  it("does not mutate the input config", () => {
    const config = { model: "claude-opus-4-8", command: "claude" };
    enforceFallbackAdapterModel({
      config,
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "grok_local",
      fallbackAdapterModel: null,
    });
    expect(config).toEqual({ model: "claude-opus-4-8", command: "claude" });
  });
});

describe("provider fallback model boundary (merge integration)", () => {
  // Mirror the production call site: a valid fallback model is the engaged
  // provider's chain-entry model, else the fallback adapter's own profile
  // default; primary-keyed sources are unsafe and excluded.
  const integrate = (opts: {
    baseConfig: Record<string, unknown>;
    issueAdapterConfig: Record<string, unknown>;
    chainEntryModel?: string;
    profileDefaultModel?: string;
    agentAdapterType: string;
    selectedFallbackAdapterType: "claude_local" | "codex_local" | "grok_local" | null;
  }) =>
    enforceFallbackAdapterModel({
      config: mergeModelProfileAdapterConfig({
        baseConfig: opts.baseConfig,
        modelProfile: NOOP_MODEL_PROFILE,
        issueAdapterConfig: opts.issueAdapterConfig,
      }),
      agentAdapterType: opts.agentAdapterType,
      selectedFallbackAdapterType: opts.selectedFallbackAdapterType,
      fallbackAdapterModel: opts.chainEntryModel ?? opts.profileDefaultModel ?? null,
    });

  it("grok fallback receives no claude model id so the adapter uses its own default", () => {
    const merged = integrate({
      baseConfig: { model: "claude-opus-4-8", command: "/paperclip/.grok/bin/grok" },
      issueAdapterConfig: { command: "/paperclip/.grok/bin/grok" },
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "grok_local",
    });
    expect("model" in merged).toBe(false);
    expect(merged.command).toBe("/paperclip/.grok/bin/grok");
  });

  it("strips a claude model that arrives via an issue-level adapter override", () => {
    const merged = integrate({
      baseConfig: { model: "claude-opus-4-8" },
      issueAdapterConfig: { command: "/paperclip/.grok/bin/grok", model: "claude-opus-4-8" },
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "grok_local",
    });
    expect("model" in merged).toBe(false);
  });

  it("a chain-entry model for the fallback adapter wins", () => {
    const merged = integrate({
      baseConfig: { model: "claude-opus-4-8" },
      issueAdapterConfig: { command: "codex" },
      chainEntryModel: "gpt-5.3-codex",
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "codex_local",
    });
    expect(merged.model).toBe("gpt-5.3-codex");
  });

  it("uses the fallback adapter's own profile default when the chain entry omits a model", () => {
    // DEE-659 round-4 regression: a requested model profile must still resolve
    // to the FALLBACK adapter's own profile model (not the primary model, not
    // dropped) on a cross-provider failover.
    const merged = integrate({
      baseConfig: { model: "claude-opus-4-8" },
      issueAdapterConfig: { command: "/paperclip/.grok/bin/grok" },
      profileDefaultModel: "grok-code-fast",
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "grok_local",
    });
    expect(merged.model).toBe("grok-code-fast");
  });

  it("claude account-rotation fallback keeps the inherited claude model", () => {
    const merged = integrate({
      baseConfig: { model: "claude-opus-4-8" },
      issueAdapterConfig: { account: "aflabox" },
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "claude_local",
    });
    expect(merged.model).toBe("claude-opus-4-8");
  });
});

describe("isProviderFallbackEligibleError — auth-model-aware detection precedence (ELI-901)", () => {
  const run = (errorCode: string | null, resultJson: unknown = null, error: string | null = null, contextSnapshot: unknown = null) => ({
    errorCode,
    resultJson,
    error,
    contextSnapshot,
  });

  it("oauth-session provider: a session cap / auth-session error is limit-like and hops", () => {
    // Preserves the observed production recovery for the Claude/Codex/Grok locals.
    expect(isProviderFallbackEligibleError(run("claude_session_limit"), "oauth-session")).toBe(true);
    expect(isProviderFallbackEligibleError(run("codex_auth_session_expired"), "oauth-session")).toBe(true);
  });

  it("raw-key provider: an auth / session error is permanent and does NOT consume the chain", () => {
    // Spec §3 precedence: a raw-key auth failure follows the normal failure path.
    expect(isProviderFallbackEligibleError(run("provider_auth_failed"), "raw-key")).toBe(false);
    expect(isProviderFallbackEligibleError(run("invalid_session_token"), "raw-key")).toBe(false);
  });

  it("defaults to the oauth-session (hop) behavior when no auth mode is supplied", () => {
    // A missing/unknown mode must not change prior production behavior.
    expect(isProviderFallbackEligibleError(run("provider_auth_failed"))).toBe(true);
    expect(isProviderFallbackEligibleError(run("provider_auth_failed"), null)).toBe(true);
  });

  it("a usage-limit run hops regardless of auth model", () => {
    // claude_usage_limit and the transient_upstream family are usage limits, not
    // auth failures — the raw-key gate must never suppress them.
    expect(isProviderFallbackEligibleError(run("claude_usage_limit"), "raw-key")).toBe(true);
    expect(
      isProviderFallbackEligibleError(run("whatever", { errorFamily: "transient_upstream" }), "raw-key"),
    ).toBe(true);
    expect(isProviderFallbackEligibleError(run("codex_transient_upstream"), "raw-key")).toBe(true);
  });

  it("a non-limit, non-auth error never consumes the chain", () => {
    expect(isProviderFallbackEligibleError(run("network_unreachable"), "oauth-session")).toBe(false);
    expect(isProviderFallbackEligibleError(run("bad_request"), "raw-key")).toBe(false);
    expect(isProviderFallbackEligibleError(run(null), "oauth-session")).toBe(false);
  });

  // Composed precedence after the ELI-902 (G2) limitMarkers safety-net landed on
  // main: the auth gate (arg 2) and the marker safety-net (arg 3) interact. These
  // pin the resolution decision so a future edit can't silently flip it.
  const MARKERS = [...PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS];

  it("raw-key auth errorCode short-circuits and is NOT rescued by the limitMarkers safety-net", () => {
    // An `auth`/`session` errorCode IS the adapter's native classification, so the
    // G2 safety-net's "no native classification" precondition is unmet — a raw-key
    // permanent auth failure must not be flipped into a hop by a marker substring
    // that happens to appear in the failure text.
    const authFailWithLimitText = run(
      "provider_auth_failed",
      null,
      "401 unauthorized — note: usage limit reached earlier in the session",
    );
    expect(isProviderFallbackEligibleError(authFailWithLimitText, "raw-key", MARKERS)).toBe(false);
  });

  it("raw-key NON-auth failure still hops when the failure text matches a limit marker", () => {
    // No native classification (generic errorCode) → the safety-net runs and a real
    // usage limit hops even for a raw-key provider; the auth gate only suppresses
    // genuine auth classifications.
    const limitText = run("adapter_error", { error: "Rate limit exceeded: 429 Too Many Requests" });
    expect(isProviderFallbackEligibleError(limitText, "raw-key", MARKERS)).toBe(true);
    // Without markers configured the same run does not hop.
    expect(isProviderFallbackEligibleError(limitText, "raw-key", [])).toBe(false);
  });

  it("oauth-session auth error still hops and never reaches the safety-net (markers irrelevant)", () => {
    expect(isProviderFallbackEligibleError(run("claude_session_limit"), "oauth-session", MARKERS)).toBe(true);
    expect(isProviderFallbackEligibleError(run("claude_session_limit"), "oauth-session", [])).toBe(true);
  });

  // ELI-951 Contract B: no-output kill (from Contract A idle deadline) on fallback hop
  // is provider-fallback-eligible so the chain advances; primary no_output/timeout is not.
  it("Contract A no-output kill on non-primary fallback hop is fallback-eligible (Contract B)", () => {
    const hopKill = run(
      "timeout",
      { errorCode: "adapter_no_output_timeout", errorMessage: "Adapter invocation killed by idle no-output deadline after 600s (no new output observed).", errorMeta: { noOutput: true, noOutputKillSec: 600 } },
      "Adapter invocation killed by idle no-output deadline after 600s (no new output observed).",
      { providerFallbackSelection: { id: "grok-local", adapter: "grok_local" } },
    );
    expect(isProviderFallbackEligibleError(hopKill, "oauth-session")).toBe(true);
    // Also eligible independent of raw-key (internal kill, not auth classification).
    expect(isProviderFallbackEligibleError(hopKill, "raw-key")).toBe(true);
    // Without markers etc, still hops because of the explicit no_output rule.
    expect(isProviderFallbackEligibleError(hopKill, "raw-key", [])).toBe(true);
  });

  it("Contract A no-output kill (or bare timeout) on primary adapter is NOT fallback-eligible", () => {
    const primaryTimeout = run("timeout", null, "Timed out after 30s", {});
    expect(isProviderFallbackEligibleError(primaryTimeout, "oauth-session")).toBe(false);

    const primaryNoOutputKill = run(
      "timeout",
      { errorCode: "adapter_no_output_timeout", errorMeta: { noOutput: true } },
      "idle no-output deadline after 600s",
      null, // no prior selection → primary
    );
    expect(isProviderFallbackEligibleError(primaryNoOutputKill, "oauth-session")).toBe(false);
    expect(isProviderFallbackEligibleError(primaryNoOutputKill, "raw-key")).toBe(false);
  });

  it("no_output kill on hop still respects later marker safety-net for non-no_output cases (precedence preserved)", () => {
    // The no_output early return for hops must not change behavior for other hop failures:
    // non-no_output hop errors still require marker (or native) to hop; no silent auto-hop.
    const hopNonNoOutput = run(
      "adapter_error",
      { error: "rate limit exceeded on fallback hop (non no-output)" },
      "rate limit exceeded on fallback hop (non no-output)",
      { providerFallbackSelection: { id: "grok-local", adapter: "grok_local" } },
    );
    expect(isProviderFallbackEligibleError(hopNonNoOutput, "oauth-session", [])).toBe(false);
    expect(isProviderFallbackEligibleError(hopNonNoOutput, "oauth-session", MARKERS)).toBe(true);
  });
});

describe("resolveFailedProviderAuthMode — threads PROVIDER_AUTH_MODES into the gate (ELI-901)", () => {
  const agent = (env: Record<string, string>) => ({
    runtimeConfig: FULL_RUNTIME_CHAIN,
    adapterConfig: {
      env: { PROVIDER_FALLBACK_CHAIN: "claude-code-personal,codex-local", ...env },
    },
    companyId: "co-1",
    adapterType: "claude_local",
  });
  const AUTH_MODES = "claude-code-personal:oauth-session,codex-local:raw-key";

  it("resolves the primary provider's mode on a first failure (no prior selection)", () => {
    const mode = resolveFailedProviderAuthMode(
      { contextSnapshot: {} },
      agent({ PROVIDER_AUTH_MODES: AUTH_MODES }),
    );
    expect(mode).toBe("oauth-session");
  });

  it("resolves the active fallback selection's mode on a subsequent hop", () => {
    const mode = resolveFailedProviderAuthMode(
      { contextSnapshot: { providerFallbackSelection: { id: "codex-local" } } },
      agent({ PROVIDER_AUTH_MODES: AUTH_MODES }),
    );
    expect(mode).toBe("raw-key");
  });

  it("returns null when the env declares no mode (caller defaults to oauth-session)", () => {
    expect(resolveFailedProviderAuthMode({ contextSnapshot: {} }, agent({}))).toBeNull();
  });

  it("end-to-end: a raw-key provider's auth failure is gated out via the env surface", () => {
    const authMode = resolveFailedProviderAuthMode(
      { contextSnapshot: { providerFallbackSelection: { id: "codex-local" } } },
      agent({ PROVIDER_AUTH_MODES: AUTH_MODES }),
    );
    expect(
      isProviderFallbackEligibleError(
        { errorCode: "provider_auth_failed", resultJson: null, error: null, contextSnapshot: null },
        authMode,
      ),
    ).toBe(false);
  });
});
