import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { peerGrantRequestService } from "../services/peer-grant-requests.js";
import { validate } from "../middleware/validate.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";

const peerGrantRequestBodySchema = z.object({
  sourceCompanyId: z.string().uuid(),
  sourceIssueIdentifier: z.string().min(1).max(120),
  scopes: z.array(z.string()).min(1).max(8),
  reason: z.string().min(1).max(2000),
  requestedTtlSeconds: z.number().int().positive().optional().nullable(),
  requestedUses: z.number().int().positive().optional().nullable(),
});

const peerGrantDecisionBodySchema = z.object({
  reason: z.string().trim().max(4000).optional(),
});

const peerGrantRequestListQuerySchema = z.object({
  direction: z.enum(["source", "target"]).optional(),
  status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]).optional(),
});

function requireApproverAgent(req: import("express").Request) {
  assertAuthenticated(req);
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    throw forbidden("Peer-grant decisions require agent authentication");
  }
  return { agentId: req.actor.agentId, runId: req.actor.runId ?? null };
}

export function peerGrantRequestRoutes(db: Db) {
  const router = Router();
  const svc = peerGrantRequestService(db);

  // POST /api/companies/:targetCompanyId/peer-grant-requests
  router.post(
    "/companies/:targetCompanyId/peer-grant-requests",
    validate(peerGrantRequestBodySchema),
    async (req, res) => {
      assertAuthenticated(req);
      const targetCompanyId = req.params.targetCompanyId as string;
      if (req.actor.type !== "agent" || !req.actor.agentId) {
        throw forbidden("Peer-grant-request endpoint requires agent authentication");
      }
      // Server-derived source identity: body sourceCompanyId must equal the actor's company.
      if (req.body.sourceCompanyId !== req.actor.companyId) {
        throw forbidden("sourceCompanyId must match the requesting agent's company");
      }

      const result = await svc.create(targetCompanyId, {
        sourceCompanyId: req.body.sourceCompanyId,
        requestedByAgentId: req.actor.agentId,
        sourceIssueIdentifier: req.body.sourceIssueIdentifier,
        scopes: req.body.scopes,
        reason: req.body.reason,
        requestedTtlSeconds: req.body.requestedTtlSeconds ?? null,
        requestedUses: req.body.requestedUses ?? null,
        runId: req.actor.runId ?? null,
      });

      const responseBody = {
        requestId: result.request.id,
        status: result.request.status,
        interactionId: result.interactionId,
      };

      if (result.replayed) {
        res.status(200).json({ ...responseBody, replayed: true });
        return;
      }
      res.status(202).json({ ...responseBody, wokeApproverIds: result.wokeApproverIds });
    },
  );

  // POST /api/peer-grant-requests/:id/approve — source-company CEO mints the grant.
  router.post(
    "/peer-grant-requests/:id/approve",
    validate(peerGrantDecisionBodySchema),
    async (req, res) => {
      const approver = requireApproverAgent(req);
      const result = await svc.approve(req.params.id as string, approver, {
        decisionNote: req.body.reason ?? null,
      });
      res.status(200).json({
        requestId: result.request.id,
        status: result.request.status,
        grantId: result.grant?.id ?? null,
        wokeRequester: result.wokeRequester,
      });
    },
  );

  // POST /api/peer-grant-requests/:id/reject — source-company CEO declines.
  router.post(
    "/peer-grant-requests/:id/reject",
    validate(peerGrantDecisionBodySchema),
    async (req, res) => {
      const approver = requireApproverAgent(req);
      const result = await svc.reject(req.params.id as string, approver, {
        decisionNote: req.body.reason ?? null,
      });
      res.status(200).json({
        requestId: result.request.id,
        status: result.request.status,
        wokeRequester: result.wokeRequester,
      });
    },
  );

  // GET /api/companies/:companyId/peer-grant-requests — CEO inbox + source-issue history.
  router.get(
    "/companies/:companyId/peer-grant-requests",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const query = peerGrantRequestListQuerySchema.parse(req.query);
      const requests = await svc.list(companyId, {
        direction: query.direction,
        status: query.status,
      });
      res.status(200).json({ requests });
    },
  );

  return router;
}
