import { describe, expect, it } from "vitest";
import {
  amountToMicros,
  BILLING_REVIEW_CODE,
  invoiceVariance,
  isDayLocked,
  reconcileInvoice,
  type CostEventsCell,
  type InvoiceLine,
} from "./invoice-reconcile.js";
import { parseInvoice } from "./invoice-formats.js";

// Locked-day clock: well past 2026-06-01 + 48h.
const NOW = Date.parse("2026-06-10T06:00:00Z");
const opts = (over: Partial<Parameters<typeof reconcileInvoice>[2]> = {}) => ({
  now: NOW,
  pricebook: { invoiceVariancePercent: 3, invoiceDayLockDelayHours: 48, currency: "USD" },
  ...over,
});

describe("invoiceVariance", () => {
  it("is 0 when both sides are 0, Infinity with no baseline, else abs percent", () => {
    expect(invoiceVariance(0, 0, 3).variancePercent).toBe(0);
    expect(invoiceVariance(0, 5, 3).variancePercent).toBe(Infinity);
    expect(invoiceVariance(0, 5, 3).overThreshold).toBe(true);
    expect(invoiceVariance(100, 105, 3).variancePercent).toBeCloseTo(5);
    expect(invoiceVariance(100, 102, 3).overThreshold).toBe(false); // 2% ≤ 3%
    expect(invoiceVariance(100, 103, 3).overThreshold).toBe(false); // strict >, so exactly 3% is within
  });
});

describe("amountToMicros", () => {
  it("rounds major units to micros and rejects non-finite", () => {
    expect(amountToMicros(1)).toBe(1_000_000);
    expect(amountToMicros(0.000001)).toBe(1);
    expect(() => amountToMicros(Number.NaN)).toThrow();
  });
});

describe("isDayLocked", () => {
  it("locks only once delayHours past the UTC end of the day", () => {
    expect(isDayLocked("2026-06-01", NOW, 48)).toBe(true);
    // 2026-06-09 ends 06-10T00:00Z; +48h = 06-12T00:00Z, after NOW → not locked.
    expect(isDayLocked("2026-06-09", NOW, 48)).toBe(false);
  });
});

describe("parseInvoice", () => {
  it("parses an anthropic CSV with aliased headers + currency symbols", () => {
    const csv = [
      "usage_date,model_id,cost_usd,request_id",
      "2026-06-01,claude-opus-4-8,\"$1,234.50\",req-a",
      "2026-06-01,claude-opus-4-8,10.00,req-b",
    ].join("\n");
    const lines = parseInvoice(csv, { vendor: "anthropic", format: "csv" });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-8",
      day: "2026-06-01",
      amountMicros: 1_234_500_000,
      requestId: "req-a",
    });
  });

  it("parses an openai JSON wrapper object and normalizes timestamps to UTC days", () => {
    const json = JSON.stringify({
      data: [{ timestamp: "2026-06-01T18:22:00Z", model: "gpt-4o", amount: 2.5, id: "oa-1" }],
    });
    const lines = parseInvoice(json, { vendor: "openai", format: "json" });
    expect(lines[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      day: "2026-06-01",
      amountMicros: 2_500_000,
      requestId: "oa-1",
    });
  });
});

describe("reconcileInvoice", () => {
  const cost: CostEventsCell[] = [
    { provider: "anthropic", model: "claude-opus-4-8", day: "2026-06-01", expectedMicros: 1_000_000, requestIds: ["ce-1", "ce-2"] },
  ];

  it("emits a subtask for an over-threshold locked cell with sample requestIds", () => {
    const invoice: InvoiceLine[] = [
      { provider: "anthropic", model: "claude-opus-4-8", day: "2026-06-01", amountMicros: 1_100_000, requestId: "inv-1" },
    ];
    const r = reconcileInvoice(invoice, cost, opts());
    expect(r.subtasks).toHaveLength(1);
    const s = r.subtasks[0];
    expect(s.billingCode).toBe(BILLING_REVIEW_CODE);
    expect(s.variancePercent).toBeCloseTo(10);
    expect(s.sampleRequestIds).toEqual(["ce-1", "ce-2", "inv-1"]); // cost_events ids first
    expect(s.title).toContain("anthropic/claude-opus-4-8");
    expect(s.body).toContain("§6.3");
  });

  it("keeps a within-threshold locked cell out of subtasks", () => {
    const invoice: InvoiceLine[] = [
      { provider: "anthropic", model: "claude-opus-4-8", day: "2026-06-01", amountMicros: 1_020_000 },
    ];
    const r = reconcileInvoice(invoice, cost, opts());
    expect(r.subtasks).toHaveLength(0);
    expect(r.withinThreshold).toHaveLength(1);
  });

  it("defers a not-yet-locked day and never emits it", () => {
    const invoice: InvoiceLine[] = [
      { provider: "anthropic", model: "claude-opus-4-8", day: "2026-06-09", amountMicros: 9_000_000 },
    ];
    const r = reconcileInvoice(invoice, [], opts());
    expect(r.subtasks).toHaveLength(0);
    expect(r.deferred.map((c) => c.day)).toEqual(["2026-06-09"]);
  });

  it("flags an invoiced cell with no cost_events baseline (Infinity variance)", () => {
    const invoice: InvoiceLine[] = [
      { provider: "openai", model: "gpt-4o", day: "2026-06-01", amountMicros: 5_000_000, requestId: "x" },
    ];
    const r = reconcileInvoice(invoice, [], opts());
    expect(r.subtasks).toHaveLength(1);
    expect(r.subtasks[0].variancePercent).toBe(Infinity);
    expect(r.subtasks[0].title).toContain("no cost_events baseline");
  });

  it("respects a per-call threshold override", () => {
    const invoice: InvoiceLine[] = [
      { provider: "anthropic", model: "claude-opus-4-8", day: "2026-06-01", amountMicros: 1_100_000 },
    ];
    expect(reconcileInvoice(invoice, cost, opts({ thresholdPercent: 20 })).subtasks).toHaveLength(0);
  });
});
