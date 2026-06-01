import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded Postgres (initdb + migrations) cold-start and teardown run in
    // beforeAll/afterAll hooks across the cli embedded-pg suites (routines,
    // worktree, company-import-export). On a loaded ARC (musl) runner these
    // blow past Vitest's 5s test / 10s hook defaults, producing the
    // "Hook timed out in 10000ms" teardown signature (DEE-664). Give both
    // generous headroom, matching packages/db.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
