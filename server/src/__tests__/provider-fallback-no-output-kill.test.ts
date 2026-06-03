import { describe, expect, it } from "vitest";

import { isProviderFallbackEligibleError } from "../services/heartbeat.js";

// Contract B (ELI-951 / execution-semantics §12): a Contract-A (ELI-950) idle
// no-output kill on a *non-primary fallback adapter* is provider-fallback-
// eligible so the chain advances past the wedged hop. It is gated to the hang
// class AND to a fallback hop, and composes with the auth-model precedence
// (ELI-901) and the limit-marker safety net (ELI-902).
//
// A no-output kill is surfaced as a `timed_out` run whose distinct signal is
// preserved two ways by the finalizer: the errorCode
// `adapter_no_output_timeout` (kept rather than collapsed to the generic
// `timeout`) and `resultJson.errorMeta.noOutput === true`. Either identifies the
// hang class — these tests exercise both.

const NO_OUTPUT_CODE = "adapter_no_output_timeout";

// A no-output kill carrying the distinct preserved errorCode.
function noOutputKillByCode() {
  return {
    errorCode: NO_OUTPUT_CODE,
    error: "Grok produced no output for 600s (idle no-output deadline)",
    resultJson: { errorMeta: { noOutput: true, noOutputKillSec: 600 } } as Record<string, unknown>,
  };
}

// A no-output kill where only the structured errorMeta survives (errorCode
// collapsed to the generic `timeout`) — the belt-and-suspenders detection path.
function noOutputKillByMeta() {
  return {
    errorCode: "timeout",
    error: "Grok produced no output for 600s (idle no-output deadline)",
    resultJson: { errorMeta: { noOutput: true, noOutputKillSec: 600 } } as Record<string, unknown>,
  };
}

// A bare wall-clock timeout — NOT a no-output hang. No errorMeta.noOutput.
function wallClockTimeout() {
  return {
    errorCode: "timeout",
    error: "Timed out after 1800s",
    resultJson: {} as Record<string, unknown>,
  };
}

describe("Contract B — no-output kill on a fallback hop (ELI-951)", () => {
  describe("eligibility is gated to the hang class on a fallback hop", () => {
    it("a no-output kill (errorCode) on a fallback hop is eligible", () => {
      expect(
        isProviderFallbackEligibleError(noOutputKillByCode(), null, [], { onFallbackHop: true }),
      ).toBe(true);
    });

    it("a no-output kill detected via errorMeta.noOutput on a fallback hop is eligible", () => {
      expect(
        isProviderFallbackEligibleError(noOutputKillByMeta(), null, [], { onFallbackHop: true }),
      ).toBe(true);
    });

    it("a no-output kill on the PRIMARY adapter is NOT auto-eligible", () => {
      // No hop ⇒ a hang on the primary is left as a terminal timeout; it must not
      // silently consume the fallback chain.
      expect(
        isProviderFallbackEligibleError(noOutputKillByCode(), null, [], { onFallbackHop: false }),
      ).toBe(false);
      // Omitting opts entirely defaults to primary (not a hop).
      expect(isProviderFallbackEligibleError(noOutputKillByCode(), null, [])).toBe(false);
    });

    it("a bare wall-clock timeout on a fallback hop is NOT eligible", () => {
      // Only the no-output hang class hops; a wall-clock timeout is not otherwise
      // fallback-eligible.
      expect(
        isProviderFallbackEligibleError(wallClockTimeout(), null, [], { onFallbackHop: true }),
      ).toBe(false);
    });
  });

  describe("composes with auth precedence (ELI-901) and native classification", () => {
    it("a raw-key auth failure on a hop still does NOT consume the chain", () => {
      // The native auth gate short-circuits before Contract B: a raw-key auth
      // error is permanent, not a hang, even on a fallback hop.
      const rawKeyAuthFailure = {
        errorCode: "claude_auth_required",
        error: "invalid api key",
        resultJson: null,
      };
      expect(
        isProviderFallbackEligibleError(rawKeyAuthFailure, "raw-key", [], { onFallbackHop: true }),
      ).toBe(false);
    });

    it("an oauth-session auth failure on a hop stays eligible (unchanged)", () => {
      const oauthAuthFailure = {
        errorCode: "codex_session_expired",
        error: null,
        resultJson: null,
      };
      expect(
        isProviderFallbackEligibleError(oauthAuthFailure, "oauth-session", [], { onFallbackHop: true }),
      ).toBe(true);
    });

    it("a native transient_upstream failure is eligible regardless of hop (native wins)", () => {
      const transient = {
        errorCode: "claude_transient_upstream",
        error: null,
        resultJson: { errorFamily: "transient_upstream" } as Record<string, unknown>,
      };
      expect(isProviderFallbackEligibleError(transient, null, [], { onFallbackHop: false })).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("existing 2-/3-arg calls are unaffected (no-output kill is inert without the hop flag)", () => {
      expect(isProviderFallbackEligibleError(noOutputKillByCode(), null)).toBe(false);
      expect(isProviderFallbackEligibleError(noOutputKillByCode(), null, [])).toBe(false);
    });
  });
});
