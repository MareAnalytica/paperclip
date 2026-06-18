import { describe, expect, it } from "vitest";
import {
  extractClaudeRetryNotBefore,
  isClaudeProviderDisabledError,
  isClaudeTransientUpstreamError,
} from "./parse.js";

// The exact org/subscription-disabled block the Claude CLI surfaces (ELI-1075).
const DISABLED_SUBSCRIPTION_MESSAGE =
  "Your organization has disabled Claude subscription access for Claude Code · " +
  "Use an Anthropic API key instead, or ask your admin to enable access.";

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });

  it("does not classify the org/subscription-disabled block as transient (ELI-1075)", () => {
    // It is permanent-per-account, not a self-healing limit — must route to the
    // provider_disabled family instead of being swallowed as transient.
    expect(
      isClaudeTransientUpstreamError({ errorMessage: DISABLED_SUBSCRIPTION_MESSAGE }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: { is_error: true, result: DISABLED_SUBSCRIPTION_MESSAGE },
      }),
    ).toBe(false);
  });
});

describe("isClaudeProviderDisabledError", () => {
  it("classifies the exact org subscription-disabled block (ELI-1075)", () => {
    expect(
      isClaudeProviderDisabledError({ errorMessage: DISABLED_SUBSCRIPTION_MESSAGE }),
    ).toBe(true);
    expect(
      isClaudeProviderDisabledError({
        parsed: { is_error: true, result: DISABLED_SUBSCRIPTION_MESSAGE },
      }),
    ).toBe(true);
    expect(
      isClaudeProviderDisabledError({
        parsed: { is_error: true, errors: [{ message: DISABLED_SUBSCRIPTION_MESSAGE }] },
      }),
    ).toBe(true);
  });

  it("matches each documented marker independently and case-insensitively", () => {
    expect(
      isClaudeProviderDisabledError({ stderr: "ask your admin to enable access" }),
    ).toBe(true);
    expect(
      isClaudeProviderDisabledError({ stderr: "Use an Anthropic API key instead" }),
    ).toBe(true);
    expect(
      isClaudeProviderDisabledError({
        errorMessage: "ORG HAS DISABLED CLAUDE SUBSCRIPTION ACCESS",
      }),
    ).toBe(true);
  });

  it("does not fire on rate-limit, login, or generic failures (no bucket bleed)", () => {
    expect(
      isClaudeProviderDisabledError({ errorMessage: "Claude usage limit reached — weekly limit reached." }),
    ).toBe(false);
    expect(
      isClaudeProviderDisabledError({ stderr: "Please log in. Run `claude login` first." }),
    ).toBe(false);
    expect(isClaudeProviderDisabledError({ errorMessage: "HTTP 429: Too Many Requests" })).toBe(false);
    expect(isClaudeProviderDisabledError({})).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });

  it("parses a weekly limit reset that carries a date, not just a clock (ELI-864)", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "weekly limit · resets Jun 7, 2am (UTC)" },
      now,
    );
    // Must honour the real Jun 7 reset, not roll the clock to tomorrow.
    expect(extracted?.toISOString()).toBe("2026-06-07T02:00:00.000Z");
  });

  it("classifies the short 'weekly limit' wording (no 'reached') as transient", () => {
    expect(
      isClaudeTransientUpstreamError({ errorMessage: "weekly limit · resets Jun 7, 2am (UTC)" }),
    ).toBe(true);
  });
});
