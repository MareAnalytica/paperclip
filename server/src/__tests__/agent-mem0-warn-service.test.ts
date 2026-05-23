import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockTrack = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: mockLoggerWarn },
}));


describe("recordAgentMem0UserIdGap", () => {
  beforeEach(() => {
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
    mockGetTelemetryClient.mockReset();
    mockGetTelemetryClient.mockReturnValue({ track: mockTrack });
    mockTrack.mockReset();
    mockLoggerWarn.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  const baseActor = {
    actorType: "user" as const,
    actorId: "board-user-1",
    agentId: null,
    runId: null,
  };

  it("warns + audit-logs + counts when MEM0_USER_ID is missing on create", async () => {
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const fakeDb = {} as never;

    const flagged = await recordAgentMem0UserIdGap(fakeDb, {
      companyId: "company-1",
      agent: {
        id: "agent-1",
        name: "Test Agent",
        role: "engineer",
        adapterConfig: { env: { OTHER: "value" } },
      },
      verb: "create",
      actor: baseActor,
    });

    expect(flagged).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toMatchObject({
      event: "agent_missing_mem0_user_id",
      companyId: "company-1",
      agentId: "agent-1",
      verb: "create",
      caller: "user",
      callerActorId: "board-user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      companyId: "company-1",
      action: "agent_missing_mem0_user_id",
      entityType: "agent",
      entityId: "agent-1",
      actorType: "user",
      actorId: "board-user-1",
      details: {
        verb: "create",
        caller: "user",
        callerActorId: "board-user-1",
        agentName: "Test Agent",
        agentRole: "engineer",
      },
    });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith("agent.missing_mem0_user_id", {
      company_id: "company-1",
      verb: "create",
      caller: "user",
    });
  });

  it("warns + audit-logs + counts when MEM0_USER_ID is an empty string on create", async () => {
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const flagged = await recordAgentMem0UserIdGap({} as never, {
      companyId: "company-1",
      agent: {
        id: "agent-2",
        adapterConfig: { env: { MEM0_USER_ID: "   " } },
      },
      verb: "create",
      actor: baseActor,
    });
    expect(flagged).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("does not warn when MEM0_USER_ID is set on create", async () => {
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const flagged = await recordAgentMem0UserIdGap({} as never, {
      companyId: "company-1",
      agent: {
        id: "agent-3",
        adapterConfig: { env: { MEM0_USER_ID: "company-1-engineer" } },
      },
      verb: "create",
      actor: baseActor,
    });
    expect(flagged).toBe(false);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it("flags PATCH updates that leave MEM0_USER_ID missing", async () => {
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const flagged = await recordAgentMem0UserIdGap({} as never, {
      companyId: "company-7",
      agent: {
        id: "agent-7",
        adapterConfig: { env: { OTHER: "value" } },
      },
      verb: "update",
      actor: {
        actorType: "agent",
        actorId: "agent-creator",
        agentId: "agent-creator",
        runId: "run-1",
      },
    });
    expect(flagged).toBe(true);
    expect(mockTrack).toHaveBeenCalledWith("agent.missing_mem0_user_id", {
      company_id: "company-7",
      verb: "update",
      caller: "agent",
    });
    expect(mockLogActivity.mock.calls[0][1]).toMatchObject({
      runId: "run-1",
      agentId: "agent-creator",
      details: { verb: "update", caller: "agent", callerActorId: "agent-creator" },
    });
  });

  it("survives a missing adapterConfig and treats it as a gap", async () => {
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const flagged = await recordAgentMem0UserIdGap({} as never, {
      companyId: "company-9",
      agent: { id: "agent-9" },
      verb: "create",
      actor: baseActor,
    });
    expect(flagged).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("still warns even if the audit-log insert throws", async () => {
    mockLogActivity.mockRejectedValueOnce(new Error("db down"));
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const flagged = await recordAgentMem0UserIdGap({} as never, {
      companyId: "company-x",
      agent: { id: "agent-x", adapterConfig: { env: {} } },
      verb: "create",
      actor: baseActor,
    });
    expect(flagged).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledTimes(2); // primary warn + audit-log failure warn
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it("skips the telemetry track when the telemetry client is disabled", async () => {
    mockGetTelemetryClient.mockReturnValueOnce(null);
    const { recordAgentMem0UserIdGap } = await import("../services/agent-mem0-warn.js");
    const flagged = await recordAgentMem0UserIdGap({} as never, {
      companyId: "company-z",
      agent: { id: "agent-z", adapterConfig: { env: {} } },
      verb: "create",
      actor: baseActor,
    });
    expect(flagged).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockTrack).not.toHaveBeenCalled();
  });
});
