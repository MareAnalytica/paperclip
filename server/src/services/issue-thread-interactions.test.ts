import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    createChild: mockCreateChild,
  }),
}));

type SelectRow = Record<string, unknown>;

function createSelectChain(rows: SelectRow[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(callback: (rows: SelectRow[]) => unknown) {
              return Promise.resolve(callback(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Record<string, unknown>;
  parentRows?: SelectRow[];
}) {
  let interactionRow = { ...args.interactionRow };
  const issueTouches: Array<Record<string, unknown>> = [];
  const interactionUpdates: Array<Record<string, unknown>> = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      return createSelectChain(selectCallCount === 1 ? [interactionRow] : (args.parentRows ?? []));
    }),
    update: vi.fn((table: unknown) => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionUpdates.push(values);
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error(`Unexpected update target: ${String(table)}`);
          },
        };
      },
    })),
    insert: vi.fn(),
    transaction: async (callback: (tx: typeof db) => Promise<void>) => callback(db),
  };

  return {
    db,
    getInteractionRow: () => interactionRow,
    issueTouches,
    interactionUpdates,
  };
}

describe("issueThreadInteractionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  describe("hydrate read-path guard (DEE-582)", () => {
    const baseRow = {
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: null,
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const validSuggest = {
      ...baseRow,
      id: "i-valid",
      kind: "suggest_tasks",
      payload: { version: 1, tasks: [{ clientKey: "t1", title: "One" }] },
      result: null,
    };
    // DEE-441 failure mode: legacy result.outcome:"declined" is not in the enum.
    const poisonConfirm = {
      ...baseRow,
      id: "i-poison",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Confirm?" },
      result: { version: 1, outcome: "declined" },
    };
    const validAsk = {
      ...baseRow,
      id: "i-valid-2",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          { id: "q1", prompt: "Pick", selectionMode: "single", options: [{ id: "o1", label: "L" }] },
        ],
      },
      result: null,
    };

    it("listForIssue returns 200-equivalent results with one poison row degraded, valid rows intact", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

      const rows = [validSuggest, poisonConfirm, validAsk];
      const db: any = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              orderBy: async () => rows,
            }),
          }),
        })),
      };

      const svc = issueThreadInteractionService(db as never);
      const list = await svc.listForIssue("11111111-1111-4111-8111-111111111111");

      expect(list).toHaveLength(3);

      const poison = list.find((i) => i.id === "i-poison")!;
      expect(poison.result).toBeNull();
      expect(poison.unparseableResult).toBe(true);
      expect(poison.unparseablePayload).toBeUndefined();
      expect(typeof poison.parseErrorCode).toBe("string");
      // raw payload (which is valid here) is preserved and the row stays visible
      expect(poison.kind).toBe("request_confirmation");

      const valid = list.find((i) => i.id === "i-valid")!;
      expect(valid.unparseableResult).toBeUndefined();
      expect(valid.unparseablePayload).toBeUndefined();
      expect(valid.parseErrorCode).toBeUndefined();

      const valid2 = list.find((i) => i.id === "i-valid-2")!;
      expect(valid2.unparseableResult).toBeUndefined();
      expect(valid2.unparseablePayload).toBeUndefined();
    });

    it("getById returns a degraded interaction for a poison row instead of throwing", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

      const db: any = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              then: (cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([poisonConfirm])),
            }),
          }),
        })),
      };

      const svc = issueThreadInteractionService(db as never);
      const got = await svc.getById("i-poison");

      expect(got).not.toBeNull();
      expect(got!.result).toBeNull();
      expect(got!.unparseableResult).toBe(true);
    });

    it("hydrates a row with an unparseable payload by preserving the raw payload and flagging it", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

      const poisonPayload = {
        ...baseRow,
        id: "i-bad-payload",
        kind: "suggest_tasks",
        // missing required `tasks` -> payload schema fails
        payload: { version: 1, garbage: true },
        result: null,
      };
      const db: any = {
        select: vi.fn(() => ({
          from: () => ({
            where: () => ({
              orderBy: async () => [poisonPayload],
            }),
          }),
        })),
      };

      const svc = issueThreadInteractionService(db as never);
      const list = await svc.listForIssue("11111111-1111-4111-8111-111111111111");

      expect(list).toHaveLength(1);
      expect(list[0].unparseablePayload).toBe(true);
      // raw payload preserved (not dropped) so the row stays repairable
      expect((list[0].payload as unknown as Record<string, unknown>).garbage).toBe(true);
    });

    it("expirePendingForTerminalIssue resolves a pending poison-payload row instead of throwing (DEE-582 AC)", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

      const pendingPoisonPayload = {
        ...baseRow,
        id: "i-exp",
        kind: "request_confirmation",
        // missing required `prompt` -> payload schema fails on read; old code would throw here
        payload: { version: 1 },
        result: null,
      };
      const { db } = createFakeDb({ interactionRow: pendingPoisonPayload });
      const svc = issueThreadInteractionService(db as never);

      const expired = await svc.expirePendingForTerminalIssue(
        { id: "11111111-1111-4111-8111-111111111111", companyId: "company-1", status: "done" },
        { agentId: "agent-x" },
      );

      expect(expired).toHaveLength(1);
      expect(expired[0].status).toBe("expired");
      // terminal auto-resolve still wrote a valid result...
      expect((expired[0].result as { outcome?: string } | null)?.outcome).toBe("issue_terminal_status");
      // ...and the unparseable payload was degraded-but-flagged rather than throwing
      expect(expired[0].unparseablePayload).toBe(true);
    });

    it("historical-supersede catch-up does not throw on a pending request_confirmation with a null payload (DEE-582 read-path AC)", async () => {
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

      // GET /interactions runs expireRequestConfirmationsSupersededByHistoricalComments
      // BEFORE listForIssue. That path hydrates each pending request_confirmation and reads
      // payload.supersedeOnUserComment. A null/non-object payload would dereference-throw and
      // 500 the whole read path — the exact one-poison-row outage this issue closes.
      const pendingNullPayload = {
        ...baseRow,
        id: "i-super-null",
        kind: "request_confirmation",
        payload: null, // non-object: payload.supersedeOnUserComment would throw without the guard
        result: null,
      };
      const userComment = {
        id: "c-1",
        companyId: "company-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        authorUserId: "user-1",
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      };

      let call = 0;
      const db: any = {
        select: vi.fn(() => {
          call += 1;
          if (call === 1) {
            // interactions query (awaited directly)
            return { from: () => ({ where: async () => [pendingNullPayload] }) };
          }
          // comments query (chains .orderBy)
          return { from: () => ({ where: () => ({ orderBy: async () => [userComment] }) }) };
        }),
      };

      const svc = issueThreadInteractionService(db as never);

      // Must not throw; the degraded row simply does not participate in supersede.
      const expired = await svc.expireRequestConfirmationsSupersededByHistoricalComments({
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
      });

      expect(expired).toEqual([]);
    });
  });

  it("create reuses an existing interaction for the same idempotency key", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const existingRow = {
      id: "interaction-1",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      sourceCommentId: null,
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };

    const db: any = {
      select: vi.fn(() => createSelectChain([existingRow])),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const svc = issueThreadInteractionService(db as never);
    const created = await svc.create({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, {
      kind: "suggest_tasks",
      idempotencyKey: "run-1:suggest",
      sourceRunId: "22222222-2222-4222-8222-222222222222",
      title: "Break the work down",
      summary: "Created from the current agent run.",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    }, {
      agentId: "agent-1",
    });

    expect(created.id).toBe("interaction-1");
    expect(created.idempotencyKey).toBe("run-1:suggest");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("answerQuestions normalizes duplicate option ids and persists answered results", async () => {
    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");

    const interactionRow = {
      id: "interaction-2",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      sourceCommentId: null,
      sourceRunId: null,
      title: null,
      summary: null,
      createdByAgentId: null,
      createdByUserId: "local-board",
      resolvedByAgentId: null,
      resolvedByUserId: null,
      payload: {
        version: 1,
        questions: [
          {
            id: "scope",
            prompt: "Pick one scope",
            selectionMode: "single",
            required: true,
            options: [
              { id: "phase-1", label: "Phase 1" },
              { id: "phase-2", label: "Phase 2" },
            ],
          },
          {
            id: "extras",
            prompt: "Pick extras",
            selectionMode: "multi",
            options: [
              { id: "tests", label: "Tests" },
              { id: "docs", label: "Docs" },
            ],
          },
        ],
      },
      result: null,
      resolvedAt: null,
      createdAt: new Date("2026-04-20T10:00:00.000Z"),
      updatedAt: new Date("2026-04-20T10:00:00.000Z"),
    };
    const state = createFakeDb({ interactionRow });
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.answerQuestions({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
    }, "interaction-2", {
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests", "docs"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    }, {
      userId: "local-board",
    });

    expect(result.status).toBe("answered");
    expect(result.result).toEqual({
      version: 1,
      answers: [
        { questionId: "scope", optionIds: ["phase-1"] },
        { questionId: "extras", optionIds: ["docs", "tests"] },
      ],
      summaryMarkdown: "Phase 1 with tests and docs.",
    });
    expect(state.interactionUpdates).toHaveLength(1);
    expect(state.issueTouches).toHaveLength(1);
  });
});
