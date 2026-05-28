import { afterEach, describe, expect, it } from "vitest";

import {
  parseProviderFallbackChainEnv,
  resolveEffectiveProviderFallbackChain,
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
