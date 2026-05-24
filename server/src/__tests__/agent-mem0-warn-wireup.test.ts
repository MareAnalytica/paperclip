/**
 * DEE-448 / ELI-168 wire-up smoke test.
 *
 * Verifies that `recordAgentMem0UserIdGap` is actually called inside each of
 * the three agent-write entry points (`router.post("/companies/:companyId/agent-hires", ...)`,
 * `router.post("/companies/:companyId/agents", ...)`, `router.patch("/agents/:id", ...)`)
 * in `server/src/routes/agents.ts`. A pure helper unit test cannot catch a
 * missing wire-up at any of those sites — Code Reviewer caught exactly that
 * gap in the first review pass (PR #9), so we encode the invariant here as a
 * lightweight static check that runs in any test environment, including
 * sandboxes that cannot load the cursor-cloud native sqlite3 binding.
 *
 * If a future refactor splits or renames any of these handlers, update both
 * the route and the expected callsite-count below; the test is intentionally
 * brittle to wire-up changes.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENTS_ROUTE_PATH = path.resolve(__dirname, "../routes/agents.ts");

async function readRoutesFile(): Promise<string> {
  return fs.readFile(AGENTS_ROUTE_PATH, "utf8");
}

function extractHandlerBody(source: string, anchorRegex: RegExp): string {
  const match = anchorRegex.exec(source);
  if (!match) {
    throw new Error(
      `Could not find route anchor /${anchorRegex.source}/ — did the handler get renamed?`,
    );
  }
  const start = match.index;
  let depth = 0;
  let i = start;
  // Walk forward to find the first `{`, then balance braces until we exit.
  while (i < source.length && source[i] !== "{") i += 1;
  if (i >= source.length) throw new Error("Could not locate handler body opening brace");
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced braces in handler body");
}

describe("DEE-448 wire-up: recordAgentMem0UserIdGap is invoked in every agent-write entry point", () => {
  it("imports the helper at the top of routes/agents.ts", async () => {
    const source = await readRoutesFile();
    expect(source).toMatch(
      /import\s*\{\s*recordAgentMem0UserIdGap\s*\}\s*from\s*"\.\.\/services\/agent-mem0-warn\.js";/,
    );
  });

  it("calls the helper inside POST /companies/:companyId/agent-hires (hire route)", async () => {
    const source = await readRoutesFile();
    const body = extractHandlerBody(
      source,
      /router\.post\(\s*"\/companies\/:companyId\/agent-hires"/,
    );
    expect(body).toContain("recordAgentMem0UserIdGap(");
    expect(body).toContain('verb: "create"');
  });

  it("calls the helper inside POST /companies/:companyId/agents (direct create)", async () => {
    const source = await readRoutesFile();
    const body = extractHandlerBody(
      source,
      /router\.post\(\s*"\/companies\/:companyId\/agents"/,
    );
    expect(body).toContain("recordAgentMem0UserIdGap(");
    expect(body).toContain('verb: "create"');
  });

  it("calls the helper inside PATCH /agents/:id", async () => {
    const source = await readRoutesFile();
    const body = extractHandlerBody(
      source,
      /router\.patch\(\s*"\/agents\/:id"\s*,\s*validate\(updateAgentSchema\)/,
    );
    expect(body).toContain("recordAgentMem0UserIdGap(");
    expect(body).toContain('verb: "update"');
  });

  it("does not call the helper outside the three known entry points", async () => {
    const source = await readRoutesFile();
    const occurrences = source.match(/recordAgentMem0UserIdGap\(/g) ?? [];
    // 1 import + 3 call sites = 4 total occurrences of the bare identifier as a function call would be 3.
    expect(occurrences).toHaveLength(3);
  });
});
