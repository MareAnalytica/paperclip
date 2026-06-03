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
}));

const mockPolicyState = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
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

function company(id: string, status = "active") {
  return { id, name: `Co ${id}`, status };
}

async function createApp(actor: Record<string, unknown> | null) {
  const [{ ceoFlowPolicyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/ceo-flow-policy.js")>("../routes/ceo-flow-policy.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor) (req as any).actor = actor;
    next();
  });
  app.use("/api", ceoFlowPolicyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = { type: "board", userId: "user-1", source: "local_implicit" };
const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1" };

const URL = "/api/effective-ceo-flow-policy/dashboard";

describe("GET /api/effective-ceo-flow-policy/dashboard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/ceo-flow-policy.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockPolicyState.fn.mockReturnValue({
      resolved: builtinDefaultCeoFlowPolicy(),
      loadError: null,
    });
    mockCompanyService.list.mockResolvedValue([
      company("company-a"),
      company("company-b"),
      company("company-c"),
    ]);
  });

  it("returns one row per active company for a board caller", async () => {
    const app = await createApp(boardActor);

    const res = await request(app).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.rows).toHaveLength(3);
    const row = res.body.rows[0];
    expect(row.companyId).toBe("company-a");
    expect(row.source).toBe("default");
    expect(row.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.heartbeatSec).toBe(300);
    expect(row.promptInsertKey).toBe(builtinDefaultCeoFlowPolicy().default.promptInsertKey);
    expect(row.policyHash).toBe(computePolicyHash(builtinDefaultCeoFlowPolicy().default));
  });

  it("reports source=override and the override hash for tuned companies", async () => {
    mockPolicyState.fn.mockReturnValue({
      resolved: withOverride("company-b", 600),
      loadError: null,
    });
    const app = await createApp(boardActor);

    const res = await request(app).get(URL);

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.rows.map((r: any) => [r.companyId, r]));
    expect(byId["company-b"].source).toBe("override");
    expect(byId["company-b"].heartbeatSec).toBe(600);
    expect(byId["company-a"].source).toBe("default");
    expect(byId["company-b"].policyHash).not.toBe(byId["company-a"].policyHash);
  });

  it("excludes archived companies", async () => {
    mockCompanyService.list.mockResolvedValue([
      company("company-a"),
      company("company-b", "archived"),
      company("company-c", "paused"),
    ]);
    const app = await createApp(boardActor);

    const res = await request(app).get(URL);

    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: any) => r.companyId)).toEqual(["company-a"]);
  });

  it("paginates with limit + opaque cursor, capping at 1000", async () => {
    mockCompanyService.list.mockResolvedValue([
      company("c1"),
      company("c2"),
      company("c3"),
    ]);
    const app = await createApp(boardActor);

    const page1 = await request(app).get(`${URL}?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.rows.map((r: any) => r.companyId)).toEqual(["c1", "c2"]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    const page2 = await request(app).get(
      `${URL}?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.rows.map((r: any) => r.companyId)).toEqual(["c3"]);
    expect(page2.body.nextCursor).toBeNull();
  });

  it("rejects an invalid limit with 400", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`${URL}?limit=0`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed cursor with 400", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(`${URL}?cursor=%00%00`);
    expect(res.status).toBe(400);
  });

  it("returns 403 for a non-board (agent) caller", async () => {
    const app = await createApp(agentActor);
    const res = await request(app).get(URL);
    expect(res.status).toBe(403);
    expect(mockCompanyService.list).not.toHaveBeenCalled();
  });

  it("returns 503 when the policy file failed to load", async () => {
    mockPolicyState.fn.mockReturnValue({
      resolved: builtinDefaultCeoFlowPolicy(),
      loadError: "unresolved env var ELI_CEO_FLOW_POLICY_PATH",
    });
    const app = await createApp(boardActor);

    const res = await request(app).get(URL);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/failed to load/i);
  });
});
