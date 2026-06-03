import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  builtinDefaultCeoFlowPolicy,
  computePolicyHash,
  type ResolvedCeoFlowPolicy,
} from "../services/ceo-flow-policy.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
  ensureRoleDefaultGrants: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listFeedbackTraces: vi.fn(),
}));

const mockPolicyState = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/ceo-flow-policy.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/ceo-flow-policy.js")>();
  return {
    ...actual,
    getCeoFlowPolicyState: (...args: unknown[]) => mockPolicyState.fn(...args),
  };
});

function withOverride(companyId: string, heartbeatSec: number): ResolvedCeoFlowPolicy {
  const resolved = builtinDefaultCeoFlowPolicy();
  resolved.overrides.set(companyId, { ...resolved.default, heartbeatSec });
  return resolved;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = { type: "board", userId: "user-1", source: "local_implicit" };

describe("GET /api/companies/:companyId/effective-ceo-flow-policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({ id: "company-1", name: "Co" });
    mockPolicyState.fn.mockReturnValue({
      resolved: builtinDefaultCeoFlowPolicy(),
      loadError: null,
    });
  });

  it("returns the effective policy for a board caller", async () => {
    const app = await createApp(boardActor);

    const res = await request(app).get("/api/companies/company-1/effective-ceo-flow-policy");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe("company-1");
    expect(res.body.source).toBe("default");
    expect(res.body.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.policy.heartbeatSec).toBe(300);
    expect(res.body.policyHash).toBe(
      computePolicyHash(builtinDefaultCeoFlowPolicy().default),
    );
  });

  it("reports source=override and the override hash when a per-company entry exists", async () => {
    mockPolicyState.fn.mockReturnValue({
      resolved: withOverride("company-1", 600),
      loadError: null,
    });
    const app = await createApp(boardActor);

    const res = await request(app).get("/api/companies/company-1/effective-ceo-flow-policy");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("override");
    expect(res.body.policy.heartbeatSec).toBe(600);
    expect(res.body.policyHash).not.toBe(
      computePolicyHash(builtinDefaultCeoFlowPolicy().default),
    );
  });

  it("allows the company's own CEO agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/effective-ceo-flow-policy");

    expect(res.status).toBe(200);
    expect(res.body.companyId).toBe("company-1");
  });

  it("rejects a non-CEO agent of the same company with 403", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-2",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/companies/company-1/effective-ceo-flow-policy");

    expect(res.status).toBe(403);
    expect(mockPolicyState.fn).not.toHaveBeenCalled();
  });

  it("rejects an agent scoped to a different company with 403", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-9",
      companyId: "company-other",
      source: "agent_key",
      runId: "run-9",
    });

    const res = await request(app).get("/api/companies/company-1/effective-ceo-flow-policy");

    expect(res.status).toBe(403);
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown company", async () => {
    mockCompanyService.getById.mockResolvedValue(null);
    const app = await createApp(boardActor);

    const res = await request(app).get("/api/companies/ghost/effective-ceo-flow-policy");

    expect(res.status).toBe(404);
    expect(mockPolicyState.fn).not.toHaveBeenCalled();
  });

  it("returns 503 when the policy file failed to load", async () => {
    mockPolicyState.fn.mockReturnValue({
      resolved: builtinDefaultCeoFlowPolicy(),
      loadError: "ENOENT: no such file or directory",
    });
    const app = await createApp(boardActor);

    const res = await request(app).get("/api/companies/company-1/effective-ceo-flow-policy");

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("CEO flow policy failed to load");
  });
});
