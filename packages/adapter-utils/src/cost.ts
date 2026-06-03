import type { AdapterExecutionContext } from "./types.js";
import {
  createCostClient,
  type CreateCostClientResult,
  type PreflightCallParams,
  type ChargeCallParams,
  type PreflightResult,
  type ChargeResult,
  type CostClientOptions,
  PaperclipCostError,
  isPolicyCostError,
  POLICY_ERROR,
  makeCostIdempotencyKey,
} from "@paperclipai/paperclip-cost-client";

/**
 * SDK surface (ELI-78): `withBudget(call)` wrapper + thin re-export of the
 * standalone paperclip-cost-client for adapters that prefer direct use.
 *
 * Contract:
 * - Runtime injects runId + agent (with companyId) into AdapterExecutionContext (already true).
 * - withBudget merges ctx into every attribution payload so adapters cannot omit dimensions.
 * - Adapters that still miss companyId/provider/model after merge get 400 policy.cost_attribution_missing.
 * - preflight threshold honors the two config knobs (defaults + caller override via ctx or options).
 * - charge always emits idempotencyKey = <provider>:<requestId> when requestId present (else safe fallback).
 */

export {
  createCostClient,
  type CreateCostClientResult,
  type PreflightCallParams,
  type ChargeCallParams,
  type PreflightResult,
  type ChargeResult,
  PaperclipCostError,
  isPolicyCostError,
  POLICY_ERROR,
  makeCostIdempotencyKey,
} from "@paperclipai/paperclip-cost-client";

export interface BudgetHandle {
  preflightIfRequired: (partial: Omit<PreflightCallParams, "companyId" | "runId" | "agentId"> & { estimatedCostMicros?: number }) => Promise<PreflightResult>;
  charge: (partial: Omit<ChargeCallParams, "companyId" | "runId" | "agentId" | "idempotencyKey"> & { idempotencyKey?: string }) => Promise<ChargeResult>;
  /** Build a key using the current run context. */
  makeIdempotencyKey: (input: { provider: string; requestId?: string | null; actionIndex?: number; kind?: string }) => string;
}

/**
 * withBudget(call) — the primary SDK helper.
 * Wraps a provider interaction so the preflight → call → charge sequence is enforced
 * and attribution dimensions are supplied from the execution context.
 *
 * Example (conceptual):
 *   const answer = await withBudget(ctx, async (b) => {
 *     const est = estimateTokens(prompt);
 *     const p = await b.preflightIfRequired({ provider: 'anthropic', model, estimatedCostMicros: est });
 *     if (p.decision === 'deny') throw new Error('budget hard stop');
 *     const res = await realProviderCall(...);
 *     await b.charge({ provider: 'anthropic', model, requestId: res.id, qty: res.tokens, ... });
 *     return res;
 *   });
 */
export async function withBudget<T>(
  ctx: AdapterExecutionContext,
  fn: (budget: BudgetHandle) => Promise<T>,
  opts?: {
    /** Optional override for api base / token (falls back to env + ctx.authToken) */
    apiBase?: string;
    authToken?: string;
    fetchImpl?: typeof fetch;
    preflight?: { estimateThresholdMicros?: number; forcePreflightAbovePercent?: number };
  },
): Promise<T> {
  const apiBase =
    opts?.apiBase ||
    (process.env.PAPERCLIP_API_URL as string | undefined) ||
    (process.env.PAPERCLIP_RUNTIME_API_URL as string | undefined) ||
    "http://127.0.0.1:3100";

  const authToken = opts?.authToken || ctx.authToken || (process.env.PAPERCLIP_API_KEY as string | undefined);

  const client = createCostClient({
    apiBase,
    authToken,
    fetchImpl: (opts as any)?.fetchImpl,
    preflight: opts?.preflight,
  });

  const baseAttribution = {
    companyId: ctx.agent?.companyId,
    runId: ctx.runId,
    agentId: ctx.agent?.id,
    // default billingCode from issue (paperclipIssue) if present in ctx; full chain
    // (issue→parent→project→goal→agentDefault) can be resolved server-side at charge time or
    // by future context enrichment. See ELI-78 objective + policy §7.4.
    billingCode:
      (ctx.context as any)?.billingCode ??
      (ctx.context as any)?.paperclipIssue?.billingCode ??
      (ctx.context as any)?.paperclipWake?.billingCode ??
      null,
  };

  const handle: BudgetHandle = {
    async preflightIfRequired(partial) {
      return client.preflightIfRequired({
        ...baseAttribution,
        ...partial,
      } as PreflightCallParams);
    },
    async charge(partial) {
      const p = partial as ChargeCallParams;
      // Ensure idempotencyKey per §7.1
      const key =
        p.idempotencyKey ||
        client.makeIdempotencyKey({
          provider: p.provider,
          requestId: p.requestId,
          runId: baseAttribution.runId,
          actionIndex: (p.meta as any)?.actionIndex,
          kind: p.kind,
        });
      return client.charge({
        ...baseAttribution,
        ...p,
        idempotencyKey: key,
      });
    },
    makeIdempotencyKey(input) {
      return client.makeIdempotencyKey({
        provider: input.provider,
        requestId: input.requestId,
        runId: baseAttribution.runId,
        actionIndex: input.actionIndex,
        kind: input.kind,
      });
    },
  };

  return fn(handle);
}

/** Quick factory if an adapter wants the raw client bound to this ctx (rare). */
export function createCostClientFromContext(
  ctx: AdapterExecutionContext,
  opts?: Partial<CostClientOptions>,
): CreateCostClientResult {
  const apiBase =
    opts?.apiBase ||
    (process.env.PAPERCLIP_API_URL as string | undefined) ||
    (process.env.PAPERCLIP_RUNTIME_API_URL as string | undefined) ||
    "http://127.0.0.1:3100";
  const authToken = opts?.authToken || ctx.authToken || (process.env.PAPERCLIP_API_KEY as string | undefined);
  return createCostClient({ apiBase, authToken, ...opts });
}
