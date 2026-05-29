import { describe, expect, it } from "vitest";
import {
  BOARD_NOTIFY_MARKER_PREFIX,
  buildCeoHeartbeatMarkdown,
  CEO_BOARD_FLOW_STATUSES,
  CEO_HEARTBEAT_TASK_KEY,
  isCeoHeartbeatControllerAgent,
  resolveBoardTelegramConfig,
} from "../services/heartbeat.ts";

describe("CEO heartbeat company-flow prompt", () => {
  it("detects CEO/controller agents from config and roles", () => {
    expect(isCeoHeartbeatControllerAgent({ name: "Eli", role: "board member", runtimeConfig: { heartbeat: { controllerRole: "ceo" } } })).toBe(true);
    expect(isCeoHeartbeatControllerAgent({ name: "CEO / Mission Owner", role: "Mission Owner", runtimeConfig: {} })).toBe(true);
    expect(isCeoHeartbeatControllerAgent({ name: "Platform Engineer", role: "engineer", runtimeConfig: {} })).toBe(false);
  });

  it("builds a right-to-left board flow prompt where CEO ensures reviewers rather than reviewing everything", () => {
    const emptySamples = Object.fromEntries(CEO_BOARD_FLOW_STATUSES.map((status) => [status, []]));
    const markdown = buildCeoHeartbeatMarkdown({
      generatedAt: "2026-05-13T12:00:00.000Z",
      counts: { in_review: 1, in_progress: 1, todo: 1, backlog: 1, blocked: 0, done: 1, cancelled: 0 },
      samples: {
        ...emptySamples,
        in_review: [{ identifier: "ELI-1", id: "1", title: "Review deliverable", status: "in_review", priority: "high", assigneeAgentName: "Reviewer", assigneeUserId: null, activeRunStatus: null }],
        in_progress: [{ identifier: "ELI-2", id: "2", title: "Implement feature", status: "in_progress", priority: "medium", assigneeAgentName: "Engineer", assigneeUserId: null, activeRunStatus: "running" }],
        todo: [{ identifier: "ELI-3", id: "3", title: "Start work", status: "todo", priority: "medium", assigneeAgentName: "Engineer", assigneeUserId: null, activeRunStatus: null }],
        backlog: [{ identifier: "ELI-4", id: "4", title: "Promote if ready", status: "backlog", priority: "low", assigneeAgentName: null, assigneeUserId: null, activeRunStatus: null }],
        done: [{ identifier: "ELI-5", id: "5", title: "Audit done", status: "done", priority: "low", assigneeAgentName: null, assigneeUserId: null, activeRunStatus: null }],
      },
    });

    expect(CEO_HEARTBEAT_TASK_KEY).toBe("__ceo_company_flow__:2026-05-29.board-notify.v4");
    expect(markdown).toContain("Instruction version: 2026-05-29.board-notify.v4");
    expect(markdown).toContain("CEO/controller heartbeat for the whole company board");
    expect(markdown).toContain("You do not need to personally review every deliverable");
    expect(markdown).toContain("make review somebody’s job inside the company");
    expect(markdown).toContain("the Merge Request/Pull Request author must request review from the designated reviewing agent");
    expect(markdown).toContain("If the designated reviewer is unavailable, blocked, conflicted, or rate-limited, create or wake a contingency reviewer");
    expect(markdown).toContain("Ask the human board only for budget, credentials, irreversible external actions, policy exceptions, or explicit product/business choices");
    expect(markdown).toContain("Classify every blocker before you wait");
    expect(markdown).toContain("payload.decisionClass='human_only'");
    // With no boardTelegram configured the prompt must NOT hard-code a board group.
    expect(markdown).not.toContain("Mare Operator HQ");
    expect(markdown).toContain("no board Telegram group configured");
    expect(markdown).toContain("superseded by merged work");
    expect(markdown).toContain("ensure reviews/approvals happen as soon as possible");
    expect(markdown).toContain("Move backlog items to todo when they should now start");
    expect(markdown.indexOf("### in_review focus sample")).toBeLessThan(markdown.indexOf("### in_progress focus sample"));
    expect(markdown.indexOf("### in_progress focus sample")).toBeLessThan(markdown.indexOf("### todo focus sample"));
    expect(markdown.indexOf("### todo focus sample")).toBeLessThan(markdown.indexOf("### backlog focus sample"));
    expect(markdown).toContain("ELI-1");
    expect(markdown).toContain("owner: Reviewer");
  });
});

describe("CEO heartbeat board-notify step (ELI-437)", () => {
  const emptySamples = () => Object.fromEntries(CEO_BOARD_FLOW_STATUSES.map((status) => [status, []]));
  const baseInput = () => ({
    generatedAt: "2026-05-29T12:00:00.000Z",
    counts: { in_review: 0, in_progress: 0, todo: 0, backlog: 0, blocked: 0, done: 0, cancelled: 0 },
    samples: emptySamples() as Record<string, never[]>,
  });

  describe("resolveBoardTelegramConfig", () => {
    it("reads channelName + chatId from the CEO runtimeConfig.heartbeat.boardTelegram", () => {
      expect(
        resolveBoardTelegramConfig({ heartbeat: { boardTelegram: { channelName: "Mare Operator HQ", chatId: "-100123" } } }),
      ).toEqual({ channelName: "Mare Operator HQ", chatId: "-100123" });
    });

    it("returns null when the block is missing or incomplete (safe no-op)", () => {
      expect(resolveBoardTelegramConfig(null)).toBeNull();
      expect(resolveBoardTelegramConfig({})).toBeNull();
      expect(resolveBoardTelegramConfig({ heartbeat: {} })).toBeNull();
      expect(resolveBoardTelegramConfig({ heartbeat: { boardTelegram: { channelName: "HQ" } } })).toBeNull();
      expect(resolveBoardTelegramConfig({ heartbeat: { boardTelegram: { chatId: "-100123" } } })).toBeNull();
    });
  });

  it("uses the configured board group for board-decision routing (no hard-coded company)", () => {
    const markdown = buildCeoHeartbeatMarkdown({
      ...baseInput(),
      boardTelegram: { channelName: "Acme Board HQ", chatId: "-100999" },
    });
    expect(markdown).toContain("Acme Board HQ");
    expect(markdown).not.toContain("Mare Operator HQ");
  });

  it("instructs exactly-one notice + suppression marker for pending board-notify closures", () => {
    const markdown = buildCeoHeartbeatMarkdown({
      ...baseInput(),
      boardTelegram: { channelName: "Mare Operator HQ", chatId: "-100123" },
      pendingBoardNotices: [{ identifier: "ELI-428", id: "abc", title: "Governance report" }],
    });
    expect(markdown).toContain("### Board notices to send (board-notify closures)");
    expect(markdown).toContain("post exactly ONE concise completion notice to the board Telegram group Mare Operator HQ");
    expect(markdown).toContain("Hermes-cluster Eli relay");
    expect(markdown).toContain("NOT a human_only board decision");
    expect(markdown).toContain(BOARD_NOTIFY_MARKER_PREFIX);
    expect(markdown).toContain("Routine internal churn, PR reviews, and build failures must NEVER trigger a board notice");
    expect(markdown).toContain("ELI-428 (id abc): Governance report");
  });

  it("emits no board-notice section when nothing is pending (anti-spam)", () => {
    const markdown = buildCeoHeartbeatMarkdown({
      ...baseInput(),
      boardTelegram: { channelName: "Mare Operator HQ", chatId: "-100123" },
      pendingBoardNotices: [],
    });
    expect(markdown).not.toContain("Board notices to send");
  });

  it("no-ops board notices when pending closures exist but no boardTelegram is configured", () => {
    const markdown = buildCeoHeartbeatMarkdown({
      ...baseInput(),
      boardTelegram: null,
      pendingBoardNotices: [{ identifier: "ELI-428", id: "abc", title: "Governance report" }],
    });
    expect(markdown).toContain("Board notices to send");
    expect(markdown).toContain("no board Telegram group configured");
    expect(markdown).toContain("post nothing");
  });
});
