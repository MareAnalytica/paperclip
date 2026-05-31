# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────────
# Custom ARC runner image: Playwright browsers + OS deps pre-baked.
#
# Why (DEE-641, durable follow-up to DEE-640 / PR #58):
#   The stock ghcr.io/actions/actions-runner image ships NONE of chromium's
#   shared libs, so the e2e job runs `npx playwright install --with-deps
#   chromium` on every run. That is an apt + CDN-egress operation that hangs on
#   nodes with flaky DNS/CDN egress (DEE-584 variance) while holding an ARC
#   runner slot doing nothing. Baking the browsers AND their OS deps into the
#   runner image makes the e2e install steps egress-independent no-ops.
#
# Pinning contract:
#   PLAYWRIGHT_VERSION MUST equal the version CI resolves for @playwright/test
#   (currently 1.58.2). The chromium build revision is deterministic per
#   Playwright version, so a matching pin guarantees the baked browser is
#   exactly the one the tests launch. .github/workflows/arc-runner-image.yml
#   enforces this against pnpm-lock.yaml and fails the build on drift.
# ──────────────────────────────────────────────────────────────────────────
ARG RUNNER_VERSION=latest
FROM ghcr.io/actions/actions-runner:${RUNNER_VERSION}

# Pinned at build time via --build-arg by the build workflow. Keep this literal
# in sync with the lockfile's @playwright/test (CI-enforced).
ARG PLAYWRIGHT_VERSION=1.58.2

# Install browsers to a fixed system path so the runtime Playwright resolves
# them here without a re-download.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates gnupg; \
    # Node is needed only at build time to drive the Playwright CLI; the e2e job
    # provides its own Node via actions/setup-node at runtime.
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    # Download chromium AND apt-install its OS deps, pinned to PLAYWRIGHT_VERSION.
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
    # Record the baked version for runtime assertion / debugging.
    echo "${PLAYWRIGHT_VERSION}" > "${PLAYWRIGHT_BROWSERS_PATH}/.playwright-version"; \
    # Own the cache by the runner user (uid 1001). A residual `playwright install`
    # during the rollout window (before pr.yml/e2e.yml/release-smoke.yml drop the
    # step) does NOT just read the baked browser — Playwright writes a `.links`
    # registry entry under PLAYWRIGHT_BROWSERS_PATH, which would EACCES on a
    # root-owned, read-only tree. chown makes that a no-op instead of a failure.
    chown -R runner:runner "${PLAYWRIGHT_BROWSERS_PATH}"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Drop back to the unprivileged runner user the base image expects.
USER runner
