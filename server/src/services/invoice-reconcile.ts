import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, issues } from "@paperclipai/db";
import {
  parseInvoice,
  reconcileInvoice,
  type BillingReviewSubtask,
  type CostEventsCell,
  type InvoiceFormat,
  type Vendor,
} from "@paperclipai/shared";
import { issueService } from "./issues.js";

// Server glue for the budgeting-policy §6.3 vendor-invoice reconciler (ELI-937).
// The pure diff/parse logic lives in @paperclipai/shared (mirrored from the
// eli-board blueprint). This module binds it to the two things the blueprint
// library cannot own: the cost_events aggregate (the "expected" side of the
// diff) and turning each over-threshold cell into a real governance/billing
// review issue — idempotently, reusing the budget-gate dedup discipline.

/**
 * originKind stamped on every reconciliation review issue. Combined with
 * originFingerprint (`provider:model:day`) it makes issue creation idempotent:
 * a re-run for the same cell that already has an OPEN review issue is a no-op.
 * The "re-arm" is implicit — once the prior review is resolved (done/cancelled)
 * or hidden, a later run for a still-divergent cell creates a fresh one.
 */
export const INVOICE_RECONCILE_ORIGIN_KIND = "billing_reconcile";

const DEFAULT_SAMPLE_REQUEST_IDS = 10;
const CLOSED_STATUSES = ["done", "cancelled"];

/** `provider:model:day` — the (provider, model, day) cell identity. */
function cellFingerprint(provider: string, model: string, day: string): string {
  return `${provider}:${model}:${day}`;
}

export interface InvoiceReconcileRange {
  from?: Date;
  to?: Date;
}

export interface InvoiceReconcileInput extends InvoiceReconcileRange {
  vendor: Vendor;
  format: InvoiceFormat;
  /** Raw vendor invoice payload (CSV or JSON text). */
  invoice: string;
  /** Reconciliation clock; defaults to now. Injected for determinism in tests. */
  now?: Date;
  thresholdPercent?: number;
  dayLockDelayHours?: number;
  sampleRequestIdLimit?: number;
  currency?: string;
  /** Pricebook defaults for threshold + day-lock when not overridden per-call. */
  pricebook?: { invoiceVariancePercent?: number; invoiceDayLockDelayHours?: number; currency?: string };
}

export interface ReconcileIssueRef {
  id: string;
  identifier: string | null;
  cell: { provider: string; model: string; day: string };
}

export interface InvoiceReconcileSummary {
  vendor: Vendor;
  format: InvoiceFormat;
  invoiceLineCount: number;
  costEventCellCount: number;
  subtaskCount: number;
  /** Newly opened governance/billing review issues. */
  created: ReconcileIssueRef[];
  /** Cells that already had an open review issue (idempotent no-op). */
  deduped: ReconcileIssueRef[];
  withinThresholdCount: number;
  deferredCount: number;
}

export function invoiceReconcileService(db: Db) {
  const issuesSvc = issueService(db);

  /**
   * The "expected" side: SUM(cost_micros) + a bounded requestId sample, grouped
   * by (provider, model, UTC day) over the requested window. Only rows that
   * carry §2.1 micro-denominated cost are counted (legacy cents-only rows are
   * excluded so they don't masquerade as zero-cost cells).
   */
  async function aggregateCostEventsCells(
    companyId: string,
    range: InvoiceReconcileRange = {},
    sampleLimit: number = DEFAULT_SAMPLE_REQUEST_IDS,
  ): Promise<CostEventsCell[]> {
    const conditions = [
      eq(costEvents.companyId, companyId),
      isNotNull(costEvents.costMicros),
    ];
    if (range.from) conditions.push(gte(costEvents.occurredAt, range.from));
    if (range.to) conditions.push(lt(costEvents.occurredAt, range.to));

    const dayExpr = sql<string>`to_char(date_trunc('day', ${costEvents.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;

    const rows = await db
      .select({
        provider: costEvents.provider,
        model: costEvents.model,
        day: dayExpr,
        expectedMicros: sql<number>`coalesce(sum(${costEvents.costMicros}), 0)::double precision`,
        requestIds: sql<
          string[]
        >`coalesce(array_agg(${costEvents.requestId} order by ${costEvents.requestId}) filter (where ${costEvents.requestId} is not null), '{}'::text[])`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.provider, costEvents.model, dayExpr);

    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      day: r.day,
      expectedMicros: Number(r.expectedMicros ?? 0),
      requestIds: (r.requestIds ?? []).slice(0, sampleLimit),
    }));
  }

  /** The open review issue for a cell, or null. Closed/hidden ones don't count. */
  async function findOpenReviewIssue(companyId: string, fingerprint: string) {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        hiddenAt: issues.hiddenAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, INVOICE_RECONCILE_ORIGIN_KIND),
          eq(issues.originFingerprint, fingerprint),
        ),
      );
    return rows.find((i) => !CLOSED_STATUSES.includes(i.status) && !i.hiddenAt) ?? null;
  }

  /** Create the governance/billing review issue for a subtask, or reuse the open one. */
  async function ensureReviewIssue(
    companyId: string,
    subtask: BillingReviewSubtask,
  ): Promise<{ ref: ReconcileIssueRef; deduped: boolean }> {
    const fingerprint = cellFingerprint(subtask.cell.provider, subtask.cell.model, subtask.cell.day);
    const existing = await findOpenReviewIssue(companyId, fingerprint);
    if (existing) {
      return {
        ref: { id: existing.id, identifier: existing.identifier, cell: subtask.cell },
        deduped: true,
      };
    }
    const created = await issuesSvc.create(companyId, {
      title: subtask.title,
      description: subtask.body,
      status: "todo",
      priority: "medium",
      originKind: INVOICE_RECONCILE_ORIGIN_KIND,
      originFingerprint: fingerprint,
      billingCode: subtask.billingCode,
    } as Parameters<typeof issuesSvc.create>[1]);
    return {
      ref: { id: created.id, identifier: created.identifier ?? null, cell: subtask.cell },
      deduped: false,
    };
  }

  /**
   * Parse a vendor invoice, diff it against the cost_events aggregate, and open
   * an idempotent governance/billing review issue per over-threshold, day-locked
   * cell. Returns a summary of created vs. deduped issues plus diff counts.
   */
  async function reconcile(
    companyId: string,
    input: InvoiceReconcileInput,
  ): Promise<InvoiceReconcileSummary> {
    const lines = parseInvoice(input.invoice, { vendor: input.vendor, format: input.format });
    const sampleLimit = input.sampleRequestIdLimit ?? DEFAULT_SAMPLE_REQUEST_IDS;
    const cells = await aggregateCostEventsCells(
      companyId,
      { from: input.from, to: input.to },
      sampleLimit,
    );

    const result = reconcileInvoice(lines, cells, {
      now: input.now ?? new Date(),
      thresholdPercent: input.thresholdPercent,
      dayLockDelayHours: input.dayLockDelayHours,
      sampleRequestIdLimit: sampleLimit,
      currency: input.currency,
      pricebook: input.pricebook,
    });

    const created: ReconcileIssueRef[] = [];
    const deduped: ReconcileIssueRef[] = [];
    for (const subtask of result.subtasks) {
      const { ref, deduped: wasDeduped } = await ensureReviewIssue(companyId, subtask);
      (wasDeduped ? deduped : created).push(ref);
    }

    return {
      vendor: input.vendor,
      format: input.format,
      invoiceLineCount: lines.length,
      costEventCellCount: cells.length,
      subtaskCount: result.subtasks.length,
      created,
      deduped,
      withinThresholdCount: result.withinThreshold.length,
      deferredCount: result.deferred.length,
    };
  }

  return { aggregateCostEventsCells, findOpenReviewIssue, ensureReviewIssue, reconcile };
}

export type InvoiceReconcileService = ReturnType<typeof invoiceReconcileService>;
