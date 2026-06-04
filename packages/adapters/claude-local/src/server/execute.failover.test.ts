import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ELI-243: acceptance + regression coverage for the claude-local multi-account
// failover rotation (ELI-241 Option B, spec
// docs/specs/2026-05-24-claude-multi-account-failover.md).
//
// runChildProcess is the single seam that distinguishes accounts: each rotation
// hop spawns the Claude CLI once, so a queue of canned process results lets us
// model "aflabox not logged in → codex healthy" etc. The CLAUDE_CONFIG_DIR the
// adapter pointed each hop at is captured so we can assert the rotation order.

type ProcResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number;
  startedAt: string;
};

const SUCCESS_STDOUT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
  JSON.stringify({
    type: "assistant",
    session_id: "claude-session-1",
    message: { content: [{ type: "text", text: "hello" }] },
  }),
  JSON.stringify({
    type: "result",
    session_id: "claude-session-1",
    result: "hello",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  }),
].join("\n");

function successProc(): ProcResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: SUCCESS_STDOUT,
    stderr: "",
    pid: 123,
    startedAt: "2026-05-24T17:42:00.000Z",
  };
}

function notLoggedInProc(): ProcResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "Not logged in. Please run `claude login`.",
    pid: 124,
    startedAt: "2026-05-24T17:42:00.000Z",
  };
}

function genericFailureProc(): ProcResult {
  return {
    exitCode: 2,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "boom: unexpected internal error",
    pid: 125,
    startedAt: "2026-05-24T17:42:00.000Z",
  };
}

// Queue of process results consumed in order, one per CLI invocation. Also
// records the CLAUDE_CONFIG_DIR each invocation was given.
const procQueue: ProcResult[] = [];
const configDirCalls: Array<string | undefined> = [];

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("claude-local multi-account failover (ELI-243)", () => {
  const cleanupDirs: string[] = [];
  let rootDir: string;
  let workspaceDir: string;
  let accountDirs: Record<string, string>;

  beforeEach(async () => {
    procQueue.length = 0;
    configDirCalls.length = 0;
    runChildProcess.mockImplementation(async (...callArgs: unknown[]) => {
      // runChildProcess is the low-level seam; the options object (carrying env)
      // is whichever argument exposes an `env` map. Locate it positionally so the
      // capture is robust to the exact arity of the wrapper that calls it.
      const opts = callArgs.find(
        (arg): arg is { env?: Record<string, string> } =>
          typeof arg === "object" && arg !== null && "env" in arg,
      );
      configDirCalls.push(opts?.env?.CLAUDE_CONFIG_DIR);
      const next = procQueue.shift();
      if (!next) throw new Error("procQueue exhausted: more CLI invocations than canned results");
      return next;
    });

    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-failover-"));
    cleanupDirs.push(rootDir);
    workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    accountDirs = {
      aflabox: path.join(rootDir, "accounts", "aflabox"),
      codex: path.join(rootDir, "accounts", "codex"),
      personal: path.join(rootDir, "accounts", "personal"),
    };
    for (const dir of Object.values(accountDirs)) {
      await mkdir(dir, { recursive: true });
    }
  });

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function runExecute(accounts: Array<{ label: string; configDir: string }>) {
    return execute({
      runId: "run-failover",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        claudeAccounts: accounts,
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });
  }

  it("acceptance #1: succeeds on the primary account and records one success row", async () => {
    procQueue.push(successProc());

    const result = await runExecute([
      { label: "aflabox", configDir: accountDirs.aflabox },
      { label: "codex", configDir: accountDirs.codex },
      { label: "personal", configDir: accountDirs.personal },
    ]);

    expect(result.errorCode ?? null).toBeNull();
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(configDirCalls).toEqual([accountDirs.aflabox]);
    const attempts = (result.resultJson as { claudeAccountAttempts?: unknown[] })?.claudeAccountAttempts ?? [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attemptIndex: 0,
      label: "aflabox",
      outcome: "success",
      advancedTo: null,
    });
  });

  it("acceptance #2: rotates past an unauthenticated primary onto a healthy account", async () => {
    procQueue.push(notLoggedInProc());
    procQueue.push(successProc());

    const result = await runExecute([
      { label: "aflabox", configDir: accountDirs.aflabox },
      { label: "codex", configDir: accountDirs.codex },
      { label: "personal", configDir: accountDirs.personal },
    ]);

    expect(result.errorCode ?? null).toBeNull();
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(configDirCalls).toEqual([accountDirs.aflabox, accountDirs.codex]);
    const attempts = (result.resultJson as { claudeAccountAttempts: any[] }).claudeAccountAttempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ label: "aflabox", outcome: "auth_required", advancedTo: "codex" });
    expect(attempts[1]).toMatchObject({ label: "codex", outcome: "success", advancedTo: null });
  });

  it("acceptance #3: exhausts all accounts and returns terminal claude_auth_required", async () => {
    procQueue.push(notLoggedInProc());
    procQueue.push(notLoggedInProc());
    procQueue.push(notLoggedInProc());

    const result = await runExecute([
      { label: "aflabox", configDir: accountDirs.aflabox },
      { label: "codex", configDir: accountDirs.codex },
      { label: "personal", configDir: accountDirs.personal },
    ]);

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorFamily ?? null).toBeNull();
    expect(runChildProcess).toHaveBeenCalledTimes(3);
    expect(result.errorMessage).toContain("aflabox");
    expect(result.errorMessage).toContain("codex");
    expect(result.errorMessage).toContain("personal");
    const attempts = (result.resultJson as { claudeAccountAttempts: any[] }).claudeAccountAttempts;
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.outcome)).toEqual(["auth_required", "auth_required", "auth_required"]);
    expect(attempts.map((a) => a.advancedTo)).toEqual(["codex", "personal", null]);
  });

  it("regression: a non-auth failure on the first account does NOT rotate", async () => {
    procQueue.push(genericFailureProc());

    const result = await runExecute([
      { label: "aflabox", configDir: accountDirs.aflabox },
      { label: "codex", configDir: accountDirs.codex },
    ]);

    expect(result.errorCode).not.toBe("claude_auth_required");
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(configDirCalls).toEqual([accountDirs.aflabox]);
  });

  it("regression: a missing config dir advances WITHOUT invoking the CLI", async () => {
    const missing = path.join(rootDir, "accounts", "does-not-exist");
    procQueue.push(successProc());

    const result = await runExecute([
      { label: "aflabox", configDir: missing },
      { label: "codex", configDir: accountDirs.codex },
    ]);

    expect(result.errorCode ?? null).toBeNull();
    // Only the second (existing) account invoked the CLI.
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(configDirCalls).toEqual([accountDirs.codex]);
    const attempts = (result.resultJson as { claudeAccountAttempts: any[] }).claudeAccountAttempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ label: "aflabox", outcome: "config_dir_missing", advancedTo: "codex" });
    expect(attempts[1]).toMatchObject({ label: "codex", outcome: "success" });
  });

  it("regression: with no claudeAccounts the single-account path runs once and adds no audit array", async () => {
    procQueue.push(successProc());

    const result = await execute({
      runId: "run-single",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude" },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    expect(result.errorCode ?? null).toBeNull();
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect((result.resultJson as Record<string, unknown>)?.claudeAccountAttempts).toBeUndefined();
  });
});
