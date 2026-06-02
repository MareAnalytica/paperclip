import { describe, expect, it } from "vitest";

import { isProviderFallbackEligibleError } from "../services/heartbeat.js";
import {
  builtinDefaultProviderFallbackPolicy,
  PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS,
  type ProviderFallbackAdapterType,
} from "../services/provider-fallback-policy.js";

// ELI-902 / G2 — engine-level safety-net classifier + per-adapter chain-coverage
// guarantee. The safety net is layered *under* each adapter's native limit
// detection: it is consulted only when the active adapter produced no native
// usage-limit classification, and it tests the failure message/status against the
// configured `limitMarkers`.
//
// NOTE (ELI-901): `isProviderFallbackEligibleError(run, authMode, limitMarkers)`
// carries the auth model as its second arg (G1). These G2 cases pass `null`
// (the oauth-session default) so the safety-net assertions are unaffected by the
// auth gate; the raw-key/auth precedence is pinned in provider-fallback-runtime.

const DEFAULT_MARKERS = [...PROVIDER_FALLBACK_DEFAULT_LIMIT_MARKERS];

// A representative real usage-limit failure string for each adapter that can sit
// in a shipped defaultChain. Each must contain at least one default `limitMarker`
// so the safety net guarantees the adapter hops even with NO native detection
// (e.g. grok_local, which carries no native limit-detection in its parse.ts).
const REPRESENTATIVE_LIMIT_FAILURE: Record<ProviderFallbackAdapterType, string> = {
  claude_local: "Claude usage limit reached. Your limit will reset at 3pm (UTC).",
  codex_local:
    "You've hit your usage limit for gpt-5. Switch to another model now, or try again at 4:30pm.",
  grok_local: "Rate limit exceeded: 429 Too Many Requests",
};

// Mirror the run shape a non-detecting adapter persists on a generic failure: a
// generic errorCode and the provider text in resultJson.error, with NO
// transient_upstream family. This isolates the safety net from native detection.
function bareAdapterFailureRun(message: string) {
  return {
    errorCode: "adapter_error",
    error: message,
    resultJson: { error: message } as Record<string, unknown>,
  };
}

describe("provider-fallback limitMarkers safety-net + chain-coverage (ELI-902 / G2)", () => {
  describe("chain-coverage guarantee", () => {
    const chain = builtinDefaultProviderFallbackPolicy().default.chain;
    const chainAdapterTypes = [...new Set(chain.map((entry) => entry.adapter))];

    it("every default-chain adapter has a representative limit-failure fixture", () => {
      // Guard: a chain edit that adds a new adapter type with no representative
      // fixture fails here, forcing the author to prove the new adapter hops.
      for (const adapter of chainAdapterTypes) {
        expect(REPRESENTATIVE_LIMIT_FAILURE[adapter], `missing fixture for ${adapter}`).toBeTruthy();
      }
    });

    it.each(chainAdapterTypes)(
      "engine classifies a representative limit failure from %s as fallback-eligible (safety net guarantees the hop)",
      (adapter) => {
        const run = bareAdapterFailureRun(REPRESENTATIVE_LIMIT_FAILURE[adapter]);
        // Without the safety net (no markers) a non-detecting adapter would fail
        // the run instead of hopping — that is the G2 gap.
        expect(isProviderFallbackEligibleError(run, null, [])).toBe(false);
        // With the configured markers the engine hops for every chain adapter.
        expect(isProviderFallbackEligibleError(run, null, DEFAULT_MARKERS)).toBe(true);
      },
    );
  });

  describe("native detection wins; safety net is strictly additive", () => {
    it("a transient_upstream run is eligible even with NO markers configured (native path unchanged)", () => {
      const run = {
        errorCode: "claude_transient_upstream",
        error: null,
        resultJson: { errorFamily: "transient_upstream" } as Record<string, unknown>,
      };
      expect(isProviderFallbackEligibleError(run, null, [])).toBe(true);
    });

    it("auth/session/claude_usage_limit errorCodes stay eligible (native path unchanged)", () => {
      for (const errorCode of ["claude_auth_required", "codex_session_expired", "claude_usage_limit"]) {
        expect(
          isProviderFallbackEligibleError({ errorCode, error: null, resultJson: null }, null, []),
        ).toBe(true);
      }
    });

    it("the safety net only catches what the adapter missed — a non-limit failure does not hop", () => {
      const run = bareAdapterFailureRun("TypeError: cannot read properties of undefined");
      expect(isProviderFallbackEligibleError(run, null, DEFAULT_MARKERS)).toBe(false);
    });

    it("the safety net is off when no markers are configured", () => {
      const run = bareAdapterFailureRun("usage limit reached");
      expect(isProviderFallbackEligibleError(run, null, [])).toBe(false);
      expect(isProviderFallbackEligibleError(run, null, DEFAULT_MARKERS)).toBe(true);
    });

    it("matches the limit marker in the errorCode/status as well as the message", () => {
      const run = {
        errorCode: "http_429",
        error: null,
        resultJson: null,
      };
      expect(isProviderFallbackEligibleError(run, null, DEFAULT_MARKERS)).toBe(true);
    });
  });
});
