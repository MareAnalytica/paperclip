import { describe, expect, it } from "vitest";
import { createIssueThreadInteractionSchema } from "./validators/issue.js";

describe("issue thread interaction schemas", () => {
  it("parses request_confirmation payloads with default no-wake continuation", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Revise",
        rejectRequiresReason: true,
        rejectReasonLabel: "What needs to change?",
        declineReasonPlaceholder: "Optional: tell the agent what you'd change.",
        detailsMarkdown: "The current plan document will be accepted as-is.",
        supersedeOnUserComment: true,
      },
    });

    expect(parsed).toMatchObject({
      kind: "request_confirmation",
      continuationPolicy: "none",
      payload: {
        prompt: "Apply this plan?",
        acceptLabel: "Apply",
        rejectLabel: "Revise",
        rejectRequiresReason: true,
        rejectReasonLabel: "What needs to change?",
        allowDeclineReason: true,
        declineReasonPlaceholder: "Optional: tell the agent what you'd change.",
        supersedeOnUserComment: true,
      },
    });
  });


  it("parses explicit human-only board decision routing metadata", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "ask_user_questions",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        title: "Board decision required",
        decisionClass: "human_only",
        decisionSubject: {
          type: "repository_history_strategy",
          repository: "MareAnalytica/eli-board",
          issueIdentifier: "ELI-132",
          summary: "Choose a reconciliation strategy.",
        },
        boardNotification: {
          platform: "telegram",
          channelName: "Mare Operator HQ",
          target: "telegram:Mare Operator HQ",
          required: true,
          safetyTier: "legal",
          messageMarkdown: "ELI-132 needs a repository-history strategy decision.",
        },
        questions: [{
          id: "strategy",
          prompt: "Which reconciliation strategy should Eli use?",
          selectionMode: "single",
          options: [{ id: "cherry-pick", label: "Cherry-pick Timeline B artifacts" }],
        }],
      },
    });

    expect(parsed.kind).toBe("ask_user_questions");
    if (parsed.kind !== "ask_user_questions") return;
    expect(parsed.payload.decisionClass).toBe("human_only");
    expect(parsed.payload.decisionSubject).toMatchObject({
      type: "repository_history_strategy",
      repository: "MareAnalytica/eli-board",
    });
    expect(parsed.payload.boardNotification).toMatchObject({
      platform: "telegram",
      channelName: "Mare Operator HQ",
      required: true,
      safetyTier: "legal",
    });
  });

  it("accepts issue document targets for request_confirmation interactions", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee_on_accept",
      payload: {
        version: 1,
        prompt: "Accept the latest plan revision?",
        allowDeclineReason: false,
        target: {
          type: "issue_document",
          issueId: "11111111-1111-4111-8111-111111111111",
          documentId: "22222222-2222-4222-8222-222222222222",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 2,
          label: "Plan v2",
          href: "/issues/PAP-123#document-plan",
        },
      },
    });

    expect(parsed.kind).toBe("request_confirmation");
    if (parsed.kind !== "request_confirmation") return;
    expect(parsed.payload.target).toMatchObject({
      type: "issue_document",
      key: "plan",
      revisionNumber: 2,
      label: "Plan v2",
      href: "/issues/PAP-123#document-plan",
    });
  });

  it("accepts custom targets for request_confirmation interactions", () => {
    const parsed = createIssueThreadInteractionSchema.parse({
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed with the external checklist?",
        target: {
          type: "custom",
          key: "external-checklist",
          revisionId: "checklist-v1",
          revisionNumber: 1,
          label: "Checklist v1",
          href: "https://example.com/checklist",
        },
      },
    });

    expect(parsed.kind).toBe("request_confirmation");
    if (parsed.kind !== "request_confirmation") return;
    expect(parsed.payload.target).toMatchObject({
      type: "custom",
      key: "external-checklist",
      label: "Checklist v1",
    });
  });

  it("rejects unsafe request_confirmation target hrefs", () => {
    const base = {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Proceed?",
        target: {
          type: "custom",
          key: "external-checklist",
          revisionId: "checklist-v1",
          label: "Checklist v1",
        },
      },
    } as const;

    for (const href of ["javascript:alert(1)", "data:text/html,hi", "//evil.example/path"]) {
      expect(() => createIssueThreadInteractionSchema.parse({
        ...base,
        payload: {
          ...base.payload,
          target: {
            ...base.payload.target,
            href,
          },
        },
      })).toThrow("href must not use javascript:, data:, or protocol-relative URLs");
    }
  });
});
