import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __setProviderFallbackPolicyForTests,
  buildDefaultRuntimeConfigBlock,
  builtinDefaultProviderFallbackPolicy,
  computePolicyHash,
  initProviderFallbackPolicy,
  loadProviderFallbackPolicyFromString,
  parseProviderFallbackPolicy,
  policyForCompany,
  reloadProviderFallbackPolicy,
  resolveProviderFallbackEscalation,
  selectNextProviderFallbackEntry,
} from "../services/provider-fallback-policy.js";
import { enforceFallbackAdapterCommand } from "../services/heartbeat.js";

const VALID_DOC = `
schemaVersion: "1"
providerFallback:
  default:
    chain:
      - id: claude-code-personal
        adapter: claude_local
        account: personal
      - id: claude-code-aflabox
        adapter: claude_local
        account: aflabox
      - id: codex-local
        adapter: codex_local
      - id: grok-local
        adapter: grok_local
  overrides:
    - companyId: \${TEST_COMPANY}
      chain:
        - id: codex-only
          adapter: codex_local
`;

describe("provider-fallback-policy", () => {
  const disposers: Array<() => void> = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()!();
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  it("built-in default chain orders claude personal, claude aflabox, codex, grok", () => {
    const resolved = builtinDefaultProviderFallbackPolicy();
    expect(resolved.default.chain.map((entry) => entry.id)).toEqual([
      "claude-code-personal",
      "claude-code-aflabox",
      "codex-local",
      "grok-local",
    ]);
    expect(resolved.default.chain.map((entry) => entry.adapter)).toEqual([
      "claude_local",
      "claude_local",
      "codex_local",
      "grok_local",
    ]);
    expect(resolved.default.chain[0].account).toBe("personal");
    expect(resolved.default.chain[1].account).toBe("aflabox");
  });

  it("policy hash is stable across equivalent reshufflings of chain entry keys", () => {
    const a = builtinDefaultProviderFallbackPolicy().default;
    const b = {
      chain: a.chain.map((entry) => ({
        adapterConfig: entry.adapterConfig,
        account: entry.account,
        enabled: entry.enabled,
        adapter: entry.adapter,
        id: entry.id,
      })),
    };
    expect(computePolicyHash(a)).toBe(computePolicyHash(b));
  });

  it("parses a valid YAML document with env-substituted overrides", () => {
    const resolved = loadProviderFallbackPolicyFromString(VALID_DOC, {
      env: { TEST_COMPANY: "company-1" } as NodeJS.ProcessEnv,
    });
    expect(resolved.default.chain).toHaveLength(4);
    expect(resolved.overrides.size).toBe(1);
    expect(policyForCompany(resolved, "company-1").chain[0].id).toBe("codex-only");
    expect(policyForCompany(resolved, "unknown").chain[0].id).toBe("claude-code-personal");
  });

  it("skips overrides whose env placeholder is unset (non-strict)", () => {
    const warnings: string[] = [];
    const resolved = loadProviderFallbackPolicyFromString(VALID_DOC, {
      env: {} as NodeJS.ProcessEnv,
      onWarn: (m) => warnings.push(m),
    });
    expect(resolved.overrides.size).toBe(0);
    expect(warnings.some((m) => m.includes("TEST_COMPANY"))).toBe(true);
  });

  it("rejects entries with an unknown adapter", () => {
    expect(() =>
      parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: {
          default: { chain: [{ id: "x", adapter: "anthropic_api" }] },
        },
      }),
    ).toThrow(/adapter must be one of/);
  });

  it("rejects duplicate entry ids in a chain", () => {
    expect(() =>
      parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: {
          default: {
            chain: [
              { id: "a", adapter: "claude_local" },
              { id: "a", adapter: "codex_local" },
            ],
          },
        },
      }),
    ).toThrow(/duplicate entry id a/);
  });

  it("rejects an unsupported schemaVersion", () => {
    expect(() =>
      parseProviderFallbackPolicy({
        schemaVersion: "2",
        providerFallback: { default: { chain: [] } },
      }),
    ).toThrow(/unsupported schemaVersion/);
  });

  it("init loads policy from ELI_PROVIDER_FALLBACK_POLICY_PATH and reload picks up changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-fallback-policy-"));
    tempDirs.push(dir);
    const filePath = join(dir, "policy.yaml");
    writeFileSync(filePath, VALID_DOC, "utf8");

    const initial = initProviderFallbackPolicy({
      ELI_PROVIDER_FALLBACK_POLICY_PATH: filePath,
      TEST_COMPANY: "company-A",
    } as NodeJS.ProcessEnv);
    expect(initial.overrides.has("company-A")).toBe(true);

    writeFileSync(
      filePath,
      VALID_DOC.replace("TEST_COMPANY", "TEST_COMPANY_B"),
      "utf8",
    );
    const reloaded = reloadProviderFallbackPolicy({
      ELI_PROVIDER_FALLBACK_POLICY_PATH: filePath,
      TEST_COMPANY_B: "company-B",
    } as NodeJS.ProcessEnv);
    expect(reloaded.overrides.has("company-A")).toBe(false);
    expect(reloaded.overrides.has("company-B")).toBe(true);
  });

  it("init falls back to built-in defaults when ELI_PROVIDER_FALLBACK_POLICY_PATH is unset", () => {
    const resolved = initProviderFallbackPolicy({} as NodeJS.ProcessEnv);
    expect(resolved.overrides.size).toBe(0);
    expect(resolved.default.chain[0].id).toBe("claude-code-personal");
  });

  it("init falls back to built-in defaults when the policy file is invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-fallback-policy-bad-"));
    tempDirs.push(dir);
    const filePath = join(dir, "policy.yaml");
    writeFileSync(filePath, "schemaVersion: 'oops'\nproviderFallback: {}", "utf8");

    const resolved = initProviderFallbackPolicy({
      ELI_PROVIDER_FALLBACK_POLICY_PATH: filePath,
    } as NodeJS.ProcessEnv);
    expect(resolved.default.chain[0].id).toBe("claude-code-personal");
  });

  it("buildDefaultRuntimeConfigBlock returns a deep copy so callers cannot mutate registry", () => {
    const dispose = __setProviderFallbackPolicyForTests(
      builtinDefaultProviderFallbackPolicy(),
    );
    disposers.push(dispose);

    const block = buildDefaultRuntimeConfigBlock("any-company");
    expect(block.chain).toHaveLength(4);
    block.chain[0].enabled = false;
    block.chain.push({
      id: "extra",
      adapter: "claude_local",
      enabled: true,
      account: null,
      adapterConfig: null,
    });

    const fresh = buildDefaultRuntimeConfigBlock("any-company");
    expect(fresh.chain).toHaveLength(4);
    expect(fresh.chain[0].enabled).toBe(true);
  });

  it("buildDefaultRuntimeConfigBlock honors per-company override", () => {
    const dispose = __setProviderFallbackPolicyForTests(
      loadProviderFallbackPolicyFromString(VALID_DOC, {
        env: { TEST_COMPANY: "ovr-company" } as NodeJS.ProcessEnv,
      }),
    );
    disposers.push(dispose);

    const overridden = buildDefaultRuntimeConfigBlock("ovr-company");
    expect(overridden.chain.map((entry) => entry.id)).toEqual(["codex-only"]);

    const fallback = buildDefaultRuntimeConfigBlock("other-company");
    expect(fallback.chain.map((entry) => entry.id)).toEqual([
      "claude-code-personal",
      "claude-code-aflabox",
      "codex-local",
      "grok-local",
    ]);
  });

  describe("§4 exhaustion escalation config", () => {
    it("defaults retryAfterMinutesDefault to 60 and boardEscalation to enabled/approval", () => {
      const resolved = builtinDefaultProviderFallbackPolicy();
      expect(resolved.retryAfterMinutesDefault).toBe(60);
      expect(resolved.boardEscalation).toEqual({ enabled: true, notifyKind: "approval" });
    });

    it("parses limitDetection.retryAfterMinutesDefault and boardEscalation", () => {
      const resolved = parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: {
          default: { chain: [{ id: "codex-local", adapter: "codex_local" }] },
          limitDetection: { retryAfterMinutesDefault: 120 },
          boardEscalation: { enabled: false, notifyKind: "digest" },
        },
      });
      expect(resolved.retryAfterMinutesDefault).toBe(120);
      expect(resolved.boardEscalation).toEqual({ enabled: false, notifyKind: "digest" });
    });

    it("omitting limitDetection/boardEscalation keeps the spec defaults", () => {
      const resolved = parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: { default: { chain: [{ id: "codex-local", adapter: "codex_local" }] } },
      });
      expect(resolved.retryAfterMinutesDefault).toBe(60);
      expect(resolved.boardEscalation).toEqual({ enabled: true, notifyKind: "approval" });
    });

    it("defaults accountCooldown.enabled to true and honours an explicit override", () => {
      const def = parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: { default: { chain: [{ id: "codex-local", adapter: "codex_local" }] } },
      });
      expect(def.accountCooldown).toEqual({ enabled: true });

      const off = parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: {
          default: { chain: [{ id: "codex-local", adapter: "codex_local" }] },
          accountCooldown: { enabled: false },
        },
      });
      expect(off.accountCooldown).toEqual({ enabled: false });
    });

    it("rejects an out-of-range retryAfterMinutesDefault", () => {
      expect(() =>
        parseProviderFallbackPolicy({
          schemaVersion: "1",
          providerFallback: {
            default: { chain: [{ id: "codex-local", adapter: "codex_local" }] },
            limitDetection: { retryAfterMinutesDefault: 0 },
          },
        }),
      ).toThrow(/retryAfterMinutesDefault must be an integer/);
      expect(() =>
        parseProviderFallbackPolicy({
          schemaVersion: "1",
          providerFallback: {
            default: { chain: [{ id: "codex-local", adapter: "codex_local" }] },
            limitDetection: { retryAfterMinutesDefault: 1441 },
          },
        }),
      ).toThrow(/retryAfterMinutesDefault must be an integer/);
    });

    it("rejects an unknown notifyKind", () => {
      expect(() =>
        parseProviderFallbackPolicy({
          schemaVersion: "1",
          providerFallback: {
            default: { chain: [{ id: "codex-local", adapter: "codex_local" }] },
            boardEscalation: { notifyKind: "telegram" },
          },
        }),
      ).toThrow(/notifyKind must be one of/);
    });

    it("resolveProviderFallbackEscalation returns the resolved company-wide settings", () => {
      const resolved = parseProviderFallbackPolicy({
        schemaVersion: "1",
        providerFallback: {
          default: { chain: [{ id: "codex-local", adapter: "codex_local" }] },
          limitDetection: { retryAfterMinutesDefault: 30 },
          boardEscalation: { enabled: true, notifyKind: "wake" },
        },
      });
      const escalation = resolveProviderFallbackEscalation("any-company", resolved);
      expect(escalation.retryAfterMinutesDefault).toBe(30);
      expect(escalation.boardEscalation).toEqual({ enabled: true, notifyKind: "wake" });
    });
  });



  describe("enforceFallbackAdapterCommand (ELI-856 cross-adapter command)", () => {
    it("forces the Grok command instead of inheriting claude when fallback adapter is grok_local", () => {
      const config = enforceFallbackAdapterCommand({
        config: { command: "claude", env: { CLAUDE_CONFIG_DIR: "/paperclip/claude-accounts/personal" } },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterCommand: "/paperclip/.grok/bin/grok",
      });

      expect(config.command).toBe("/paperclip/.grok/bin/grok");
      // unrelated keys are preserved
      expect(config.env).toEqual({ CLAUDE_CONFIG_DIR: "/paperclip/claude-accounts/personal" });
    });

    it("forces the configured Codex command when fallback adapter is codex_local", () => {
      const config = enforceFallbackAdapterCommand({
        config: { command: "claude" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "codex_local",
        fallbackAdapterCommand: "/paperclip/.codex/bin/codex",
      });

      expect(config.command).toBe("/paperclip/.codex/bin/codex");
    });

    it("removes inherited claude command when a cross-adapter fallback has no command override", () => {
      const config = enforceFallbackAdapterCommand({
        config: { command: "claude" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "grok_local",
        fallbackAdapterCommand: null,
      });

      expect(config.command).toBeUndefined();
    });

    it("preserves the base command for a same-family claude_local fallback hop", () => {
      const config = enforceFallbackAdapterCommand({
        config: { command: "claude", env: { CLAUDE_CONFIG_DIR: "/paperclip/claude-accounts/aflabox" } },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: "claude_local",
        fallbackAdapterCommand: null,
      });

      expect(config.command).toBe("claude");
    });

    it("is a no-op when there is no fallback selection", () => {
      const config = enforceFallbackAdapterCommand({
        config: { command: "claude" },
        agentAdapterType: "claude_local",
        selectedFallbackAdapterType: null,
        fallbackAdapterCommand: null,
      });

      expect(config.command).toBe("claude");
    });
  });

  describe("selectNextProviderFallbackEntry", () => {
    const chain = builtinDefaultProviderFallbackPolicy().default.chain;

    it("starts after the agent's primary adapter when no prior fallback selection", () => {
      const next = selectNextProviderFallbackEntry({
        chain,
        currentId: null,
        currentAdapterType: "claude_local",
      });
      expect(next?.id).toBe("claude-code-aflabox");
    });

    it("rotates to the next chain entry on the second fallback", () => {
      const next = selectNextProviderFallbackEntry({
        chain,
        currentId: "claude-code-aflabox",
        currentAdapterType: "claude_local",
      });
      expect(next?.id).toBe("codex-local");
    });

    it("returns null when the chain is exhausted", () => {
      const next = selectNextProviderFallbackEntry({
        chain,
        currentId: "grok-local",
        currentAdapterType: "grok_local",
      });
      expect(next).toBeNull();
    });

    it("skips disabled entries", () => {
      const customChain = chain.map((entry) =>
        entry.id === "claude-code-aflabox" ? { ...entry, enabled: false } : entry,
      );
      const next = selectNextProviderFallbackEntry({
        chain: customChain,
        currentId: null,
        currentAdapterType: "claude_local",
      });
      expect(next?.id).toBe("codex-local");
    });
  });
});
