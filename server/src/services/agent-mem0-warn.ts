import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { getTelemetryClient } from "../telemetry.js";

const MEM0_USER_ID_KEY = "MEM0_USER_ID";

export type AgentMem0WarnVerb = "create" | "update";

export type AgentMem0WarnActor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
};

export type AgentMem0WarnAgent = {
  id: string;
  name?: string | null;
  role?: string | null;
  adapterConfig?: unknown;
};

function readMem0UserId(adapterConfig: unknown): string {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return "";
  const env = (adapterConfig as Record<string, unknown>).env;
  if (typeof env !== "object" || env === null) return "";
  const raw = (env as Record<string, unknown>)[MEM0_USER_ID_KEY];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Option C-light gate from ELI-161 §6.2 / DEE-448.
 *
 * Emit a structured warn log + a single `agent_missing_mem0_user_id` audit-log
 * entry + a telemetry counter event when an agent write leaves
 * `adapterConfig.env.MEM0_USER_ID` absent or empty after merge. This is a
 * WARN-only signal — never blocks the write. Promotion to blocking is governed
 * by ELI-168.
 *
 * Equivalent Prometheus-style counter name from the spec:
 *   `agent_writes_missing_mem0_user_id_total{companyId,verb,caller}`
 */
export async function recordAgentMem0UserIdGap(
  db: Db,
  input: {
    companyId: string;
    agent: AgentMem0WarnAgent;
    verb: AgentMem0WarnVerb;
    actor: AgentMem0WarnActor;
  },
): Promise<boolean> {
  if (readMem0UserId(input.agent.adapterConfig)) return false;

  const caller = input.actor.actorType;
  const details = {
    verb: input.verb,
    caller,
    callerActorId: input.actor.actorId,
    agentName: input.agent.name ?? null,
    agentRole: input.agent.role ?? null,
  };

  logger.warn(
    {
      event: "agent_missing_mem0_user_id",
      companyId: input.companyId,
      agentId: input.agent.id,
      verb: input.verb,
      caller,
      callerActorId: input.actor.actorId,
    },
    `Agent ${input.verb} left adapterConfig.env.MEM0_USER_ID missing or empty (DEE-448 / ELI-168)`,
  );

  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      runId: input.actor.runId ?? null,
      action: "agent_missing_mem0_user_id",
      entityType: "agent",
      entityId: input.agent.id,
      details,
    });
  } catch (err) {
    logger.warn(
      { err, agentId: input.agent.id },
      "Failed to record agent_missing_mem0_user_id audit-log entry",
    );
  }

  try {
    const telemetry = getTelemetryClient();
    if (telemetry && typeof telemetry.track === "function") {
      telemetry.track("agent.missing_mem0_user_id", {
        company_id: input.companyId,
        verb: input.verb,
        caller,
      });
    }
  } catch (err) {
    logger.warn(
      { err, agentId: input.agent.id },
      "Failed to record agent_missing_mem0_user_id telemetry counter",
    );
  }

  return true;
}
