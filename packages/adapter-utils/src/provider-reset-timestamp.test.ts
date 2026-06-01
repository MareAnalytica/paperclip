import { describe, it, expect } from "vitest";
import {
  parseProviderResetTimestamp,
  extractProviderResetTimestamp,
  normalizeResetTimeZone,
} from "./provider-reset-timestamp.js";

describe("parseProviderResetTimestamp", () => {
  it("parses a bare ISO-8601 reset instant", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(parseProviderResetTimestamp("2026-06-07T02:00:00Z", now)?.toISOString()).toBe(
      "2026-06-07T02:00:00.000Z",
    );
  });

  it("honours a dated weekly reset instead of rolling to tomorrow (ELI-864 core)", () => {
    // The bug: "Jun 7, 2am" used to fail the clock-only parser and fall back to
    // the default 60-min window. It must now land on the real reset day.
    const now = new Date("2026-06-01T12:00:00.000Z");
    expect(parseProviderResetTimestamp("Jun 7, 2am", now, "UTC")?.toISOString()).toBe(
      "2026-06-07T02:00:00.000Z",
    );
  });

  it("parses a fully-qualified date with explicit year and 24h time", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(parseProviderResetTimestamp("June 7 2026 02:00", now, "UTC")?.toISOString()).toBe(
      "2026-06-07T02:00:00.000Z",
    );
  });

  it("picks next year for a dateless-year reset already passed this year", () => {
    const now = new Date("2026-12-31T00:00:00.000Z");
    expect(parseProviderResetTimestamp("Jan 2, 3am", now, "UTC")?.toISOString()).toBe(
      "2027-01-02T03:00:00.000Z",
    );
  });

  it("parses a numeric month/day reset", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(parseProviderResetTimestamp("6/7 2pm", now, "UTC")?.toISOString()).toBe(
      "2026-06-07T14:00:00.000Z",
    );
  });

  it("parses a clock-only reset in its timezone on the same day", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    expect(parseProviderResetTimestamp("4pm", now, "America/Chicago")?.toISOString()).toBe(
      "2026-04-22T21:00:00.000Z",
    );
  });

  it("rolls a clock-only reset to tomorrow when already past", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    expect(parseProviderResetTimestamp("3:15 AM", now, "UTC")?.toISOString()).toBe(
      "2026-04-23T03:15:00.000Z",
    );
  });

  it("reads an inline parenthesised timezone when no hint is passed", () => {
    const now = new Date("2026-04-23T03:29:02.000Z");
    expect(parseProviderResetTimestamp("11:31 PM (America/Chicago)", now)?.toISOString()).toBe(
      "2026-04-23T04:31:00.000Z",
    );
  });

  it("returns null when nothing parseable is present", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(parseProviderResetTimestamp("later today", now)).toBeNull();
    expect(parseProviderResetTimestamp("", now)).toBeNull();
  });
});

describe("extractProviderResetTimestamp (generic provider scanner)", () => {
  it("extracts a Claude-style weekly reset with a date from free text", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    expect(
      extractProviderResetTimestamp("weekly limit · resets Jun 7, 2am (UTC)", now)?.toISOString(),
    ).toBe("2026-06-07T02:00:00.000Z");
  });

  it("extracts a generic 'try again at' clock window", () => {
    const now = new Date("2026-04-22T15:00:00.000Z");
    expect(
      extractProviderResetTimestamp("Rate limited. Try again at 9:00 PM (UTC).", now)?.toISOString(),
    ).toBe("2026-04-22T21:00:00.000Z");
  });

  it("extracts a generic 'available again' ISO timestamp", () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    expect(
      extractProviderResetTimestamp(
        "Quota exhausted. Available again 2026-06-07T02:00:00Z.",
        now,
      )?.toISOString(),
    ).toBe("2026-06-07T02:00:00.000Z");
  });

  it("returns null when no reset phrase is present", () => {
    expect(extractProviderResetTimestamp("Overloaded. Please retry.", new Date())).toBeNull();
    expect(extractProviderResetTimestamp(null, new Date())).toBeNull();
  });
});

describe("normalizeResetTimeZone", () => {
  it("accepts UTC/GMT and IANA zones, rejects unrecognised zones", () => {
    expect(normalizeResetTimeZone("utc")).toBe("UTC");
    expect(normalizeResetTimeZone("gmt")).toBe("UTC");
    expect(normalizeResetTimeZone("America/Chicago")).toBe("America/Chicago");
    expect(normalizeResetTimeZone("Mars/Phobos")).toBeNull();
    expect(normalizeResetTimeZone("")).toBeNull();
    expect(normalizeResetTimeZone(null)).toBeNull();
  });
});
