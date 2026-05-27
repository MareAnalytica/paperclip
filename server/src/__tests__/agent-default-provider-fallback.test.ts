import { afterEach, describe, expect, it } from "vitest";
import { normalizeRuntimeConfigForNewAgent } from "../services/agents.ts";
import {
  __setProviderFallbackPolicyForTests,
  builtinDefaultProviderFallbackPolicy,
  loadProviderFallbackPolicyFromString,
} from "../services/provider-fallback-policy.ts";

const OVERRIDE_DOC = `
schemaVersion: "1"
providerFallback:
  default:
    chain:
      - id: claude-code-personal
        adapter: claude_local
        account: personal
      - id: codex-local
        adapter: codex_local
  overrides:
    - companyId: \${OVR_COMPANY}
      chain:
        - id: only-grok
          adapter: grok_local
`;

describe("normalizeRuntimeConfigForNewAgent — providerFallback seeding", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
  });

  it("seeds the resolved default chain when caller does not supply one", () => {
    disposers.push(__setProviderFallbackPolicyForTests(builtinDefaultProviderFallbackPolicy()));

    const out = normalizeRuntimeConfigForNewAgent({}, "company-x");
    const block = out.providerFallback as { chain: Array<{ id: string }> } | undefined;
    expect(block).toBeDefined();
    expect(block!.chain.map((entry) => entry.id)).toEqual([
      "claude-code-personal",
      "claude-code-aflabox",
      "codex-local",
      "grok-local",
    ]);
  });

  it("preserves an explicit providerFallback.chain supplied by the caller", () => {
    disposers.push(__setProviderFallbackPolicyForTests(builtinDefaultProviderFallbackPolicy()));

    const caller = {
      providerFallback: {
        chain: [
          { id: "only-codex", adapter: "codex_local", enabled: true, account: null, adapterConfig: null },
        ],
      },
    };
    const out = normalizeRuntimeConfigForNewAgent(caller, "company-x");
    const block = out.providerFallback as { chain: Array<{ id: string }> };
    expect(block.chain.map((entry) => entry.id)).toEqual(["only-codex"]);
  });

  it("respects per-company override from policy registry", () => {
    disposers.push(
      __setProviderFallbackPolicyForTests(
        loadProviderFallbackPolicyFromString(OVERRIDE_DOC, {
          env: { OVR_COMPANY: "ovr-tenant" } as NodeJS.ProcessEnv,
        }),
      ),
    );

    const owner = normalizeRuntimeConfigForNewAgent({}, "ovr-tenant");
    const ownerBlock = owner.providerFallback as { chain: Array<{ id: string }> };
    expect(ownerBlock.chain.map((entry) => entry.id)).toEqual(["only-grok"]);

    const other = normalizeRuntimeConfigForNewAgent({}, "other-tenant");
    const otherBlock = other.providerFallback as { chain: Array<{ id: string }> };
    expect(otherBlock.chain.map((entry) => entry.id)).toEqual([
      "claude-code-personal",
      "codex-local",
    ]);
  });

  it("does not clobber other runtimeConfig keys when seeding", () => {
    disposers.push(__setProviderFallbackPolicyForTests(builtinDefaultProviderFallbackPolicy()));

    const out = normalizeRuntimeConfigForNewAgent(
      { heartbeat: { intervalSec: 60 }, customFlag: true },
      "co-1",
    );
    expect(out.customFlag).toBe(true);
    expect((out.heartbeat as Record<string, unknown>).intervalSec).toBe(60);
    expect((out.heartbeat as Record<string, unknown>).maxConcurrentRuns).toBeDefined();
    expect(out.providerFallback).toBeDefined();
  });
});
