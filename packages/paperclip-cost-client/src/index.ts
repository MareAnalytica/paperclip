import type {
  ChargeCallParams,
  ChargeResult,
  CostClientOptions,
  PreflightCallParams,
  PreflightResult,
  PolicyErrorCode,
} from "@paperclipai/shared";
import { POLICY_ERROR, PaperclipCostError } from "@paperclipai/shared";

/**
 * Standalone thin client for Paperclip cost attribution (ELI-78).
 * Intended for:
 * - Paperclip built-in adapters (via @paperclipai/adapter-utils withBudget)
 * - External / non-SDK adapters and custom runtimes that cannot import the full SDK.
 *
 * Every chargeable provider interaction should:
 *   estimate -> preflightIfRequired(estimate) -> real provider call -> charge(actual)
 *
 * Honors:
 * - preflight.estimateThresholdMicros (default 50000)
 * - forcePreflightAbovePercent (default 80)  [note: client cannot know *current* cap % without a burn query; the force is best-effort via server preflightRequired feedback or caller hint]
 * - idempotencyKey rule: <provider>:<requestId> when requestId present, else caller supplied
 * - 400 policy.cost_attribution_missing when required dims (companyId + provider + model) absent after context merge
 */

const DEFAULT_ESTIMATE_THRESHOLD = 50_000;
const DEFAULT_FORCE_ABOVE_PCT = 80;

export interface CreateCostClientResult {
  preflightIfRequired: (params: PreflightCallParams) => Promise<PreflightResult>;
  charge: (params: ChargeCallParams) => Promise<ChargeResult>;
  /** Helper to build a recommended idempotencyKey. Callers should still pass requestId when they have one from the vendor. */
  makeIdempotencyKey: (params: { provider: string; requestId?: string | null; runId?: string | null; actionIndex?: number; kind?: string }) => string;
}

function requireDims(dims: CostAttributionDimensionsLike): void {
  if (!dims.companyId || !dims.provider || !dims.model) {
    throw new PaperclipCostError(
      400,
      POLICY_ERROR.COST_ATTRIBUTION_MISSING,
      "missing required cost attribution dimensions (companyId, provider, model)",
      { received: { companyId: !!dims.companyId, provider: !!dims.provider, model: !!dims.model } },
    );
  }
}

type CostAttributionDimensionsLike = {
  companyId?: string | null;
  provider?: string | null;
  model?: string | null;
};

function defaultPreflightConfig(override?: CostClientOptions["preflight"]) {
  return {
    estimateThresholdMicros: override?.estimateThresholdMicros ?? DEFAULT_ESTIMATE_THRESHOLD,
    forcePreflightAbovePercent: override?.forcePreflightAbovePercent ?? DEFAULT_FORCE_ABOVE_PCT,
  };
}

async function doJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const code = (body && (body.code || body.error)) || `http_${res.status}`;
    throw new PaperclipCostError(res.status, code, body?.message || code, body);
  }
  return body as T;
}

export function createCostClient(opts: CostClientOptions): CreateCostClientResult {
  const { apiBase, authToken, fetchImpl = fetch, preflight: preflightOverride } = opts;
  const cfg = defaultPreflightConfig(preflightOverride);
  const base = apiBase.replace(/\/$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  async function preflightIfRequired(params: PreflightCallParams): Promise<PreflightResult> {
    requireDims(params);

    const est = params.estimatedCostMicros ?? 0;
    const shouldPreflight =
      est >= cfg.estimateThresholdMicros ||
      // Without live cap % the client cannot know the "force above critical" case precisely.
      // Callers that have a prior burn can pass a hint via a non-standard field or always call.
      // The server will still enforce its own preflightRequired in the response.
      false;

    if (!shouldPreflight) {
      // Return a synthetic allow result so caller can proceed without roundtrip for cheap calls.
      return {
        decision: "allow",
        bindingCapId: null,
        headroomMicros: Number.MAX_SAFE_INTEGER,
        softHeadroomMicros: Number.MAX_SAFE_INTEGER,
        warnings: [],
        approvalIds: [],
        evaluationTimedOut: false,
        preflightRequired: false,
      };
    }

    const body = {
      companyId: params.companyId,
      agentId: params.agentId ?? null,
      runId: params.runId ?? null,
      userId: params.userId ?? null,
      issueId: params.issueId ?? null,
      projectId: params.projectId ?? null,
      goalId: params.goalId ?? null,
      billingCode: params.billingCode ?? null,
      provider: params.provider,
      model: params.model,
      kind: params.kind ?? "tokens",
      estimatedQty: params.estimatedQty ?? 0,
      estimatedCostMicros: est,
    };

    return doJson<PreflightResult>(fetchImpl, `${base}/cost/preflight`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function charge(params: ChargeCallParams): Promise<ChargeResult> {
    requireDims(params);

    // Always prefer <provider>:<requestId> when requestId is available (§7.1 AC: "Charge always sends...").
    let key = params.idempotencyKey;
    if (params.requestId) {
      key = `${params.provider}:${params.requestId}`;
    } else if (!key) {
      key = makeIdempotencyKeyImpl({
        provider: params.provider,
        requestId: params.requestId,
        runId: params.runId,
        kind: params.kind,
      });
    }

    const body: Record<string, unknown> = {
      companyId: params.companyId,
      agentId: params.agentId ?? null,
      runId: params.runId ?? null,
      userId: params.userId ?? null,
      issueId: params.issueId ?? null,
      projectId: params.projectId ?? null,
      goalId: params.goalId ?? null,
      billingCode: params.billingCode ?? null,
      provider: params.provider,
      model: params.model,
      kind: params.kind ?? "tokens",
      qty: params.qty ?? 0,
      inputTokens: params.inputTokens ?? 0,
      cachedInputTokens: params.cachedInputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      cacheWriteTokens: params.cacheWriteTokens ?? null,
      unitPriceMicros: params.unitPriceMicros ?? null,
      costMicros: params.costMicros ?? null,
      currency: params.currency ?? "USD",
      pricebookVersion: params.pricebookVersion ?? null,
      requestId: params.requestId ?? null,
      idempotencyKey: key,
      meta: params.meta ?? null,
      occurredAt: params.occurredAt,
    };

    try {
      return await doJson<ChargeResult>(fetchImpl, `${base}/cost/charge`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e instanceof PaperclipCostError) {
        // Re-throw as-is (enforcement errors come back with result in details)
        throw e;
      }
      throw e;
    }
  }

  function makeIdempotencyKeyImpl(input: {
    provider: string;
    requestId?: string | null;
    runId?: string | null;
    actionIndex?: number;
    kind?: string;
  }): string {
    if (input.requestId) {
      return `${input.provider}:${input.requestId}`;
    }
    const run = input.runId ?? "no-run";
    const idx = input.actionIndex ?? 0;
    const k = input.kind ?? "tokens";
    return `${input.provider}:${run}:${idx}:${k}`;
  }

  return {
    preflightIfRequired,
    charge,
    makeIdempotencyKey: makeIdempotencyKeyImpl,
  };
}

/**
 * Convenience: build a recommended idempotency key (exported for adapters that build their own bodies).
 */
export function makeCostIdempotencyKey(input: {
  provider: string;
  requestId?: string | null;
  runId?: string | null;
  actionIndex?: number;
  kind?: string;
}): string {
  const client = createCostClient({ apiBase: "http://unused" }); // only for the fn
  return client.makeIdempotencyKey(input);
}

// Re-export the client types + error surface from shared so consumers (adapter-utils, external SDK users) get everything from this thin package.
export type {
  PreflightCallParams,
  ChargeCallParams,
  PreflightResult,
  ChargeResult,
  CostClientOptions,
  CostAttributionDimensions,
  PolicyErrorCode,
} from "@paperclipai/shared";
export { PaperclipCostError, isPolicyCostError, POLICY_ERROR } from "@paperclipai/shared";
