import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded Postgres (initdb + migrations) cold-start runs inside the test
    // bodies here (see client.test.ts, which spins up a fresh temp database per
    // assertion via startEmbeddedPostgresTestDatabase), so it is governed by
    // testTimeout — not hookTimeout. On a loaded ARC (musl) runner the cold
    // start blows past Vitest's 5s/20s budgets, so give both generous headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
