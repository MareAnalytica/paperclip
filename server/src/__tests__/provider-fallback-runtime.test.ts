import { afterEach, describe, expect, it } from "vitest";

import {
  mergeModelProfileAdapterConfig,
  parseProviderFallbackChainEnv,
  resolveEffectiveProviderFallbackChain,
  stripClaudeModelForNonClaudeFallback,
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

describe("stripClaudeModelForNonClaudeFallback", () => {
  it("strips an inherited claude model for a grok_local fallback adapter", () => {
    expect(
      stripClaudeModelForNonClaudeFallback({
        config: { model: "claude-opus-4-8", command: "claude", env: { A: "1" } },
        selectedFallbackAdapterType: "grok_local",
      }),
    ).toEqual({ command: "claude", env: { A: "1" } });
  });

  it("also strips a claude model for codex_local", () => {
    expect(
      stripClaudeModelForNonClaudeFallback({
        config: { model: "claude-sonnet-4-6" },
        selectedFallbackAdapterType: "codex_local",
      }),
    ).toEqual({});
  });

  it("is case- and separator-insensitive for claude model ids", () => {
    for (const model of ["Claude-Opus-4-8", "claude_opus_4_8", "CLAUDE-3-5-haiku"]) {
      expect(
        stripClaudeModelForNonClaudeFallback({
          config: { model },
          selectedFallbackAdapterType: "grok_local",
        }),
      ).not.toHaveProperty("model");
    }
  });

  it("preserves a provider-valid (non-claude) model for a non-claude fallback", () => {
    const config = { command: "/paperclip/.grok/bin/grok", model: "grok-4-latest" };
    expect(
      stripClaudeModelForNonClaudeFallback({
        config,
        selectedFallbackAdapterType: "grok_local",
      }),
    ).toEqual(config);
  });

  it("preserves a claude model for a claude_local fallback adapter", () => {
    const config = { model: "claude-opus-4-8", account: "aflabox" };
    expect(
      stripClaudeModelForNonClaudeFallback({
        config,
        selectedFallbackAdapterType: "claude_local",
      }),
    ).toBe(config);
  });

  it("preserves the model when no fallback adapter is engaged", () => {
    const config = { model: "claude-opus-4-8" };
    expect(
      stripClaudeModelForNonClaudeFallback({
        config,
        selectedFallbackAdapterType: null,
      }),
    ).toBe(config);
  });

  it("is a no-op when the config carries no model", () => {
    const config = { command: "/paperclip/.grok/bin/grok" };
    expect(
      stripClaudeModelForNonClaudeFallback({
        config,
        selectedFallbackAdapterType: "grok_local",
      }),
    ).toBe(config);
  });

  it("ignores a non-string model value", () => {
    const config = { model: 42 as unknown as string };
    expect(
      stripClaudeModelForNonClaudeFallback({
        config,
        selectedFallbackAdapterType: "grok_local",
      }),
    ).toBe(config);
  });

  it("does not mutate the input config", () => {
    const config = { model: "claude-opus-4-8", command: "claude" };
    stripClaudeModelForNonClaudeFallback({
      config,
      selectedFallbackAdapterType: "grok_local",
    });
    expect(config).toEqual({ model: "claude-opus-4-8", command: "claude" });
  });
});

describe("provider fallback model boundary (merge integration)", () => {
  it("grok fallback receives no claude model id so the adapter uses its own default", () => {
    const merged = stripClaudeModelForNonClaudeFallback({
      config: mergeModelProfileAdapterConfig({
        baseConfig: { model: "claude-opus-4-8", command: "/paperclip/.grok/bin/grok" },
        modelProfile: NOOP_MODEL_PROFILE,
        issueAdapterConfig: { command: "/paperclip/.grok/bin/grok" },
      }),
      selectedFallbackAdapterType: "grok_local",
    });
    expect("model" in merged).toBe(false);
    expect(merged.command).toBe("/paperclip/.grok/bin/grok");
  });

  // DEE-659 / Codex P2: an issue-level custom model override is merged after
  // the base config; a claude override must NOT survive into a non-claude
  // fallback adapter.
  it("strips a claude model that arrives via an issue-level adapter override", () => {
    const merged = stripClaudeModelForNonClaudeFallback({
      config: mergeModelProfileAdapterConfig({
        baseConfig: { model: "claude-opus-4-8" },
        modelProfile: NOOP_MODEL_PROFILE,
        // issue override carrying a claude model, merged on top
        issueAdapterConfig: { command: "/paperclip/.grok/bin/grok", model: "claude-opus-4-8" },
      }),
      selectedFallbackAdapterType: "grok_local",
    });
    expect("model" in merged).toBe(false);
  });

  it("a provider-valid chain-entry model still wins for a non-claude fallback", () => {
    const merged = stripClaudeModelForNonClaudeFallback({
      config: mergeModelProfileAdapterConfig({
        baseConfig: { model: "claude-opus-4-8" },
        modelProfile: NOOP_MODEL_PROFILE,
        issueAdapterConfig: { command: "codex", model: "gpt-5.3-codex" },
      }),
      selectedFallbackAdapterType: "codex_local",
    });
    expect(merged.model).toBe("gpt-5.3-codex");
  });

  it("claude fallback keeps the inherited claude model", () => {
    const merged = stripClaudeModelForNonClaudeFallback({
      config: mergeModelProfileAdapterConfig({
        baseConfig: { model: "claude-opus-4-8" },
        modelProfile: NOOP_MODEL_PROFILE,
        issueAdapterConfig: { account: "aflabox" },
      }),
      selectedFallbackAdapterType: "claude_local",
    });
    expect(merged.model).toBe("claude-opus-4-8");
  });
});
