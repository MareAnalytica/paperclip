import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_EVENTS_FOR_FORECAST,
  forecastStatus,
  linearProjectedSpend,
  projectedExhaustionAt,
  recentWindowProjectedSpend,
  recentWindowSpanMs,
  resolveWindowSpan,
  type WindowSpan,
} from "../services/budget-reports.ts";

// A 100ms synthetic window [0, 100) so the projection math is exact and readable.
const span: WindowSpan = {
  windowStart: new Date(0),
  windowEnd: new Date(100),
};
const now25 = new Date(25); // 25% elapsed

describe("linearProjectedSpend (§6.1)", () => {
  it("extrapolates spend to windowEnd by elapsed fraction", () => {
    // 10 spent in the first 25% of the window → 40 projected at close.
    expect(linearProjectedSpend(10, span, now25)).toBe(40);
  });

  it("returns spend unchanged for an open-start (total) window", () => {
    expect(linearProjectedSpend(10, { windowStart: null, windowEnd: new Date(100) }, now25)).toBe(10);
  });

  it("returns spend unchanged once the window has closed", () => {
    expect(linearProjectedSpend(10, span, new Date(100))).toBe(10);
    expect(linearProjectedSpend(10, span, new Date(150))).toBe(10);
  });

  it("does not divide by zero at the window start", () => {
    expect(linearProjectedSpend(10, span, new Date(0))).toBe(10);
  });
});

describe("recentWindowProjectedSpend (§6.4)", () => {
  it("projects the trailing run-rate across the remaining window", () => {
    // recent rate 4 micros / 10ms = 0.4/ms; 75ms remaining → 10 + 30 = 40.
    expect(recentWindowProjectedSpend(10, 4, 10, span, now25)).toBe(40);
  });

  it("returns spend unchanged for open/closed windows or zero recent span", () => {
    expect(recentWindowProjectedSpend(10, 4, 10, { windowStart: null, windowEnd: new Date(100) }, now25)).toBe(10);
    expect(recentWindowProjectedSpend(10, 4, 10, span, new Date(100))).toBe(10);
    expect(recentWindowProjectedSpend(10, 4, 0, span, now25)).toBe(10);
  });
});

describe("projectedExhaustionAt (§6.4)", () => {
  it("returns the wall-clock when spend reaches the limit within the window", () => {
    // spend 10, limit 20, rate 0.4/ms → 25ms to limit → exhausts at t=50.
    const at = projectedExhaustionAt(10, 20, 0.4, span, now25);
    expect(at?.getTime()).toBe(50);
  });

  it("returns null when exhaustion lands past windowEnd (window rolls over first)", () => {
    // limit 100 at rate 0.4/ms would take 225ms — past the 100ms window end.
    expect(projectedExhaustionAt(10, 100, 0.4, span, now25)).toBeNull();
  });

  it("returns null when the run-rate is non-positive", () => {
    expect(projectedExhaustionAt(10, 100, 0, span, now25)).toBeNull();
  });

  it("returns now when already at/over the limit", () => {
    expect(projectedExhaustionAt(100, 100, 0.4, span, now25)?.getTime()).toBe(25);
  });
});

describe("forecastStatus (§4.3 ladder)", () => {
  const caps = { warnAtPercent: 60, criticalAtPercent: 80, hardStopAtPercent: 100 };
  it("maps projected percent onto the threshold ladder", () => {
    expect(forecastStatus(50, caps)).toBe("ok");
    expect(forecastStatus(60, caps)).toBe("warning");
    expect(forecastStatus(79, caps)).toBe("warning");
    expect(forecastStatus(80, caps)).toBe("critical");
    expect(forecastStatus(100, caps)).toBe("exhausted");
    expect(forecastStatus(140, caps)).toBe("exhausted");
  });
});

describe("recentWindowSpanMs (§6.4 appendix: min(2h, elapsed/4))", () => {
  it("uses elapsed/4 while the window is young", () => {
    const elapsed = 4 * 3_600_000; // 4h elapsed → quarter = 1h
    expect(recentWindowSpanMs(elapsed)).toBe(3_600_000);
  });

  it("caps at the 2h ceiling for long-elapsed windows", () => {
    const elapsed = 20 * 3_600_000; // quarter = 5h, capped to 2h
    expect(recentWindowSpanMs(elapsed)).toBe(2 * 3_600_000);
  });

  it("honors a custom ceiling override", () => {
    const elapsed = 20 * 3_600_000;
    expect(recentWindowSpanMs(elapsed, 1)).toBe(1 * 3_600_000);
  });

  it("floors at one minute for a brand-new window", () => {
    expect(recentWindowSpanMs(0)).toBe(60_000);
  });
});

describe("resolveWindowSpan", () => {
  it("returns a closed calendar window for 'month'", () => {
    const at = new Date("2026-06-15T12:00:00Z");
    const s = resolveWindowSpan("month", at);
    expect(s.windowStart?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(s.windowEnd.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("returns a trailing window ending now for a rolling window", () => {
    const at = new Date("2026-06-15T12:00:00Z");
    const s = resolveWindowSpan("rolling_24h", at);
    expect(s.windowEnd.toISOString()).toBe(at.toISOString());
    expect(s.windowStart?.toISOString()).toBe("2026-06-14T12:00:00.000Z");
  });

  it("returns an open start for 'total'", () => {
    const s = resolveWindowSpan("total", new Date("2026-06-15T12:00:00Z"));
    expect(s.windowStart).toBeNull();
  });
});

describe("defaults are config-driven constants", () => {
  it("min events for forecast default is exported", () => {
    expect(DEFAULT_MIN_EVENTS_FOR_FORECAST).toBe(5);
  });
});
