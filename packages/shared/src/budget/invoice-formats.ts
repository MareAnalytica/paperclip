// Server-side mirror of the eli-board blueprint's vendor-invoice format adapters
// (src/budgeting/invoice-formats.ts). Each adapter parses a vendor's CSV or JSON
// usage export into normalized InvoiceLines (provider, model, day, amountMicros,
// requestId?), which reconcileInvoice then diffs against cost_events.
//
// Mirrored faithfully from the blueprint — see invoice-reconcile.ts for the sync
// contract. CSV parsing is intentionally minimal (RFC-4180 quoting, comma
// delimiter, no external dependency).

import { amountToMicros, InvoiceReconcileError, type InvoiceLine } from "./invoice-reconcile.js";

export type Vendor = "anthropic" | "openai";
export type InvoiceFormat = "csv" | "json";

interface VendorSpec {
  provider: string;
  /** Header aliases (lowercased) → canonical field. First match wins. */
  dateAliases: string[];
  modelAliases: string[];
  amountAliases: string[];
  requestIdAliases: string[];
}

const VENDOR_SPECS: Record<Vendor, VendorSpec> = {
  anthropic: {
    provider: "anthropic",
    dateAliases: ["date", "usage_date", "day", "invoice_date"],
    modelAliases: ["model", "model_id"],
    amountAliases: ["cost", "cost_usd", "amount", "amount_usd", "total"],
    requestIdAliases: ["request_id", "requestid", "request"],
  },
  openai: {
    provider: "openai",
    dateAliases: ["date", "timestamp", "usage_date", "day"],
    modelAliases: ["model", "snapshot_id", "model_id"],
    amountAliases: ["amount", "cost", "amount_usd", "cost_usd", "total"],
    requestIdAliases: ["request_id", "requestid", "id"],
  },
};

export const SUPPORTED_VENDORS = Object.keys(VENDOR_SPECS) as Vendor[];
export const SUPPORTED_FORMATS: InvoiceFormat[] = ["csv", "json"];

export function isVendor(value: unknown): value is Vendor {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VENDOR_SPECS, value);
}

export function isInvoiceFormat(value: unknown): value is InvoiceFormat {
  return value === "csv" || value === "json";
}

export function vendorProvider(vendor: Vendor): string {
  const spec = VENDOR_SPECS[vendor];
  if (!spec) throw new InvoiceReconcileError(`unknown vendor ${JSON.stringify(vendor)}`);
  return spec.provider;
}

/** Parse a vendor invoice (CSV or JSON) into normalized invoice lines. */
export function parseInvoice(
  source: string,
  opts: { vendor: Vendor; format: InvoiceFormat },
): InvoiceLine[] {
  const spec = VENDOR_SPECS[opts.vendor];
  if (!spec) throw new InvoiceReconcileError(`unknown vendor ${JSON.stringify(opts.vendor)}`);
  return opts.format === "csv" ? parseCsv(source, spec) : parseJson(source, spec);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

function parseJson(source: string, spec: VendorSpec): InvoiceLine[] {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new InvoiceReconcileError(`invoice JSON parse error: ${(e as Error).message}`);
  }
  // Accept a bare array, or an object wrapping the rows under a common key.
  const rows = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? (raw.lineItems ?? raw.data ?? raw.items ?? raw.rows ?? raw.usage)
      : undefined;
  if (!Array.isArray(rows)) {
    throw new InvoiceReconcileError(
      "invoice JSON must be an array of line items or an object with a lineItems/data/items/rows/usage array",
    );
  }
  return rows.map((row, i) => {
    if (!isObject(row)) {
      throw new InvoiceReconcileError(`invoice JSON row ${i} is not an object`);
    }
    const get = (aliases: string[]) => pickKey(row, aliases);
    return buildLine(spec, {
      date: asString(get(spec.dateAliases)),
      model: asString(get(spec.modelAliases)),
      amount: get(spec.amountAliases),
      requestId: asOptionalString(get(spec.requestIdAliases)),
      where: `JSON row ${i}`,
    });
  });
}

// ---------------------------------------------------------------------------
// CSV (minimal RFC-4180: comma delimiter, double-quote quoting, "" escape)
// ---------------------------------------------------------------------------

function parseCsv(source: string, spec: VendorSpec): InvoiceLine[] {
  const records = parseCsvRecords(source);
  if (records.length === 0) return [];
  const header = records[0].map((h) => h.trim().toLowerCase());
  const colOf = (aliases: string[]): number => {
    for (const a of aliases) {
      const idx = header.indexOf(a);
      if (idx !== -1) return idx;
    }
    return -1;
  };
  const dateCol = colOf(spec.dateAliases);
  const modelCol = colOf(spec.modelAliases);
  const amountCol = colOf(spec.amountAliases);
  const requestCol = colOf(spec.requestIdAliases);

  const missing: string[] = [];
  if (dateCol === -1) missing.push(`date (one of: ${spec.dateAliases.join(", ")})`);
  if (modelCol === -1) missing.push(`model (one of: ${spec.modelAliases.join(", ")})`);
  if (amountCol === -1) missing.push(`amount (one of: ${spec.amountAliases.join(", ")})`);
  if (missing.length) {
    throw new InvoiceReconcileError(
      `invoice CSV is missing required column(s): ${missing.join("; ")}. Header was: ${header.join(", ")}`,
    );
  }

  const lines: InvoiceLine[] = [];
  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    if (row.length === 1 && row[0].trim() === "") continue; // blank line
    lines.push(
      buildLine(spec, {
        date: row[dateCol]?.trim(),
        model: row[modelCol]?.trim(),
        amount: row[amountCol]?.trim(),
        requestId: requestCol === -1 ? undefined : row[requestCol]?.trim() || undefined,
        where: `CSV row ${r + 1}`,
      }),
    );
  }
  return lines;
}

/** Tokenize CSV text into rows of fields, honoring quoted fields with commas/newlines. */
function parseCsvRecords(source: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const text = source.replace(/\r\n?/g, "\n");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush trailing field/row if the file did not end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Shared row → InvoiceLine
// ---------------------------------------------------------------------------

function buildLine(
  spec: VendorSpec,
  fields: { date?: string; model?: string; amount: unknown; requestId?: string; where: string },
): InvoiceLine {
  const { where } = fields;
  if (!fields.date) throw new InvoiceReconcileError(`${where}: missing date`);
  if (!fields.model) throw new InvoiceReconcileError(`${where}: missing model`);
  const day = normalizeDay(fields.date, where);
  const amount = toNumber(fields.amount, where);
  return {
    provider: spec.provider,
    model: fields.model,
    day,
    amountMicros: amountToMicros(amount),
    requestId: fields.requestId ?? null,
  };
}

/** Coerce a date / timestamp into a `YYYY-MM-DD` (UTC) day key. */
function normalizeDay(value: string, where: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new InvoiceReconcileError(`${where}: unparseable date ${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function toNumber(value: unknown, where: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvoiceReconcileError(`${where}: non-finite amount`);
    return value;
  }
  if (typeof value === "string") {
    // Tolerate currency symbols, thousands separators, and surrounding space.
    const cleaned = value.replace(/[$,\s]/g, "");
    if (cleaned === "") throw new InvoiceReconcileError(`${where}: empty amount`);
    const n = Number(cleaned);
    if (!Number.isFinite(n)) {
      throw new InvoiceReconcileError(`${where}: unparseable amount ${JSON.stringify(value)}`);
    }
    return n;
  }
  throw new InvoiceReconcileError(`${where}: missing amount`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pickKey(row: Record<string, unknown>, aliases: string[]): unknown {
  const lower = new Map(Object.keys(row).map((k) => [k.toLowerCase(), k]));
  for (const a of aliases) {
    const key = lower.get(a);
    if (key !== undefined) return row[key];
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

function asOptionalString(v: unknown): string | undefined {
  const s = asString(v);
  return s && s.trim() !== "" ? s : undefined;
}
