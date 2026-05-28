import { describe, expect, it } from "vitest";

import {
  buildProviderFallbackExhaustedReport,
  computeProviderFallbackBackoff,
  renderProviderFallbackExhaustedMarkdown,
} from "../services/provider-fallback-exhaustion.ts";

describe("computeProviderFallbackBackoff", () => {
  const now = new Date("2026-05-28T13:00:00.000Z");

  it("uses the earliest valid provider reset and reports provider_header", () => {
    const result = computeProviderFallbackBackoff({
      perProviderResets: [
        "2026-05-28T15:00:00.000Z",
        null,
        "2026-05-28T14:00:00.000Z",
        "not-a-date",
      ],
      now,
      retryAfterMinutesDefault: 60,
    });
    expect(result.nextResetSource).toBe("provider_header");
    expect(result.nextResetAt.toISOString()).toBe("2026-05-28T14:00:00.000Z");
  });

  it("falls back to now + retryAfterMinutesDefault when no provider reset is present", () => {
    const result = computeProviderFallbackBackoff({
      perProviderResets: [null, undefined, "bad"],
      now,
      retryAfterMinutesDefault: 90,
    });
    expect(result.nextResetSource).toBe("retryAfterMinutesDefault");
    expect(result.nextResetAt.toISOString()).toBe("2026-05-28T14:30:00.000Z");
  });

  it("clamps a non-positive default to 60 minutes", () => {
    const result = computeProviderFallbackBackoff({
      perProviderResets: [],
      now,
      retryAfterMinutesDefault: 0,
    });
    expect(result.nextResetAt.toISOString()).toBe("2026-05-28T14:00:00.000Z");
  });

  it("accepts Date and epoch-number resets", () => {
    const earlier = new Date("2026-05-28T13:30:00.000Z");
    const result = computeProviderFallbackBackoff({
      perProviderResets: [new Date("2026-05-28T16:00:00.000Z"), earlier.getTime()],
      now,
      retryAfterMinutesDefault: 60,
    });
    expect(result.nextResetAt.toISOString()).toBe(earlier.toISOString());
    expect(result.nextResetSource).toBe("provider_header");
  });
});

describe("renderProviderFallbackExhaustedMarkdown", () => {
  it("renders the §4 one-liner with minute precision and provider source", () => {
    const report = buildProviderFallbackExhaustedReport({
      agentNameKey: "ops",
      companyId: "eli-board",
      exhaustedProviders: ["claude-code-personal", "codex-local"],
      nextResetAt: new Date("2026-05-28T14:00:00.000Z"),
      nextResetSource: "provider_header",
    });
    expect(renderProviderFallbackExhaustedMarkdown(report)).toBe(
      "⚠️ Provider fallback exhausted — agent `ops` (eli-board). Exhausted: claude-code-personal → codex-local. Next reset: 2026-05-28T14:00Z (from provider). Work is paused for this agent until reset.",
    );
  });

  it("labels the default source and handles an empty provider list", () => {
    const report = buildProviderFallbackExhaustedReport({
      agentNameKey: "ceo",
      companyId: "eli-board",
      exhaustedProviders: [],
      nextResetAt: new Date("2026-05-28T15:30:00.000Z"),
      nextResetSource: "retryAfterMinutesDefault",
    });
    const md = renderProviderFallbackExhaustedMarkdown(report);
    expect(md).toContain("Exhausted: (none).");
    expect(md).toContain("Next reset: 2026-05-28T15:30Z (from default).");
  });
});

describe("buildProviderFallbackExhaustedReport", () => {
  it("produces the spec §4 shape and copies the provider list", () => {
    const providers = ["a", "b"];
    const report = buildProviderFallbackExhaustedReport({
      agentNameKey: "ops",
      companyId: "co",
      exhaustedProviders: providers,
      nextResetAt: new Date("2026-05-28T14:00:00.000Z"),
      nextResetSource: "provider_header",
    });
    expect(report).toEqual({
      kind: "provider_fallback_exhausted",
      agentNameKey: "ops",
      companyId: "co",
      exhaustedProviders: ["a", "b"],
      nextResetAt: "2026-05-28T14:00:00.000Z",
      nextResetSource: "provider_header",
    });
    providers.push("c");
    expect(report.exhaustedProviders).toEqual(["a", "b"]);
  });
});
