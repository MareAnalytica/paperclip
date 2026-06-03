import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBurnHint,
  recordPreflightResult,
  recordChargeResult,
  __resetBurnHintCacheForTests,
} from "./burn-hint.js";
import { withBudget } from "./cost.js";
import type { AdapterExecutionContext } from "./types.js";

const allow = (over: Record<string, unknown> = {}) => ({
  decision: "allow",
  bindingCapId: null,
  headroomMicros: 1_000_000,
  softHeadroomMicros: 1_000_000,
  warnings: [],
  approvalIds: [],
  evaluationTimedOut: false,
  preflightRequired: false,
  ...over,
});

describe("burn-hint cache (ELI-943)", () => {
  beforeEach(() => __resetBurnHintCacheForTests());

  it("returns null for unknown company and after TTL expiry", () => {
    expect(getBurnHint("c-none")).toBeNull();
    recordPreflightResult("c1", allow({ warnings: [{ capId: "cap", percent: 90 }] }), 1000, 0);
    expect(getBurnHint("c1", 500)?.capUsedPercent).toBe(90);
    expect(getBurnHint("c1", 1001)).toBeNull(); // expired at now=1001 (>= 0+1000)
  });

  it("stores the most-binding (max) warning percent", () => {
    recordPreflightResult(
      "c1",
      allow({ warnings: [{ capId: "a", percent: 42 }, { capId: "b", percent: 88 }, { capId: "c", percent: 71 }] }),
      60_000,
      0,
    );
    expect(getBurnHint("c1", 1)?.capUsedPercent).toBe(88);
  });

  it("no warnings → percent null (healthy cap, safe-by-default)", () => {
    recordPreflightResult("c1", allow({ warnings: [], preflightRequired: false }), 60_000, 0);
    const h = getBurnHint("c1", 1);
    expect(h?.capUsedPercent).toBeNull();
    expect(h?.preflightRequired).toBe(false);
  });

  it("preflightRequired from server is retained as a force hint", () => {
    recordPreflightResult("c1", allow({ warnings: [], preflightRequired: true }), 60_000, 0);
    expect(getBurnHint("c1", 1)?.preflightRequired).toBe(true);
  });

  it("charge with a fired alert asserts preflightRequired; clean charge is a no-op", () => {
    // clean charge does not create or extend a hint
    recordChargeResult("c1", { alertsFired: [] }, 60_000, 0);
    expect(getBurnHint("c1", 1)).toBeNull();

    // a fired alert forces the next call to preflight, preserving any prior percent
    recordPreflightResult("c1", allow({ warnings: [{ capId: "a", percent: 60 }] }), 60_000, 0);
    recordChargeResult("c1", { alertsFired: ["pause_writes"] as any }, 60_000, 1);
    const h = getBurnHint("c1", 2);
    expect(h?.preflightRequired).toBe(true);
    expect(h?.capUsedPercent).toBe(60);
  });

  it("ignores empty companyId on read and write", () => {
    recordPreflightResult("", allow({ warnings: [{ capId: "a", percent: 99 }] }), 60_000, 0);
    expect(getBurnHint("", 1)).toBeNull();
    expect(getBurnHint(null, 1)).toBeNull();
  });
});

describe("withBudget burn-hint arming (ELI-943 end-to-end)", () => {
  const base = "http://api.test";
  const ctx = {
    runId: "run-xyz",
    agent: { id: "agent-1", companyId: "company-abc", name: "t", adapterType: null, adapterConfig: {} },
    authToken: "ctx-tok",
  } as unknown as AdapterExecutionContext;

  beforeEach(() => __resetBurnHintCacheForTests());

  it("AC1/AC default: a cheap call skips preflight until a prior response flags a critical cap, then forces a real roundtrip", async () => {
    // Round 1: an expensive call returns warnings showing the most-binding cap at 92%.
    const fetchMock = vi
      .fn()
      // preflight roundtrip for the expensive call
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify(allow({ warnings: [{ capId: "cap-1", percent: 92 }], preflightRequired: true })),
      })
      // preflight roundtrip forced for the *cheap* call (the whole point of ELI-943) — denies
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify(allow({ decision: "deny", bindingCapId: "cap-1", headroomMicros: 0, softHeadroomMicros: 0, preflightRequired: true })),
      });

    // Round 1: expensive estimate (>= threshold) → real preflight, seeds the cache.
    await withBudget(
      ctx,
      async (b) => {
        await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 60_000 });
      },
      { apiBase: base, fetchImpl: fetchMock as any, preflight: { estimateThresholdMicros: 50_000, forcePreflightAbovePercent: 80 } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Round 2: a CHEAP estimate (below threshold). Without the hint this would skip
    // preflight entirely. With the cached 92% it must force a real roundtrip and can deny.
    const decision = await withBudget(
      ctx,
      async (b) => {
        const p = await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 10 });
        return p.decision;
      },
      { apiBase: base, fetchImpl: fetchMock as any, preflight: { estimateThresholdMicros: 50_000, forcePreflightAbovePercent: 80 } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decision).toBe("deny");

    // The hint is client-only: the forced preflight body must NOT carry capUsedPercent/forcePreflight.
    const [, init] = fetchMock.mock.calls[1];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("capUsedPercent");
    expect(body).not.toHaveProperty("forcePreflight");
  });

  it("AC3 default unchanged: with no burn signal, a cheap call does no preflight roundtrip", async () => {
    const fetchMock = vi.fn();
    await withBudget(
      ctx,
      async (b) => {
        await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 10 });
      },
      { apiBase: base, fetchImpl: fetchMock as any, preflight: { estimateThresholdMicros: 50_000, forcePreflightAbovePercent: 80 } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a sub-critical cached percent (below forcePreflightAbovePercent) does NOT force a cheap preflight", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify(allow({ warnings: [{ capId: "cap-1", percent: 65 }] })),
      });
    // Seed cache at 65% via an expensive call.
    await withBudget(
      ctx,
      async (b) => {
        await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 60_000 });
      },
      { apiBase: base, fetchImpl: fetchMock as any, preflight: { estimateThresholdMicros: 50_000, forcePreflightAbovePercent: 80 } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Cheap call: 65% < 80% and no preflightRequired → still skips the roundtrip.
    await withBudget(
      ctx,
      async (b) => {
        await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 10 });
      },
      { apiBase: base, fetchImpl: fetchMock as any, preflight: { estimateThresholdMicros: 50_000, forcePreflightAbovePercent: 80 } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // unchanged — no forced preflight
  });

  it("burnHint.enabled=false disables the arming (back to dormant behavior)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify(allow({ warnings: [{ capId: "cap-1", percent: 95 }], preflightRequired: true })),
      });
    await withBudget(
      ctx,
      async (b) => {
        await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 60_000 });
      },
      { apiBase: base, fetchImpl: fetchMock as any, burnHint: { enabled: false }, preflight: { estimateThresholdMicros: 50_000 } },
    );
    // Cheap call with hint disabled → no cache consulted, no forced roundtrip.
    await withBudget(
      ctx,
      async (b) => {
        await b.preflightIfRequired({ provider: "anthropic", model: "claude", estimatedCostMicros: 10 });
      },
      { apiBase: base, fetchImpl: fetchMock as any, burnHint: { enabled: false }, preflight: { estimateThresholdMicros: 50_000 } },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
