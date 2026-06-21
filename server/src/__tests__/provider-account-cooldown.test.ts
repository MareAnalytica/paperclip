import { describe, expect, it } from "vitest";
import { extractProviderResetTimestamp } from "@paperclipai/adapter-utils";

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

  // ELI-1076 — a `provider_disabled` block (no reset) parks on the dedicated long
  // window, NOT the transient retryAfterMinutesDefault.
  it("uses the dedicated provider_disabled window for a provider_disabled failure", () => {
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: null,
      now: NOW,
      retryAfterMinutesDefault: 60,
      errorFamily: "provider_disabled",
      providerDisabledCooldownMinutes: 1440,
    });
    expect(record?.source).toBe("provider_disabled");
    expect(record?.cooldownUntil).toEqual(new Date(NOW.getTime() + 1440 * 60_000));
  });

  // Regression — a transient/limit failure is unchanged even when the long window
  // is supplied: only the provider_disabled family selects it.
  it("keeps the transient default window for a non-disabled family", () => {
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: null,
      now: NOW,
      retryAfterMinutesDefault: 60,
      errorFamily: "transient_upstream",
      providerDisabledCooldownMinutes: 1440,
    });
    expect(record?.source).toBe("retryAfterMinutesDefault");
    expect(record?.cooldownUntil).toEqual(new Date(NOW.getTime() + 60 * 60_000));
  });

  // An explicit provider-supplied reset still wins over the disabled window — the
  // header reset is the most authoritative signal regardless of family.
  it("honours an explicit future reset over the provider_disabled window", () => {
    const reset = new Date(NOW.getTime() + 15 * 60_000);
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: reset,
      now: NOW,
      retryAfterMinutesDefault: 60,
      errorFamily: "provider_disabled",
      providerDisabledCooldownMinutes: 1440,
    });
    expect(record?.source).toBe("provider_header");
    expect(record?.cooldownUntil).toEqual(reset);
  });

  // Defensive — a provider_disabled family without a configured long window falls
  // back to the transient default rather than yielding a shorter/zero window.
  it("falls back to the transient default when no disabled window is configured", () => {
    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset: null,
      now: NOW,
      retryAfterMinutesDefault: 60,
      errorFamily: "provider_disabled",
    });
    expect(record?.source).toBe("provider_disabled");
    expect(record?.cooldownUntil).toEqual(new Date(NOW.getTime() + 60 * 60_000));
  });
});

// ELI-864 end-to-end: a real provider limit message is parsed to its reset
// timestamp (not the short default) and the cooldown is recorded until then.
// This is the synthetic verification of the parse → cooldown-record chain that
// the heartbeat performs on a provider-fallback-eligible failure.
describe("provider limit message → cooldown record (ELI-864)", () => {
  it("records the real weekly reset for a Claude-style limit message", () => {
    const failedProviderReset = extractProviderResetTimestamp(
      "weekly limit · resets Jun 7, 2am (UTC)",
      NOW,
    );
    expect(failedProviderReset?.toISOString()).toBe("2026-06-07T02:00:00.000Z");

    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset,
      now: NOW,
      retryAfterMinutesDefault: 60,
    });
    // The honoured weekly window — days out, not a ~60-minute default back-off.
    expect(record?.source).toBe("provider_header");
    expect(record?.cooldownUntil.toISOString()).toBe("2026-06-07T02:00:00.000Z");
  });

  it("records the real reset for a generic provider 'try again at' message", () => {
    const failedProviderReset = extractProviderResetTimestamp(
      "Quota exhausted for this account. Available again 2026-06-07T02:00:00Z.",
      NOW,
    );
    const record = computeProviderCooldownRecord({
      providerId: "minimax-local",
      adapterType: "opencode_local",
      account: null,
      failedProviderReset,
      now: NOW,
      retryAfterMinutesDefault: 60,
    });
    expect(record?.source).toBe("provider_header");
    expect(record?.cooldownUntil.toISOString()).toBe("2026-06-07T02:00:00.000Z");
  });

  it("preserves the default back-off when the limit message has no parseable reset", () => {
    const failedProviderReset = extractProviderResetTimestamp(
      "You are out of extra usage. Try again later.",
      NOW,
    );
    expect(failedProviderReset).toBeNull();

    const record = computeProviderCooldownRecord({
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      failedProviderReset,
      now: NOW,
      retryAfterMinutesDefault: 60,
    });
    expect(record?.source).toBe("retryAfterMinutesDefault");
    expect(record?.cooldownUntil).toEqual(new Date(NOW.getTime() + 60 * 60_000));
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
