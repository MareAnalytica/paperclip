import { describe, expect, it } from "vitest";

import {
  activeCooledDownProviderIds,
  computeProviderCooldownRecord,
  pickRootRunProviderSelection,
  type CooldownChainEntry,
} from "../services/provider-account-cooldown.ts";

const NOW = new Date("2026-06-01T12:00:00.000Z");

const CHAIN: CooldownChainEntry[] = [
  { id: "claude-code-personal", adapter: "claude_local", enabled: true, account: "personal", adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/personal" } } },
  { id: "claude-code-aflabox", adapter: "claude_local", enabled: true, account: "aflabox", adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/aflabox" } } },
  { id: "grok-local", adapter: "grok_local", enabled: true, account: null, adapterConfig: null },
  { id: "codex-local", adapter: "codex_local", enabled: true, account: null, adapterConfig: null },
];

// Acceptance #1 — cooldown is recorded from a limit error.
describe("computeProviderCooldownRecord", () => {
  it("honours a provider-supplied reset window", () => {
    const reset = new Date(NOW.getTime() + 90 * 60_000);
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: reset,
      now: NOW,
      retryAfterMinutesDefault: 60,
    });
    expect(record).toEqual({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      cooldownUntil: reset,
      source: "provider_header",
    });
  });

  it("falls back to retryAfterMinutesDefault when no reset is supplied", () => {
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: null,
      now: NOW,
      retryAfterMinutesDefault: 30,
    });
    expect(record?.source).toBe("retryAfterMinutesDefault");
    expect(record?.cooldownUntil).toEqual(new Date(NOW.getTime() + 30 * 60_000));
  });

  it("treats a past reset as no signal and uses the default back-off", () => {
    const past = new Date(NOW.getTime() - 5 * 60_000);
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: past,
      now: NOW,
      retryAfterMinutesDefault: 60,
    });
    expect(record?.source).toBe("retryAfterMinutesDefault");
    expect(record?.cooldownUntil).toEqual(new Date(NOW.getTime() + 60 * 60_000));
  });

  it("returns null without a provider id", () => {
    expect(
      computeProviderCooldownRecord({
        providerId: null,
        adapterType: "claude_local",
        account: null,
        failedProviderReset: null,
        now: NOW,
        retryAfterMinutesDefault: 60,
      }),
    ).toBeNull();
  });
});

// Acceptance #3 — a provider is eligible again once its window elapses.
describe("activeCooledDownProviderIds", () => {
  it("keeps only providers whose window is still in the future", () => {
    const rows = [
      { providerId: "claude-code-personal", cooldownUntil: new Date(NOW.getTime() + 60_000) },
      { providerId: "claude-code-aflabox", cooldownUntil: new Date(NOW.getTime() - 60_000) },
    ];
    const active = activeCooledDownProviderIds(rows, NOW);
    expect([...active]).toEqual(["claude-code-personal"]);
  });

  it("returns empty when every window has elapsed", () => {
    const rows = [
      { providerId: "claude-code-personal", cooldownUntil: new Date(NOW.getTime() - 1) },
    ];
    expect(activeCooledDownProviderIds(rows, NOW).size).toBe(0);
  });
});

// Acceptance #2 — a new root run skips the cooled-down provider.
describe("pickRootRunProviderSelection", () => {
  it("returns null (use primary) when the primary is healthy", () => {
    expect(
      pickRootRunProviderSelection({
        chain: CHAIN,
        adapterType: "claude_local",
        cooledDownProviderIds: new Set(["grok-local"]),
      }),
    ).toBeNull();
  });

  it("skips a cooled-down primary to the next healthy provider", () => {
    const pick = pickRootRunProviderSelection({
      chain: CHAIN,
      adapterType: "claude_local",
      cooledDownProviderIds: new Set(["claude-code-personal"]),
    });
    expect(pick?.id).toBe("claude-code-aflabox");
    expect(pick?.account).toBe("aflabox");
  });

  it("walks past multiple cooled-down providers in chain order", () => {
    const pick = pickRootRunProviderSelection({
      chain: CHAIN,
      adapterType: "claude_local",
      cooledDownProviderIds: new Set(["claude-code-personal", "claude-code-aflabox"]),
    });
    expect(pick?.id).toBe("grok-local");
  });

  it("returns null when every provider is cooling down (do not block the run)", () => {
    expect(
      pickRootRunProviderSelection({
        chain: CHAIN,
        adapterType: "claude_local",
        cooledDownProviderIds: new Set(CHAIN.map((e) => e.id)),
      }),
    ).toBeNull();
  });

  it("ignores disabled entries when choosing the fallback", () => {
    const chain: CooldownChainEntry[] = [
      { ...CHAIN[0] },
      { ...CHAIN[1], enabled: false },
      { ...CHAIN[2] },
    ];
    const pick = pickRootRunProviderSelection({
      chain,
      adapterType: "claude_local",
      cooledDownProviderIds: new Set(["claude-code-personal"]),
    });
    expect(pick?.id).toBe("grok-local");
  });
});
