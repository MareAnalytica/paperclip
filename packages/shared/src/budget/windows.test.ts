import { describe, expect, it } from "vitest";
import {
  calendarWindowBounds,
  currentCalendarWindow,
  isCalendarWindow,
  isRollingWindow,
  rollingWindowBounds,
  BUDGET_WINDOWS,
} from "./windows.js";

describe("calendarWindowBounds (UTC-anchored, half-open)", () => {
  it("truncates minute/hour/day to UTC boundaries with matching keys", () => {
    const at = new Date("2026-06-03T15:30:45.123Z");

    expect(calendarWindowBounds("minute", at)).toEqual({
      windowStart: new Date("2026-06-03T15:30:00.000Z"),
      windowEnd: new Date("2026-06-03T15:31:00.000Z"),
      windowKey: "minute:20260603T153000",
    });
    expect(calendarWindowBounds("hour", at)).toEqual({
      windowStart: new Date("2026-06-03T15:00:00.000Z"),
      windowEnd: new Date("2026-06-03T16:00:00.000Z"),
      windowKey: "hour:20260603T150000",
    });
    expect(calendarWindowBounds("day", at)).toEqual({
      windowStart: new Date("2026-06-03T00:00:00.000Z"),
      windowEnd: new Date("2026-06-04T00:00:00.000Z"),
      windowKey: "day:20260603T000000",
    });
  });

  it("anchors week to Monday 00:00 UTC (matches Postgres date_trunc('week'))", () => {
    // Wednesday and the following Sunday both fold to Monday 2026-06-01.
    for (const iso of ["2026-06-03T15:30:45Z", "2026-06-07T12:00:00Z", "2026-06-01T00:00:00Z"]) {
      const b = calendarWindowBounds("week", new Date(iso));
      expect(b.windowStart.toISOString()).toBe("2026-06-01T00:00:00.000Z");
      expect(b.windowEnd.toISOString()).toBe("2026-06-08T00:00:00.000Z");
      expect(b.windowStart.getUTCDay()).toBe(1); // Monday
      expect(b.windowKey).toBe("week:20260601T000000");
    }
    // The next Monday opens a new bucket.
    expect(calendarWindowBounds("week", new Date("2026-06-08T00:00:00Z")).windowKey).toBe(
      "week:20260608T000000",
    );
  });

  it("handles month length and year rollover", () => {
    const june = calendarWindowBounds("month", new Date("2026-06-15T09:00:00Z"));
    expect(june.windowStart.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(june.windowEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(june.windowKey).toBe("month:20260601T000000");

    const dec = calendarWindowBounds("month", new Date("2026-12-31T23:59:59Z"));
    expect(dec.windowStart.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(dec.windowEnd.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("produces half-open buckets: end of one window is the start of the next", () => {
    const a = calendarWindowBounds("day", new Date("2026-06-03T23:59:59.999Z"));
    const b = calendarWindowBounds("day", new Date("2026-06-04T00:00:00.000Z"));
    expect(a.windowEnd.getTime()).toBe(b.windowStart.getTime());
    expect(a.windowKey).not.toBe(b.windowKey);
  });
});

describe("currentCalendarWindow (boundaryGraceSeconds, §5)", () => {
  it("keeps the just-closed window current during the grace period", () => {
    const justAfterMidnight = new Date("2026-06-03T00:00:30Z");
    const graced = currentCalendarWindow("day", justAfterMidnight, 60);
    // 30s < 60s grace → still the previous (June 2) bucket.
    expect(graced.windowKey).toBe("day:20260602T000000");
  });

  it("advances to the new window once the grace elapses", () => {
    const afterGrace = new Date("2026-06-03T00:02:00Z");
    expect(currentCalendarWindow("day", afterGrace, 60).windowKey).toBe("day:20260603T000000");
  });

  it("with zero grace always returns the containing window", () => {
    const justAfterMidnight = new Date("2026-06-03T00:00:30Z");
    expect(currentCalendarWindow("day", justAfterMidnight, 0).windowKey).toBe("day:20260603T000000");
  });

  it("grace only affects the bucket near its own boundary, not mid-window", () => {
    const midDay = new Date("2026-06-03T12:00:00Z");
    expect(currentCalendarWindow("day", midDay, 300).windowKey).toBe("day:20260603T000000");
  });
});

describe("rollingWindowBounds (trailing, §5)", () => {
  const now = new Date("2026-06-03T15:30:00Z");

  it("computes trailing windows ending at now", () => {
    expect(rollingWindowBounds("rolling_24h", now)).toEqual({
      windowStart: new Date("2026-06-02T15:30:00Z"),
      windowEnd: now,
    });
    expect(rollingWindowBounds("rolling_7d", now)).toEqual({
      windowStart: new Date("2026-05-27T15:30:00Z"),
      windowEnd: now,
    });
    expect(rollingWindowBounds("rolling_30d", now)).toEqual({
      windowStart: new Date("2026-05-04T15:30:00Z"),
      windowEnd: now,
    });
  });

  it("treats total as lifetime (open start)", () => {
    expect(rollingWindowBounds("total", now)).toEqual({ windowStart: null, windowEnd: now });
  });
});

describe("window classification", () => {
  it("partitions the enum into calendar + rolling + total", () => {
    expect(isCalendarWindow("day")).toBe(true);
    expect(isCalendarWindow("rolling_24h")).toBe(false);
    expect(isRollingWindow("rolling_7d")).toBe(true);
    expect(isRollingWindow("month")).toBe(false);
    expect(BUDGET_WINDOWS).toContain("total");
    expect(BUDGET_WINDOWS).toHaveLength(9);
  });
});
