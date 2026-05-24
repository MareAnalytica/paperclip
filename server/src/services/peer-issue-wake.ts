import { and, eq, inArray } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { logger } from "../middleware/logger.js";

/**
 * Per spec §8 CEO ruling: `peer_issue_arrived` fires unconditionally to the target
 * company's CEO / Mission Owner regardless of `requestedAssigneeAgentNameKey`. If a
 * name-key was supplied and resolves, we wake that agent as well.
 */
export async function wakePeerIssueArrived(
  db: Db,
  input: {
    targetCompanyId: string;
    targetIssueId: string;
    targetIssueIdentifier: string;
    sourceCompanyId: string;
    sourceIssueIdentifier: string;
    sourceCallbackUrl: string;
    auditId: string;
    requestedAssigneeAgentNameKey?: string | null;
  },
): Promise<{ wokeAgentIds: string[]; assigneeUnresolved: boolean }> {
  const heartbeat = heartbeatService(db);
  const wokeAgentIds: string[] = [];
  let assigneeUnresolved = false;

  // 1. Always wake target-company CEO/Mission Owner.
  const ceoRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.companyId, input.targetCompanyId),
      inArray(agents.role, ["ceo", "cto"]),
    ));
  for (const row of ceoRows) {
    try {
      await heartbeat.wakeup(row.id, {
        source: "automation",
        triggerDetail: "callback",
        reason: "peer_issue_arrived",
        payload: {
          issueId: input.targetIssueId,
          issueIdentifier: input.targetIssueIdentifier,
          sourceCompanyId: input.sourceCompanyId,
          sourceIssueIdentifier: input.sourceIssueIdentifier,
          sourceCallbackUrl: input.sourceCallbackUrl,
          auditId: input.auditId,
        },
        requestedByActorType: "system",
        requestedByActorId: "peer-issue",
      });
      wokeAgentIds.push(row.id);
    } catch (err) {
      logger.warn({ err, agentId: row.id, peerAuditId: input.auditId },
        "peer_issue_arrived wake failed for target CEO");
    }
  }

  // 2. Optionally resolve `requestedAssigneeAgentNameKey` and wake it too.
  if (input.requestedAssigneeAgentNameKey) {
    const wanted = input.requestedAssigneeAgentNameKey.toLowerCase().trim();
    const candidates = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, input.targetCompanyId));
    const match = candidates.find((row) =>
      row.name?.toLowerCase() === wanted || row.role?.toLowerCase() === wanted,
    );
    if (!match) {
      assigneeUnresolved = true;
    } else if (!wokeAgentIds.includes(match.id)) {
      try {
        await heartbeat.wakeup(match.id, {
          source: "automation",
          triggerDetail: "callback",
          reason: "peer_issue_arrived",
          payload: {
            issueId: input.targetIssueId,
            issueIdentifier: input.targetIssueIdentifier,
            sourceCompanyId: input.sourceCompanyId,
            sourceIssueIdentifier: input.sourceIssueIdentifier,
            sourceCallbackUrl: input.sourceCallbackUrl,
            auditId: input.auditId,
          },
          requestedByActorType: "system",
          requestedByActorId: "peer-issue",
        });
        wokeAgentIds.push(match.id);
      } catch (err) {
        logger.warn({ err, agentId: match.id, peerAuditId: input.auditId },
          "peer_issue_arrived wake failed for requested assignee");
      }
    }
  }

  return { wokeAgentIds, assigneeUnresolved };
}
