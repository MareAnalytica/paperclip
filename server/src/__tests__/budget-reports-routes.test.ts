import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route-level coverage for the §6.1 burn and §6.4 forecast endpoints: auth,
// query parsing/validation, and that the parsed options reach the service.

function makeDb() {
  return {} as any;
}

const mockBurn = vi.hoisted(() => vi.fn());
const mockForecast = vi.hoisted(() => vi.fn());

const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const noopService = vi.hoisted(() => () => ({}) as any);

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    budgetService: noopService,
    budgetReportService: () => ({ burn: mockBurn, forecast: mockForecast }),
    costService: noopService,
    financeService: noopService,
    companyService: noopService,
    agentService: noopService,
    issueService: noopService,
    heartbeatService: () => mockHeartbeatService,
    logActivity: vi.fn(),
  }));
  vi.doMock("../services/quota-windows.js", () => ({ fetchAllQuotaWindows: vi.fn() }));
}

async function createApp(actor: any) {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb()));
  app.use(errorHandler);
  return app;
}

const boardActor = { type: "board", userId: "board-user", source: "local_implicit" };

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/quota-windows.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockBurn.mockResolvedValue({
    scope: "company",
    scopeKey: "company-1",
    window: "month",
    windowStart: "2026-06-01T00:00:00.000Z",
    windowEnd: "2026-07-01T00:00:00.000Z",
    spendMicros: 1_000_000,
    limitMicros: 5_000_000,
    percent: 20,
    projectedSpendMicros: 4_000_000,
    projectedPercent: 80,
    topAttributable: [{ dimension: "agent", key: "agent-1", spendMicros: 1_000_000 }],
  });
  mockForecast.mockResolvedValue({ mode: "linear", minEventsForForecast: 5, caps: [] });
});

describe("GET /companies/:id/budget/burn", () => {
  it("returns the §6.1 burn shape and defaults to company/month", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/budget/burn");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ spendMicros: 1_000_000, limitMicros: 5_000_000, projectedPercent: 80 });
    expect(res.body.topAttributable[0]).toMatchObject({ dimension: "agent", key: "agent-1" });
    expect(mockBurn).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ scope: "company", window: "month", topN: 1 }),
    );
  });

  it("parses scope, window, dimensions and topN", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(
      "/api/companies/company-1/budget/burn?scope=agent&scopeKey=agent-9&window=rolling_24h&dimensions=agent,model&topN=3",
    );
    expect(res.status).toBe(200);
    expect(mockBurn).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        scope: "agent",
        scopeKey: "agent-9",
        window: "rolling_24h",
        dimensions: ["agent", "model"],
        topN: 3,
      }),
    );
  });

  it("rejects an invalid window with 400", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/budget/burn?window=fortnight");
    expect(res.status).toBe(400);
    expect(mockBurn).not.toHaveBeenCalled();
  });

  it("rejects an invalid dimension with 400", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/budget/burn?dimensions=agent,wallet");
    expect(res.status).toBe(400);
  });

  it("forbids an agent reading another company", async () => {
    const app = await createApp({ type: "agent", agentId: "a1", companyId: "other-co" });
    const res = await request(app).get("/api/companies/company-1/budget/burn");
    expect(res.status).toBe(403);
    expect(mockBurn).not.toHaveBeenCalled();
  });
});

describe("GET /companies/:id/budget/forecast", () => {
  it("returns the forecast envelope and defaults to linear", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/budget/forecast");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "linear", minEventsForForecast: 5, caps: [] });
    expect(mockForecast).toHaveBeenCalledWith("company-1", expect.objectContaining({}));
  });

  it("parses mode, minEvents and recentWindowHours", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get(
      "/api/companies/company-1/budget/forecast?mode=recent_window&minEvents=12&recentWindowHours=1.5",
    );
    expect(res.status).toBe(200);
    expect(mockForecast).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ mode: "recent_window", minEvents: 12, recentWindowHours: 1.5 }),
    );
  });

  it("rejects an invalid mode with 400", async () => {
    const app = await createApp(boardActor);
    const res = await request(app).get("/api/companies/company-1/budget/forecast?mode=psychic");
    expect(res.status).toBe(400);
    expect(mockForecast).not.toHaveBeenCalled();
  });
});
