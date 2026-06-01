import { afterEach, describe, expect, it } from "vitest";

import {
  mergeModelProfileAdapterConfig,
  parseProviderFallbackChainEnv,
  resolveEffectiveProviderFallbackChain,
  enforceFallbackAdapterModel,
  enforceFallbackAdapterCommand,
} from "../services/heartbeat.ts";
import {
  __setProviderFallbackPolicyForTests,
  builtinDefaultProviderFallbackPolicy,
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


describe("enforceFallbackAdapterCommand", () => {
  it("drops an inherited claude command on a claude_local -> grok_local failover", () => {
    // Regression: a claude_local agent persists `command: "claude"`. The model
    // guard rewrites `model` but leaves `command` pointing at the claude binary,
    // which the grok adapter cannot run ("command loops"). The command guard
    // strips it so the grok adapter falls back to its own default command.
    expect(
      enforceFallbackAdapterCommand({
        config: { model: "grok-4-latest", command: "claude" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterCommand: null,
      }),
    ).toEqual({ model: "grok-4-latest" });
  });

  it("substitutes the fallback adapter's own command when supplied", () => {
    expect(
      enforceFallbackAdapterCommand({
        config: { model: "grok-4-latest", command: "claude" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterCommand: "/paperclip/.grok/bin/grok",
      }),
    ).toEqual({ model: "grok-4-latest", command: "/paperclip/.grok/bin/grok" });
  });

  it("leaves the config untouched for a same-adapter failover (account rotation)", () => {
    const config = { model: "claude-opus-4-8", command: "claude", account: "aflabox" };
    expect(
      enforceFallbackAdapterCommand({
        config,
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "claude_local",
        fallbackAdapterCommand: null,
      }),
    ).toBe(config);
  });

  it("leaves the config untouched when no fallback is engaged", () => {
    const config = { command: "claude" };
    expect(
      enforceFallbackAdapterCommand({
        config,
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: null,
        fallbackAdapterCommand: null,
      }),
    ).toBe(config);
  });

  it("does not mutate the input config", () => {
    const config = { model: "grok-4-latest", command: "claude" };
    enforceFallbackAdapterCommand({
      config,
      agentAdapterType: "claude_local",
      selectedFallbackAdapterType: "grok_local",
      fallbackAdapterCommand: null,
    });
    expect(config).toEqual({ model: "grok-4-latest", command: "claude" });
  });
});
