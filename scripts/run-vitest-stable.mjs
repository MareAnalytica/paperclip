#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const serverRoot = path.join(repoRoot, "server");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-acpx-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/plugin-sdk",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);
let invocationIndex = 0;
let flakyRetryToGreenCount = 0;
const serializedModeName = "serialized";
const generalModeName = "general";
const allModeName = "all";
const generalServerGroupName = "general-server";
const generalWorkspacesAGroupName = "general-workspaces-a";
const generalWorkspacesBGroupName = "general-workspaces-b";
const generalWorkspacesAProjects = ["@paperclipai/ui", "paperclipai"];
const generalWorkspacesBProjects = nonServerProjects.filter((project) => !generalWorkspacesAProjects.includes(project));
const generalGroupNames = [generalServerGroupName, generalWorkspacesAGroupName, generalWorkspacesBGroupName];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function fail(message) {
  console.error(`[test:run] ${message}`);
  process.exit(1);
}

function readOptionValue(argv, index, argName) {
  const value = argv[index + 1];
  if (value === undefined) {
    fail(`Missing value for ${argName}`);
  }

  return value;
}

function parseNonNegativeInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${argName} must be a non-negative integer. Received "${value}".`);
  }

  return parsed;
}

function parsePositiveInteger(value, argName) {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isInteger(parsed) || parsed < 1) {
    fail(`${argName} must be a positive integer. Received "${value}".`);
  }

  return parsed;
}

function parseCliOptions(argv) {
  let mode = allModeName;
  let shardIndex = null;
  let shardCount = null;
  let group = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--mode") {
      mode = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
      continue;
    }

    if (arg === "--shard-index") {
      shardIndex = parseNonNegativeInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-index=")) {
      shardIndex = parseNonNegativeInteger(arg.slice("--shard-index=".length), "--shard-index");
      continue;
    }

    if (arg === "--shard-count") {
      shardCount = parsePositiveInteger(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--shard-count=")) {
      shardCount = parsePositiveInteger(arg.slice("--shard-count=".length), "--shard-count");
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--group") {
      group = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--group=")) {
      group = arg.slice("--group=".length);
      continue;
    }

    fail(`Unknown argument "${arg}".`);
  }

  if (!new Set([allModeName, generalModeName, serializedModeName]).has(mode)) {
    fail(`Unknown mode "${mode}". Expected one of: ${allModeName}, ${generalModeName}, ${serializedModeName}.`);
  }

  if ((shardIndex === null) !== (shardCount === null)) {
    fail("--shard-index and --shard-count must be provided together.");
  }

  if (group !== null && mode !== generalModeName) {
    fail("--group is only valid with --mode general.");
  }

  if (group !== null && !generalGroupNames.includes(group)) {
    fail(`Unknown group "${group}". Expected one of: ${generalGroupNames.join(", ")}.`);
  }

  const shardableInGeneralMode = mode === generalModeName && group === generalServerGroupName;
  if (mode !== serializedModeName && !shardableInGeneralMode && shardIndex !== null) {
    fail("--shard-index/--shard-count are only valid with --mode serialized or --mode general --group general-server.");
  }

  if (mode === serializedModeName || shardableInGeneralMode) {
    const resolvedShardCount = shardCount ?? 1;
    const resolvedShardIndex = shardIndex ?? 0;
    if (resolvedShardIndex >= resolvedShardCount) {
      fail(`--shard-index must be less than --shard-count. Received ${resolvedShardIndex} of ${resolvedShardCount}.`);
    }

    if (mode === serializedModeName) {
      return {
        mode,
        shardIndex: resolvedShardIndex,
        shardCount: resolvedShardCount,
        group: null,
        dryRun,
      };
    }

    return {
      mode,
      shardIndex: resolvedShardIndex,
      shardCount: resolvedShardCount,
      group,
      dryRun,
    };
  }

  return {
    mode,
    shardIndex: null,
    shardCount: null,
    group,
    dryRun,
  };
}

function selectSerializedSuites(routeTests, shardIndex, shardCount) {
  return routeTests.filter((_, index) => index % shardCount === shardIndex);
}

// Retry-to-green harness for known-flaky CI shards (DEE-649). Retry is OFF by
// default (1 attempt) so local `pnpm test` behaviour is unchanged; CI lanes opt
// in via PAPERCLIP_TEST_RETRY_ATTEMPTS. Because retries are bounded and applied
// per Vitest invocation, a deterministic regression still fails every attempt
// and stays red — only genuinely flaky suites are rescued.
const flakyRetryAttempts = (() => {
  const raw = process.env.PAPERCLIP_TEST_RETRY_ATTEMPTS;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(
      `PAPERCLIP_TEST_RETRY_ATTEMPTS must be a positive integer. Received "${raw}".`,
    );
  }
  return parsed;
})();

function runVitestOnce(args, label, attempt, maxAttempts) {
  const attemptSuffix = maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";
  console.log(`\n[test:run] ${label}${attemptSuffix}`);
  invocationIndex += 1;
  const tempRootParent = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const testRoot = mkdtempSync(path.join(tempRootParent, `pcvt-${process.pid}-${invocationIndex}-`));
  // Keep per-run paths compact so Unix socket fixtures stay under macOS path limits.
  const env = {
    ...process.env,
    PAPERCLIP_HOME: path.join(testRoot, "h"),
    PAPERCLIP_INSTANCE_ID: `vt-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "t"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

function runVitest(args, label) {
  let lastStatus = 1;
  for (let attempt = 1; attempt <= flakyRetryAttempts; attempt += 1) {
    lastStatus = runVitestOnce(args, label, attempt, flakyRetryAttempts);
    if (lastStatus === 0) {
      if (attempt > 1) {
        flakyRetryToGreenCount += 1;
        console.warn(
          `[test:run][flaky-retry] "${label}" passed on attempt ${attempt}/${flakyRetryAttempts} after ${attempt - 1} failed attempt(s). Flaky — track for root-fix (DEE-649).`,
        );
      }
      return;
    }
    if (attempt < flakyRetryAttempts) {
      console.warn(
        `[test:run][flaky-retry] "${label}" failed on attempt ${attempt}/${flakyRetryAttempts} (exit ${lastStatus}). Retrying...`,
      );
    }
  }
  console.error(
    `[test:run] "${label}" failed on all ${flakyRetryAttempts} attempt(s) (exit ${lastStatus}). Treating as a real failure.`,
  );
  process.exit(lastStatus);
}

function runGeneralSuites(routeTests) {
  for (const groupName of generalGroupNames) {
    runGeneralGroup(routeTests, groupName, null, null);
  }
}

function runProjectGroup(projects, groupName) {
  for (const project of projects) {
    runVitest(["--project", project], `${groupName} project ${project}`);
  }
}

function runGeneralGroup(routeTests, groupName, shardIndex, shardCount) {
  if (groupName === generalServerGroupName) {
    const excludeRouteArgs = routeTests.flatMap((file) => ["--exclude", file.serverPath]);
    const shardArgs =
      shardIndex !== null ? [`--shard=${shardIndex + 1}/${shardCount}`] : [];
    const label =
      shardIndex !== null
        ? `${groupName} shard ${shardIndex + 1}/${shardCount} excluding ${routeTests.length} serialized suites`
        : `${groupName} server suites excluding ${routeTests.length} serialized suites`;
    runVitest(
      ["--project", "@paperclipai/server", ...excludeRouteArgs, ...shardArgs],
      label,
    );
    return;
  }

  if (groupName === generalWorkspacesAGroupName) {
    runProjectGroup(generalWorkspacesAProjects, groupName);
    return;
  }

  if (groupName === generalWorkspacesBGroupName) {
    runProjectGroup(generalWorkspacesBProjects, groupName);
    return;
  }

  fail(`Unknown group "${groupName}".`);
}

function runSerializedSuites(routeTests, shardIndex, shardCount) {
  const shardTests = selectSerializedSuites(routeTests, shardIndex, shardCount);
  console.log(
    `\n[test:run] serialized shard ${shardIndex + 1}/${shardCount} running ${shardTests.length} of ${routeTests.length} suites`,
  );

  for (const routeTest of shardTests) {
    runVitest(
      [
        "--project",
        "@paperclipai/server",
        routeTest.repoPath,
        "--pool=forks",
        "--poolOptions.forks.isolate=true",
      ],
      routeTest.repoPath,
    );
  }
}

const routeTests = walk(serverTestsDir)
  .filter((file) => isRouteOrAuthzTest(toRepoPath(file)))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

const options = parseCliOptions(process.argv.slice(2));
if (options.dryRun) {
  const serializedSuites =
    options.mode === serializedModeName
      ? selectSerializedSuites(routeTests, options.shardIndex, options.shardCount)
      : routeTests;
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        shardIndex: options.shardIndex,
        shardCount: options.shardCount,
        group: options.group,
        availableGeneralGroups: generalGroupNames,
        serializedSuiteCount: routeTests.length,
        selectedSerializedSuites: serializedSuites.map((routeTest) => routeTest.repoPath),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (options.mode === generalModeName || options.mode === allModeName) {
  if (options.group) {
    runGeneralGroup(routeTests, options.group, options.shardIndex, options.shardCount);
  } else {
    runGeneralSuites(routeTests);
  }
}

if (options.mode === serializedModeName || options.mode === allModeName) {
  runSerializedSuites(routeTests, options.shardIndex ?? 0, options.shardCount ?? 1);
}


if (flakyRetryToGreenCount > 0) {
  console.warn(
    `\n[test:run][flaky-retry] ${flakyRetryToGreenCount} suite(s) passed only after retry this run. These are flaky and should be root-fixed (DEE-649).`,
  );
}
