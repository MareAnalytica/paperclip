import { describe, expect, it } from "vitest";
import {
  buildCeoHeartbeatMarkdown,
  CEO_BOARD_FLOW_STATUSES,
  CEO_HEARTBEAT_TASK_KEY,
  isCeoHeartbeatControllerAgent,
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

    expect(CEO_HEARTBEAT_TASK_KEY).toContain("__ceo_company_flow__");
    expect(markdown).toContain("CEO/controller heartbeat for the whole company board");
    expect(markdown).toContain("You do not need to personally review every deliverable");
    expect(markdown).toContain("ensure reviews/approvals happen as soon as possible");
    expect(markdown).toContain("Move backlog items to todo when they should now start");
    expect(markdown.indexOf("### in_review focus sample")).toBeLessThan(markdown.indexOf("### in_progress focus sample"));
    expect(markdown.indexOf("### in_progress focus sample")).toBeLessThan(markdown.indexOf("### todo focus sample"));
    expect(markdown.indexOf("### todo focus sample")).toBeLessThan(markdown.indexOf("### backlog focus sample"));
    expect(markdown).toContain("ELI-1");
    expect(markdown).toContain("owner: Reviewer");
  });
});
