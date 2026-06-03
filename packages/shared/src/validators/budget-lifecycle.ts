import { z } from "zod";
import type { BudgetCapAction } from "../budget/cap-precedence.js";
import type { PreflightDecision } from "../budget/enforcement.js";

// Request bodies for the budgeting lifecycle endpoints (agent-budgeting policy
// §4.1 preflight and §4.2 charge). Both carry the §2.1 cost-attribution
// dimensions. `agentId` is nullable: source-less timer/system charges (e.g. a
// provider-health probe) are first-class and attribute to no agent (§2.1).

const COST_KINDS = [
  "tokens",
  "requests",
  "seconds",
  "storage_bytes_day",
  "egress_bytes",
  "storage_bytes",
  "fixed",
] as const;

// Shared attribution dimensions. companyId is the tenant boundary (never null);
// every other dimension is optional and defaults to the runtime context.
const attribution = {
  companyId: z.string().uuid(),
  agentId: z.string().uuid().optional().nullable(),
  userId: z.string().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  runId: z.string().uuid().optional().nullable(),
  billingCode: z.string().min(1).optional().nullable(),
  provider: z.string().min(1),
  model: z.string().min(1),
  kind: z.enum(COST_KINDS).optional().default("tokens"),
};

export const preflightRequestSchema = z.object({
  ...attribution,
  estimatedQty: z.number().nonnegative().optional().default(0),
  // Adapter-computed estimate using the current pricebook (§4.1). Caps are
  // evaluated against window spend + this estimate so the prospective call is
  // included in the decision.
  estimatedCostMicros: z.number().int().nonnegative().optional().default(0),
});
export type PreflightRequest = z.infer<typeof preflightRequestSchema>;

export const chargeRequestSchema = z
  .object({
    ...attribution,
    qty: z.number().nonnegative().optional().default(0),
    inputTokens: z.number().int().nonnegative().optional().default(0),
    cachedInputTokens: z.number().int().nonnegative().optional().default(0),
    outputTokens: z.number().int().nonnegative().optional().default(0),
    cacheWriteTokens: z.number().int().nonnegative().optional().nullable(),
    // Frozen pricing. The server records cost_micros; it is computed as
    // ceil(qty * unitPriceMicros) when unitPriceMicros is supplied, otherwise the
    // adapter-supplied costMicros is recorded verbatim (a server-side pricebook
    // resolver is ELI-74's surface and plugs in here when present).
    unitPriceMicros: z.number().int().nonnegative().optional().nullable(),
    costMicros: z.number().int().nonnegative().optional().nullable(),
    currency: z.string().length(3).optional().default("USD"),
    pricebookVersion: z.string().optional().nullable(),
    requestId: z.string().optional().nullable(),
    // Deduplicates retries (§2.1). Unique in cost_events; a repeat returns the
    // original row with no double-charge.
    idempotencyKey: z.string().min(1),
    meta: z.record(z.unknown()).optional().nullable(),
    occurredAt: z.string().datetime().optional(),
  })
  .refine((v) => v.costMicros != null || v.unitPriceMicros != null, {
    message: "one of costMicros or unitPriceMicros is required",
    path: ["costMicros"],
  });
export type ChargeRequest = z.infer<typeof chargeRequestSchema>;

// ---------------------------------------------------------------------------
// Response + client types for adapter SDK (ELI-78 / policy §4, §7.1)
// These are the shapes returned by POST /cost/preflight and POST /cost/charge.
// Also the structured error the cost client / adapters emit for §7.1 rule 2.
// ---------------------------------------------------------------------------

export const POLICY_ERROR = {
  COST_ATTRIBUTION_MISSING: "policy.cost_attribution_missing",
  BUDGET_PAUSED_WRITES: "policy.budget_paused_writes",
  BUDGET_PAUSED_RUNS: "policy.budget_paused_runs",
  BUDGET_HARD_STOPPED: "policy.budget_hard_stopped",
} as const;

export type PolicyErrorCode = (typeof POLICY_ERROR)[keyof typeof POLICY_ERROR];

export interface PreflightResult {
  decision: PreflightDecision; // from enforcement (allow | warn | require_approval | deny)
  bindingCapId: string | null;
  headroomMicros: number;
  softHeadroomMicros: number;
  warnings: Array<{ capId: string; percent: number }>;
  approvalIds: string[];
  evaluationTimedOut: boolean;
  preflightRequired: boolean; // true when server says this call was above threshold / critical
}

export interface ChargeResult {
  id: string;
  costMicros: number;
  headroomMicros: number;
  alertsFired: BudgetCapAction[]; // actions that fired on this charge (for logging)
  idempotent: boolean;
}

export interface CostAttributionDimensions {
  companyId: string;
  runId?: string | null;
  agentId?: string | null;
  userId?: string | null;
  issueId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  billingCode?: string | null;
  provider: string;
  model: string;
  kind?: string;
}

export interface PreflightCallParams extends CostAttributionDimensions {
  estimatedQty?: number;
  estimatedCostMicros?: number;
}

export interface ChargeCallParams extends CostAttributionDimensions {
  qty?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number | null;
  unitPriceMicros?: number | null;
  costMicros?: number | null;
  currency?: string;
  pricebookVersion?: string | null;
  requestId?: string | null;
  idempotencyKey: string;
  meta?: Record<string, unknown> | null;
  occurredAt?: string; // ISO
}

export interface CostClientOptions {
  /** Base URL of the Paperclip API, e.g. https://... or http://localhost:3100 */
  apiBase: string;
  /** Bearer token (run JWT for agents, or other actor token). If omitted, client assumes same-origin or cookie (rare for adapters). */
  authToken?: string;
  /** Override fetch for tests/mocks */
  fetchImpl?: typeof fetch;
  /** Preflight tunables (defaults match policy + config/agent-budgeting.yaml defaults) */
  preflight?: {
    estimateThresholdMicros?: number;
    forcePreflightAbovePercent?: number; // aka criticalPreflightPercent
  };
}

/** Structured error thrown by cost client for attribution failures and enforcement. */
export class PaperclipCostError extends Error {
  status: number;
  code: PolicyErrorCode | string;
  details?: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message || code);
    this.name = "PaperclipCostError";
    this.status = status;
    this.code = code as PolicyErrorCode | string;
    this.details = details;
  }
}

export function isPolicyCostError(err: unknown, code?: PolicyErrorCode): err is PaperclipCostError {
  return err instanceof PaperclipCostError && (!code || err.code === code);
}
