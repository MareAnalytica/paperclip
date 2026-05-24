import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { peerIssueService } from "../services/peer-issues.js";
import { peerGrantService, isValidPeerGrantScope } from "../services/peer-grants.js";
import { wakePeerIssueArrived } from "../services/peer-issue-wake.js";
import { logActivity } from "../services/activity-log.js";
import { validate } from "../middleware/validate.js";
import { assertAuthenticated, assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest, forbidden } from "../errors.js";

const guardrailAckSchema = z.object({
  noSecrets: z.literal(true),
  noEnvMutation: z.literal(true),
  noAgentMutation: z.literal(true),
  noBoardEscalation: z.literal(true),
}).passthrough();

const peerIssueCreateBodySchema = z.object({
  sourceCompanyId: z.string().uuid(),
  sourceIssueIdentifier: z.string().min(1),
  sourceCallbackUrl: z.string().url(),
  title: z.string().min(1).max(500),
  body: z.string().optional().nullable(),
  acceptanceCriteria: z.string().min(1),
  requestedAssigneeAgentNameKey: z.string().optional().nullable(),
  guardrailAck: guardrailAckSchema,
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/, "idempotencyKey must be a sha256 hex string (64 lowercase hex chars)"),
});

const peerIssueCommentBodySchema = z.object({
  sourceCompanyId: z.string().uuid(),
  sourceIssueIdentifier: z.string().min(1),
  sourceCallbackUrl: z.string().url(),
  body: z.string().min(1).max(64_000),
  guardrailAck: guardrailAckSchema,
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/, "idempotencyKey must be a sha256 hex string (64 lowercase hex chars)"),
});

const peerGrantCreateBodySchema = z.object({
  agentId: z.string().uuid(),
  scopes: z.array(z.string()).min(1),
  expiresAt: z.string().datetime().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

const auditDirectionSchema = z.enum(["inbound", "outbound"]);

export function peerIssueRoutes(db: Db) {
  const router = Router();
  const svc = peerIssueService(db);
  const grants = peerGrantService(db);

  // POST /api/companies/:targetCompanyId/peer-issues
  router.post(
    "/companies/:targetCompanyId/peer-issues",
    validate(peerIssueCreateBodySchema),
    async (req, res) => {
      assertAuthenticated(req);
      const targetCompanyId = req.params.targetCompanyId as string;
      if (req.actor.type !== "agent" || !req.actor.agentId) {
        throw forbidden("Peer-issue endpoint requires agent authentication");
      }
      const actor = getActorInfo(req);

      const result = await svc.create(targetCompanyId, req.actor.agentId, {
        sourceCompanyId: req.body.sourceCompanyId,
        sourceAgentId: req.actor.agentId,
        sourceIssueIdentifier: req.body.sourceIssueIdentifier,
        sourceCallbackUrl: req.body.sourceCallbackUrl,
        title: req.body.title,
        body: req.body.body ?? null,
        acceptanceCriteria: req.body.acceptanceCriteria,
        requestedAssigneeAgentNameKey: req.body.requestedAssigneeAgentNameKey ?? null,
        guardrailAck: req.body.guardrailAck,
        idempotencyKey: req.body.idempotencyKey,
      });

      if (result.replayed) {
        res.status(200).json({ ...(result.response as object), replayed: true });
        return;
      }

      // Activity log on both companies (spec §5 — bidirectional audit).
      await logActivity(db, {
        companyId: targetCompanyId,
        actorType: "system",
        actorId: "peer-issue",
        agentId: null,
        runId: null,
        action: "issue.peer_created",
        entityType: "issue",
        entityId: result.issue.id,
        details: {
          identifier: result.issue.identifier,
          sourceCompanyId: req.body.sourceCompanyId,
          sourceIssueIdentifier: req.body.sourceIssueIdentifier,
          sourceAgentId: req.actor.agentId,
          peerAuditId: result.audit.id,
        },
      });
      await logActivity(db, {
        companyId: req.body.sourceCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.peer_created",
        entityType: "issue",
        entityId: result.issue.id,
        details: {
          direction: "outbound",
          targetCompanyId,
          targetIssueIdentifier: result.issue.identifier,
          sourceIssueIdentifier: req.body.sourceIssueIdentifier,
          peerAuditId: result.audit.id,
        },
      });

      const wake = await wakePeerIssueArrived(db, {
        targetCompanyId,
        targetIssueId: result.issue.id,
        targetIssueIdentifier: result.issue.identifier,
        sourceCompanyId: req.body.sourceCompanyId,
        sourceIssueIdentifier: req.body.sourceIssueIdentifier,
        sourceCallbackUrl: req.body.sourceCallbackUrl,
        auditId: result.audit.id,
        requestedAssigneeAgentNameKey: req.body.requestedAssigneeAgentNameKey ?? null,
      });

      res.status(201).json({
        ...result.response,
        peerAuditId: result.audit.id,
        wokeAgentIds: wake.wokeAgentIds,
        assigneeUnresolved: wake.assigneeUnresolved,
      });
    },
  );

  // POST /api/companies/:targetCompanyId/peer-issues/:targetIssueIdentifier/comments
  router.post(
    "/companies/:targetCompanyId/peer-issues/:targetIssueIdentifier/comments",
    validate(peerIssueCommentBodySchema),
    async (req, res) => {
      assertAuthenticated(req);
      const targetCompanyId = req.params.targetCompanyId as string;
      const targetIssueIdentifier = req.params.targetIssueIdentifier as string;
      if (req.actor.type !== "agent" || !req.actor.agentId) {
        throw forbidden("Peer-issue endpoint requires agent authentication");
      }
      const actor = getActorInfo(req);

      const result = await svc.comment(targetCompanyId, targetIssueIdentifier, req.actor.agentId, {
        sourceCompanyId: req.body.sourceCompanyId,
        sourceAgentId: req.actor.agentId,
        sourceIssueIdentifier: req.body.sourceIssueIdentifier,
        sourceCallbackUrl: req.body.sourceCallbackUrl,
        body: req.body.body,
        guardrailAck: req.body.guardrailAck,
        idempotencyKey: req.body.idempotencyKey,
      });

      if (result.replayed) {
        res.status(200).json({ ...(result.response as object), replayed: true });
        return;
      }

      await logActivity(db, {
        companyId: targetCompanyId,
        actorType: "system",
        actorId: "peer-issue",
        agentId: null,
        runId: null,
        action: "comment.peer_created",
        entityType: "issue_comment",
        entityId: (result.comment as { id: string }).id,
        details: {
          issueIdentifier: targetIssueIdentifier,
          sourceCompanyId: req.body.sourceCompanyId,
          sourceIssueIdentifier: req.body.sourceIssueIdentifier,
          sourceAgentId: req.actor.agentId,
          peerAuditId: result.audit.id,
        },
      });
      await logActivity(db, {
        companyId: req.body.sourceCompanyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "comment.peer_created",
        entityType: "issue_comment",
        entityId: (result.comment as { id: string }).id,
        details: {
          direction: "outbound",
          targetCompanyId,
          targetIssueIdentifier,
          peerAuditId: result.audit.id,
        },
      });

      res.status(201).json({
        ...result.response,
        peerAuditId: result.audit.id,
      });
    },
  );

  // GET /api/companies/:companyId/peer-issue-audits?direction=inbound|outbound
  router.get("/companies/:companyId/peer-issue-audits", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const direction = auditDirectionSchema.parse(req.query.direction ?? "inbound");
    const rows = await svc.listAudits(companyId, direction);
    res.json(rows);
  });

  // POST /api/companies/:targetCompanyId/peer-grants  (board-only)
  router.post(
    "/companies/:targetCompanyId/peer-grants",
    validate(peerGrantCreateBodySchema),
    async (req, res) => {
      const targetCompanyId = req.params.targetCompanyId as string;
      assertCompanyAccess(req, targetCompanyId);
      if (req.actor.type !== "board") {
        throw forbidden("Peer grants can only be created by board actors");
      }
      const scopes = (req.body.scopes as string[]).map((s) => {
        if (!isValidPeerGrantScope(s)) throw badRequest(`Unknown peer grant scope: ${s}`);
        return s;
      });
      const grant = await grants.create(targetCompanyId, {
        agentId: req.body.agentId,
        scopes,
        grantedByUserId: req.actor.userId ?? "board",
        expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : null,
        notes: req.body.notes ?? null,
      });
      await logActivity(db, {
        companyId: targetCompanyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        agentId: null,
        runId: null,
        action: "peer_grant.created",
        entityType: "agent_peer_grant",
        entityId: grant.id,
        details: { agentId: grant.agentId, scopes: grant.scopes },
      });
      res.status(201).json(grant);
    },
  );

  // GET /api/companies/:targetCompanyId/peer-grants
  router.get("/companies/:targetCompanyId/peer-grants", async (req, res) => {
    const targetCompanyId = req.params.targetCompanyId as string;
    assertCompanyAccess(req, targetCompanyId);
    const activeOnly = req.query.active === "true" || req.query.active === "1";
    const rows = await grants.list(targetCompanyId, { activeOnly });
    res.json(rows);
  });

  // POST /api/companies/:targetCompanyId/peer-grants/:grantId/revoke
  router.post(
    "/companies/:targetCompanyId/peer-grants/:grantId/revoke",
    async (req, res) => {
      const targetCompanyId = req.params.targetCompanyId as string;
      const grantId = req.params.grantId as string;
      assertCompanyAccess(req, targetCompanyId);
      if (req.actor.type !== "board") {
        throw forbidden("Peer grants can only be revoked by board actors");
      }
      const grant = await grants.revoke(grantId, targetCompanyId);
      await logActivity(db, {
        companyId: targetCompanyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        agentId: null,
        runId: null,
        action: "peer_grant.revoked",
        entityType: "agent_peer_grant",
        entityId: grant.id,
        details: { agentId: grant.agentId },
      });
      res.json(grant);
    },
  );

  return router;
}
