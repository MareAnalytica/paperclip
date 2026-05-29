import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded Postgres (initdb + migrations) starts in per-file beforeAll
    // hooks; a cold ARC runner blows past Vitest's 5s test / 10s hook
    // defaults and fails the leading suite. Give cold-start headroom.
    testTimeout: 20_000,
    hookTimeout: 60_000,
    isolate: true,
    maxConcurrency: 1,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks: 1,
        minForks: 1,
      },
    },
    sequence: {
      concurrent: false,
      hooks: "list",
    },
    setupFiles: ["./src/__tests__/setup-supertest.ts"],
  },
});
