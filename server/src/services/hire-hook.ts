import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { HireApprovedPayload } from "@paperclipai/adapter-utils";
import { findActiveServerAdapter } from "../adapters/registry.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { ceoBlockedSweepService } from "./ceo-blocked-sweep.js";
import { instanceSettingsService } from "./instance-settings.js";

const HIRE_APPROVED_MESSAGE =
  "Tell your user that your hire was approved, now they should assign you a task in Paperclip or ask you to create issues.";

export interface NotifyHireApprovedInput {
  companyId: string;
  agentId: string;
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt?: Date;
}

/**
 * Reconcile the per-company CEO blocked-queue sweep routine (F6/ELI-297). The
 * sweep only exists when a non-terminated CEO agent is present, so any hire
 * approval is a reconcile trigger. Errors are logged and swallowed — sweep
 * absence is a soft degradation, not a fatal post-hire condition.
 */
async function reconcileCeoBlockedSweep(db: Db, companyId: string): Promise<void> {
  try {
    const sweep = ceoBlockedSweepService(db);
    const settings = instanceSettingsService(db);
    await sweep.reconcileForCompany(companyId, {
      experimentalSettings: async () => {
        const exp = await settings.getExperimental();
        return {
          ceoBlockedSweepEnabled: exp.ceoBlockedSweepEnabled,
          ceoBlockedSweepIntervalMinutes: exp.ceoBlockedSweepIntervalMinutes,
        };
      },
    });
  } catch (err) {
    logger.error({ err, companyId }, "ceo blocked sweep reconcile (post-hire) failed");
  }
}

/**
 * Invokes the adapter's onHireApproved hook when an agent is approved (join-request or hire_agent approval).
 * Failures are non-fatal: we log and write to activity, never throw.
 */
export async function notifyHireApproved(
  db: Db,
  input: NotifyHireApprovedInput,
): Promise<void> {
  const { companyId, agentId, source, sourceId } = input;
  const approvedAt = input.approvedAt ?? new Date();
  // Reconcile the CEO sweep routine regardless of adapter outcome — hires
  // and CEO transitions are the only moments where the sweep's presence
  // condition can change.
  await reconcileCeoBlockedSweep(db, companyId);

  const row = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!row) {
    logger.warn({ companyId, agentId, source, sourceId }, "hire hook: agent not found in company, skipping");
    return;
  }

  const adapterType = row.adapterType ?? "process";
  const adapter = findActiveServerAdapter(adapterType);
  const onHireApproved = adapter?.onHireApproved;
  if (!onHireApproved) {
    return;
  }

  const payload: HireApprovedPayload = {
    companyId,
    agentId,
    agentName: row.name,
    adapterType,
    source,
    sourceId,
    approvedAt: approvedAt.toISOString(),
    message: HIRE_APPROVED_MESSAGE,
  };

  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? (row.adapterConfig as Record<string, unknown>)
      : {};

  try {
    const result = await onHireApproved(payload, adapterConfig);
    if (result.ok) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "hire_hook",
        action: "hire_hook.succeeded",
        entityType: "agent",
        entityId: agentId,
        details: { source, sourceId, adapterType },
      });
      return;
    }

    logger.warn(
      { companyId, agentId, adapterType, source, sourceId, error: result.error, detail: result.detail },
      "hire hook: adapter returned failure",
    );
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.failed",
      entityType: "agent",
      entityId: agentId,
      details: { source, sourceId, adapterType, error: result.error, detail: result.detail },
    });
  } catch (err) {
    logger.error(
      { err, companyId, agentId, adapterType, source, sourceId },
      "hire hook: adapter threw",
    );
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "hire_hook",
      action: "hire_hook.error",
      entityType: "agent",
      entityId: agentId,
      details: {
        source,
        sourceId,
        adapterType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
