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
#
# No-system-node invariant (DEE-647, root cause of the DEE-646 rollback):
#   This image MUST NOT ship a system /usr/bin/node. The earlier revision
#   installed NodeSource node 22 to drive the Playwright CLI at build time and
#   never removed it. That lingering system node shadowed actions/setup-node's
#   toolchain for spawn/worktree-heavy jobs (workspaces-a/b) that resolve `node`
#   by absolute path or via a PATH that misses the setup-node shim (the DEE-639
#   PATH family), regressing those jobs and forcing the rollback to stock. The
#   stock image passes workspaces precisely because it has NO system node. So
#   node is installed ONLY to run the Playwright CLI here and is purged in the
#   same layer below; the baked browsers under PLAYWRIGHT_BROWSERS_PATH need no
#   node to be resolved, and the e2e job brings its own node via setup-node.
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
    # Node is needed ONLY at build time to drive the Playwright CLI; it is purged
    # below so the final image ships no system /usr/bin/node (see the
    # No-system-node invariant above). The e2e job provides its own Node via
    # actions/setup-node at runtime.
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
    # Purge the build-time Node + the NodeSource apt source so the final image
    # carries NO system node — matching the stock runner that workspaces-a/b
    # passes on (DEE-647). The OS deps installed by `install --with-deps` are not
    # node packages and are retained for chromium.
    apt-get purge -y --auto-remove nodejs; \
    rm -f /etc/apt/sources.list.d/nodesource.list /usr/share/keyrings/nodesource.gpg; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    # Fail the build loudly if any system node survived the purge — this is the
    # invariant whose violation caused the DEE-646 rollback.
    if command -v node >/dev/null 2>&1; then \
      echo "FATAL: system node still present at $(command -v node) ($(node --version)); the No-system-node invariant is violated" >&2; \
      exit 1; \
    fi

# Drop back to the unprivileged runner user the base image expects.
USER runner
