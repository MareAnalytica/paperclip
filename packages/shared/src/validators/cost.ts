import { z } from "zod";
import { BILLING_TYPES } from "../constants.js";

export const createCostEventSchema = z.object({
  agentId: z.string().uuid(),
  issueId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  heartbeatRunId: z.string().uuid().optional().nullable(),
  billingCode: z.string().optional().nullable(),
  provider: z.string().min(1),
  biller: z.string().min(1).optional(),
  billingType: z.enum(BILLING_TYPES).optional().default("unknown"),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional().default(0),
  cachedInputTokens: z.number().int().nonnegative().optional().default(0),
  outputTokens: z.number().int().nonnegative().optional().default(0),
  costCents: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
}).transform((value) => ({
  ...value,
  biller: value.biller ?? value.provider,
}));

export type CreateCostEvent = z.infer<typeof createCostEventSchema>;

export const updateBudgetSchema = z.object({
  budgetMonthlyCents: z.number().int().nonnegative(),
});

export type UpdateBudget = z.infer<typeof updateBudgetSchema>;

// §6.3 vendor-invoice reconciler endpoint (ELI-937). The raw invoice payload is
// posted as text alongside the vendor/format selectors; the diff window is
// optional (defaults to the full cost_events history if omitted).
export const invoiceReconcileRequestSchema = z.object({
  vendor: z.enum(["anthropic", "openai"]),
  format: z.enum(["csv", "json"]),
  invoice: z.string().min(1),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  thresholdPercent: z.number().positive().optional(),
  dayLockDelayHours: z.number().nonnegative().optional(),
  sampleRequestIdLimit: z.number().int().positive().max(100).optional(),
  currency: z.string().length(3).optional(),
});

export type InvoiceReconcileRequest = z.infer<typeof invoiceReconcileRequestSchema>;
