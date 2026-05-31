# Custom ARC runner image (Playwright pre-baked) — DEE-641

Durable follow-up to DEE-640 (PR #58). DEE-640 cached the Playwright browser
binary and fail-fast bounded the install steps; the apt `playwright
install-deps chromium` step still ran every e2e run and stayed egress-dependent
because the stock `ghcr.io/actions/actions-runner:latest` image ships none of
chromium's shared libs. This image bakes the browsers **and** their OS deps in,
so the e2e install steps become egress-independent no-ops.

## What ships here
- `Dockerfile` — `ghcr.io/actions/actions-runner:latest` + `npx
  playwright@<pinned> install --with-deps chromium`, browsers at
  `/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`), pin must equal
  `@playwright/test` (currently `1.58.2`).
- `.github/workflows/arc-runner-image.yml` — builds on ARC+DinD, pushes
  `registry.mareanalytica.com/arc-runner-playwright:{<version>,latest}`, and
  fails CI on Playwright version drift.

## Rollout (gated; dev-only; keep a rollback)
The live `arc-runner-set` swap is intentionally NOT part of the build PR: every
CI job is `runs-on: arc-runner-set`, so pointing the set at the new image before
it exists in the registry would break all CI. Order:

1. Merge the build PR; run **ARC Runner Image** (push-to-main or
   `workflow_dispatch`) and confirm the tag exists:
   `curl -s https://registry.mareanalytica.com/v2/arc-runner-playwright/tags/list`
2. Point the AutoscalingRunnerSet at the custom image (Helm-managed,
   chart `gha-runner-scale-set 0.13.1`, release `arc-runner-set` / ns
   `arc-runners`). Update the release values' `template.spec.containers[]` and
   `initContainers[0]` (`init-dind-externals`) image to
   `registry.mareanalytica.com/arc-runner-playwright:1.58.2`, then
   `helm upgrade arc-runner-set <chart> -n arc-runners -f values.yaml`.
   The set rolls ephemeral runners to the new image on the next job.
3. **Bounce the listener and re-verify acquisition** (do this after *every*
   AutoscalingRunnerSet image/spec change). The Helm `template.spec` change
   in step 2 rolls the set and starts a fresh runner-scale-set *listener*
   session. That fresh session can acquire in-flight matrix jobs yet
   silently fail to re-acquire already-`queued` **gate** jobs (e.g.
   `policy`), logging `totalAvailableJobs:0` while those jobs sit queued —
   a stale acquisition session, not a capacity or runner-label problem
   (DEE-642). Force a clean session by deleting the listener pod (the
   controller recreates it automatically):
   ```
   kubectl delete pod -n arc-systems \
     -l app.kubernetes.io/component=runner-scale-set-listener
   ```
   Within ~2 min confirm acquisition recovered: the new listener logs a
   non-zero `totalAvailableJobs`/assigned count and the previously-queued
   jobs move out of `queued`. If they stay queued, re-bounce and check
   `maxRunners` capacity (always via `helm upgrade ... -f
   arc-runner-set.values.yaml`, never a `kubectl patch`; DEE-643) and the
   listener log. Then confirm the **old** EphemeralRunnerSet is
   garbage-collected once its last runner finishes:
   `kubectl get ephemeralrunnerset -n arc-runners` should show only the
   current set; delete a lingering orphan by name if it persists.
4. Verify a runner pod launches chromium with **no** egress (see below).
5. Only then simplify `.github/workflows/pr.yml`: drop the **Install Playwright
   OS dependencies (apt)** step and the browser-download/cache steps (the image
   is warm). This step also depends on DEE-640 / PR #58 being merged.

### Rollback
Revert the values image back to `ghcr.io/actions/actions-runner:latest` and
`helm upgrade` again; ephemeral runners recycle to stock within one job
cycle. A rollback is itself an image swap, so bounce the listener and
re-verify acquisition per step 3.

## Verification (acceptance)
The whole point is that chromium's shared libs are present in the image, so the
baked binary runs with no apt/CDN egress. Offline proof:
```
docker run --rm --network none \
  registry.mareanalytica.com/arc-runner-playwright:1.58.2 \
  bash -lc 'CHROME=$(find /ms-playwright -name chrome -path "*chrome-linux64*" | head -1); \
            "$CHROME" --headless=new --no-sandbox --disable-gpu --version'
```
A version string (no `error while loading shared libraries`) confirms every OS
dep is baked — verified on this image build: `Google Chrome for Testing
145.0.7632.6` (chromium-1208, Playwright 1.58.2), launched under `--network
none` as the unprivileged `runner` user (uid 1001). In the e2e job this is
exercised implicitly: with the warm image the install steps no-op and
`playwright test` launches chromium with zero download/apt traffic.
