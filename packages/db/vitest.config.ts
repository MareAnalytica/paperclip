import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Embedded Postgres (initdb + migrations) cold-start runs in beforeAll
    // hooks and exceeds Vitest's 5s test / 10s hook defaults on a cold ARC
    // runner. Give cold-start headroom so the leading suite does not flake.
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
