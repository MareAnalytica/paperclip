import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { issuesBlockedQueueRoutes } from "../routes/issues-blocked-queue.js";
import { errorHandler } from "../middleware/index.js";

const listBlockedQueueMock = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    listBlockedQueue: listBlockedQueueMock,
  }),
}));

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issuesBlockedQueueRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("issues blocked-queue route RBAC", () => {
  it("403s when agent key points at a different company", async () => {
    const app = makeApp({
      type: "agent",
      agentId: "a1",
      companyId: "company-A",
      source: "agent_key",
    });
    listBlockedQueueMock.mockResolvedValue([]);

    const res = await request(app).get("/api/companies/company-B/issues/blocked-queue");
    expect(res.status).toBe(403);
    expect(listBlockedQueueMock).not.toHaveBeenCalled();
  });

  it("200s when board key is local_implicit", async () => {
    const app = makeApp({
      type: "board",
      source: "local_implicit",
    });
    listBlockedQueueMock.mockReset();
    listBlockedQueueMock.mockResolvedValue([{ id: "i1" }]);

    const res = await request(app).get("/api/companies/company-A/issues/blocked-queue");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "i1" }]);
    expect(listBlockedQueueMock).toHaveBeenCalledWith("company-A");
  });

  it("200s when agent key matches the requested company", async () => {
    const app = makeApp({
      type: "agent",
      agentId: "a1",
      companyId: "company-A",
      source: "agent_key",
    });
    listBlockedQueueMock.mockReset();
    listBlockedQueueMock.mockResolvedValue([]);

    const res = await request(app).get("/api/companies/company-A/issues/blocked-queue");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("401s when no actor present", async () => {
    const app = makeApp({ type: "none" });
    listBlockedQueueMock.mockReset();

    const res = await request(app).get("/api/companies/company-A/issues/blocked-queue");
    expect(res.status).toBe(401);
    expect(listBlockedQueueMock).not.toHaveBeenCalled();
  });
});
