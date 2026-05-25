import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { assertCompanyAccess } from "./authz.js";

export function issuesBlockedQueueRoutes(db: Db) {
  const router = Router();
  const svc = issueService(db);

  router.get("/companies/:companyId/issues/blocked-queue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listBlockedQueue(companyId);
    res.json(result);
  });

  return router;
}
