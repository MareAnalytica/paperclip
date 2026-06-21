import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { withBudget, isPolicyCostError, POLICY_ERROR } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  applyPaperclipWorkspaceEnv,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  rewriteWorkspaceCwdEnvVarsForExecution,
  shapePaperclipWorkspaceEnvForExecution,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeAuthClassFailure,
  isClaudeMaxTurnsResult,
  isClaudeProviderDisabledError,
  isClaudeTransientUpstreamError,
  isClaudeUnknownSessionError,
} from "./parse.js";
import {
  prepareClaudeConfigSeed,
  resolveClaudeAccounts,
  type ClaudeAccount,
} from "./claude-config.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";
import { isBedrockModelId } from "./models.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { buildClaudeExecutionPermissionArgs } from "./permissions.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ELI-243: one row of the multi-account failover audit trail, appended to
// `resultJson.claudeAccountAttempts`. Shape per spec
// docs/specs/2026-05-24-claude-multi-account-failover.md §3.3.
interface ClaudeAccountAttempt {
  attemptIndex: number;
  label: string;
  configDir: string;
  startedAt: string;
  completedAt: string;
  outcome: "success" | "auth_required" | "config_dir_missing" | "skipped";
  errorMessage?: string;
  advancedTo: string | null;
}

async function claudeConfigDirExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtimeCommandSpec?: AdapterExecutionContext["runtimeCommandSpec"];
  executionTarget?: ReturnType<typeof readAdapterExecutionTarget>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

interface ClaudeRuntimeConfig {
  command: string;
  resolvedCommand: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  loggedEnv: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

export function claudeSessionCwdMatchesExecutionTarget(input: {
  runtimeSessionCwd: string;
  effectiveExecutionCwd: string;
  executionTargetIsRemote: boolean;
}): boolean {
  if (input.executionTargetIsRemote || input.runtimeSessionCwd.length === 0) return true;
  return path.resolve(input.runtimeSessionCwd) === path.resolve(input.effectiveExecutionCwd);
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function isBedrockAuth(env: Record<string, string>): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")
  );
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" | "metered_api" {
  if (isBedrockAuth(env)) return "metered_api";
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, runtimeCommandSpec, executionTarget, authToken } = input;
  const onLog = input.onLog ?? (async () => {});

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const shapedWorkspaceEnv = shapePaperclipWorkspaceEnvForExecution({
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceWorktreePath,
    workspaceHints,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (issueWorkMode) {
    env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (wakePayloadJson) {
    env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  }
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: shapedWorkspaceEnv.workspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath: shapedWorkspaceEnv.workspaceWorktreePath,
    agentHome,
  });
  if (shapedWorkspaceEnv.workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(shapedWorkspaceEnv.workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }
  const shapedEnvConfig = rewriteWorkspaceCwdEnvVarsForExecution({
    env: envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    executionCwd: shapedWorkspaceEnv.workspaceCwd,
    executionTargetIsRemote,
  });
  for (const [key, value] of Object.entries(shapedEnvConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
    executionTarget,
    asNumber(config.timeoutSec, 0),
  );
  const graceSec = asNumber(config.graceSec, 20);
  await ensureAdapterExecutionTargetRuntimeCommandInstalled({
    runId,
    target: executionTarget,
    installCommand: runtimeCommandSpec?.installCommand,
    detectCommand: runtimeCommandSpec?.detectCommand,
    cwd,
    env: runtimeEnv,
    timeoutSec,
    graceSec,
    onLog,
  });
  await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
    installCommand: SANDBOX_INSTALL_COMMAND,
    timeoutSec,
  });
  const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
    resolvedCommand,
  });

  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runAdapterExecutionTargetProcess(input.runId, null, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);
  const executionTargetIsSandbox = executionTarget?.kind === "remote" && executionTarget.transport === "sandbox";

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, true);
  const configEnv = parseObject(config.env);
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const hasExplicitClaudeConfigDir =
    typeof configEnv.CLAUDE_CONFIG_DIR === "string" && configEnv.CLAUDE_CONFIG_DIR.trim().length > 0;
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    runtimeCommandSpec: ctx.runtimeCommandSpec,
    executionTarget,
    authToken,
    onLog,
  });
  const {
    command,
    resolvedCommand,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    loggedEnv: initialLoggedEnv,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  let loggedEnv = initialLoggedEnv;
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  const terminalResultCleanupGraceMs = Math.max(
    0,
    asNumber(config.terminalResultCleanupGraceMs, 5_000),
  );
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const claudeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveClaudeDesiredSkillNames(config, claudeSkillEntries));
  // When instructionsFilePath is configured, build a stable content-addressed
  // file that includes both the file content and the path directive, so we only
  // need --append-system-prompt-file (Claude CLI forbids using both flags together).
  let combinedInstructionsContents: string | null = null;
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective =
        `\nThe above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsFileDir}. ` +
        `This base directory is authoritative for sibling instruction files such as ` +
        `./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.`;
      combinedInstructionsContents = instructionsContent + pathDirective;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const promptBundle = await prepareClaudePromptBundle({
    companyId: agent.companyId,
    skills: claudeSkillEntries.filter((entry) => desiredSkillNames.has(entry.key)),
    instructionsContents: combinedInstructionsContents,
    onLog,
  });
  const useManagedRemoteClaudeConfig =
    executionTargetIsRemote &&
    adapterExecutionTargetUsesManagedHome(executionTarget) &&
    !hasExplicitClaudeConfigDir;
  const claudeConfigSeedDir = useManagedRemoteClaudeConfig
    ? await prepareClaudeConfigSeed(process.env, onLog, agent.companyId)
    : null;
  const preparedExecutionTargetRuntime = executionTargetIsRemote
    ? await (async () => {
        await onLog(
          "stdout",
          `[paperclip] Syncing workspace and Claude runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
        );
        return await prepareAdapterExecutionTargetRuntime({
          runId,
          target: executionTarget,
          adapterKey: "claude",
          timeoutSec,
          workspaceLocalDir: cwd,
          installCommand: SANDBOX_INSTALL_COMMAND,
          detectCommand: command,
          assets: [
            {
              key: "skills",
              localDir: promptBundle.addDir,
              followSymlinks: true,
            },
            ...(claudeConfigSeedDir
              ? [{
                key: "config-seed",
                localDir: claudeConfigSeedDir,
                followSymlinks: true,
              }]
              : []),
          ],
        });
      })()
    : null;
  if (preparedExecutionTargetRuntime?.workspaceRemoteDir) {
    effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir;
  }
  const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig: configEnv,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch,
    workspaceWorktreePath,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  const restoreRemoteWorkspace = preparedExecutionTargetRuntime
    ? () => preparedExecutionTargetRuntime.restoreWorkspace()
    : null;
  const effectivePromptBundleAddDir = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.assetDirs.skills ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude", "skills")
    : promptBundle.addDir;
  const effectiveInstructionsFilePath = promptBundle.instructionsFilePath
    ? executionTargetIsRemote
      ? path.posix.join(effectivePromptBundleAddDir, path.basename(promptBundle.instructionsFilePath))
      : promptBundle.instructionsFilePath
    : undefined;
  const remoteClaudeRuntimeRoot = executionTargetIsRemote
    ? preparedExecutionTargetRuntime?.runtimeRootDir ??
      path.posix.join(effectiveExecutionCwd, ".paperclip-runtime", "claude")
    : null;
  const remoteClaudeConfigSeedDir = claudeConfigSeedDir && remoteClaudeRuntimeRoot
    ? preparedExecutionTargetRuntime?.assetDirs["config-seed"] ??
      path.posix.join(remoteClaudeRuntimeRoot, "config-seed")
    : null;
  const remoteClaudeConfigDir = useManagedRemoteClaudeConfig && remoteClaudeRuntimeRoot
    ? path.posix.join(remoteClaudeRuntimeRoot, "config")
    : null;
  if (remoteClaudeConfigDir && remoteClaudeConfigSeedDir) {
    env.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
    loggedEnv.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
    await onLog(
      "stdout",
      `[paperclip] Materializing Claude auth/config into ${remoteClaudeConfigDir}.\n`,
    );
    await runAdapterExecutionTargetShellCommand(
      runId,
      executionTarget,
      `mkdir -p ${shellQuote(remoteClaudeConfigDir)} && ` +
        `if [ -d ${shellQuote(remoteClaudeConfigSeedDir)} ]; then ` +
        `cp -R ${shellQuote(`${remoteClaudeConfigSeedDir}/.`)} ${shellQuote(remoteClaudeConfigDir)}/; ` +
        `fi`,
      {
        cwd,
        env,
        timeoutSec: Math.max(timeoutSec, 15),
        graceSec,
        onLog,
      },
    );
  }
  let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;
  if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
    paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
      runId,
      target: runtimeExecutionTarget,
      runtimeRootDir: preparedExecutionTargetRuntime?.runtimeRootDir,
      adapterKey: "claude",
      timeoutSec,
      hostApiToken: env.PAPERCLIP_API_KEY,
      onLog,
    });
    if (paperclipBridge) {
      Object.assign(env, paperclipBridge.env);
      const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
      loggedEnv = buildInvocationEnvForLogs(env, {
        runtimeEnv,
        includeRuntimeKeys: ["HOME", "CLAUDE_CONFIG_DIR"],
        resolvedCommand,
      });
      if (remoteClaudeConfigDir) {
        loggedEnv.CLAUDE_CONFIG_DIR = remoteClaudeConfigDir;
      }
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const runtimePromptBundleKey = asString(runtimeSessionParams.promptBundleKey, "");
  const hasMatchingPromptBundle =
    runtimePromptBundleKey.length === 0 || runtimePromptBundleKey === promptBundle.bundleKey;
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    hasMatchingPromptBundle &&
    claudeSessionCwdMatchesExecutionTarget({
      runtimeSessionCwd,
      effectiveExecutionCwd,
      executionTargetIsRemote,
    }) &&
    adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (
    executionTargetIsRemote &&
    runtimeSessionId &&
    !canResumeSession
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (
    runtimeSessionId &&
    runtimeSessionCwd.length > 0 &&
    path.resolve(runtimeSessionCwd) !== path.resolve(effectiveExecutionCwd)
  ) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
    );
  } else if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
    );
  }
  if (runtimeSessionId && runtimePromptBundleKey.length > 0 && runtimePromptBundleKey !== promptBundle.bundleKey) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for prompt bundle "${runtimePromptBundleKey}" and will not be resumed with "${promptBundle.bundleKey}".\n`,
    );
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
  const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const taskContextNote = asString(context.paperclipTaskMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    wakePromptChars: wakePrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    taskContextChars: taskContextNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (
    resumeSessionId: string | null,
    attemptInstructionsFilePath: string | undefined,
  ) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    args.push(...buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions,
      targetIsSandbox: executionTargetIsSandbox,
    }));
    if (chrome) args.push("--chrome");
    // For Bedrock: only pass --model when the ID is a Bedrock-native identifier
    // (e.g. "us.anthropic.*" or ARN). Anthropic-style IDs like "claude-opus-4-6" are invalid
    // on Bedrock, so skip them and let the CLI use its own configured model.
    if (model && (!isBedrockAuth(effectiveEnv) || isBedrockModelId(model))) {
      args.push("--model", model);
    }
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    // On resumed sessions the instructions are already in the session cache;
    // re-injecting them via --append-system-prompt-file wastes 5-10K tokens
    // per heartbeat and the Claude CLI may reject the combination outright.
    if (attemptInstructionsFilePath && !resumeSessionId) {
      args.push("--append-system-prompt-file", attemptInstructionsFilePath);
    }
    args.push("--add-dir", effectivePromptBundleAddDir);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const attemptInstructionsFilePath = resumeSessionId ? undefined : effectiveInstructionsFilePath;
    const args = buildClaudeArgs(resumeSessionId, attemptInstructionsFilePath);
    const commandNotes: string[] = [];
    if (!resumeSessionId) {
      commandNotes.push(`Using stable Claude prompt bundle ${promptBundle.bundleKey}.`);
    }
    if (dangerouslySkipPermissions && executionTargetIsSandbox) {
      commandNotes.push(
        "Using a broad --allowedTools whitelist for sandbox execution because Claude rejects --dangerously-skip-permissions under root/sudo.",
      );
    }
    if (attemptInstructionsFilePath && !resumeSessionId) {
      commandNotes.push(
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      );
    }
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command: resolvedCommand,
        cwd: effectiveExecutionCwd,
        commandArgs: args,
        commandNotes,
        env: loggedEnv,
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
      terminalResultCleanup: {
        graceMs: terminalResultCleanupGraceMs,
        hasTerminalResult: ({ stdout }) => parseClaudeStreamJson(stdout).resultJson !== null,
      },
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      const fallbackErrorMessage = parseFallbackErrorMessage(proc);
      // ELI-1075: the org/subscription-disabled block is checked before the
      // transient classifier so it is never swallowed as transient/auth — it is
      // a permanent-per-account failure with its own `provider_disabled` family.
      const providerDisabled =
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeProviderDisabledError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientUpstream =
        !providerDisabled &&
        !loginMeta.requiresLogin &&
        (proc.exitCode ?? 0) !== 0 &&
        isClaudeTransientUpstreamError({
          parsed: null,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage: fallbackErrorMessage,
        });
      const transientRetryNotBefore = transientUpstream
        ? extractClaudeRetryNotBefore({
            parsed: null,
            stdout: proc.stdout,
            stderr: proc.stderr,
            errorMessage: fallbackErrorMessage,
          })
        : null;
      const errorCode = providerDisabled
        ? "claude_provider_disabled"
        : loginMeta.requiresLogin
        ? "claude_auth_required"
        : transientUpstream
        ? "claude_transient_upstream"
        : null;
      const errorFamily = providerDisabled
        ? "provider_disabled"
        : transientUpstream
        ? "transient_upstream"
        : null;
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: fallbackErrorMessage,
        errorCode,
        errorFamily,
        retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
          ...(errorFamily ? { errorFamily } : {}),
          ...(transientRetryNotBefore
            ? { retryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
          ...(transientRetryNotBefore
            ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() }
            : {}),
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        promptBundleKey: promptBundle.bundleKey,
        ...(executionTargetIsRemote
          ? {
              remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
            }
          : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;

    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);
    const parsedIsError = asBoolean(parsed.is_error, false);
    const failed = (proc.exitCode ?? 0) !== 0 || parsedIsError;
    const errorMessage = failed
      ? describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`
      : null;
    // ELI-1075: classify the org/subscription-disabled block before transient —
    // it is permanent-per-account (`provider_disabled`), not a self-healing
    // limit, and must not be swallowed as transient/auth.
    const providerDisabled =
      failed &&
      !clearSessionForMaxTurns &&
      isClaudeProviderDisabledError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientUpstream =
      failed &&
      !providerDisabled &&
      !loginMeta.requiresLogin &&
      !clearSessionForMaxTurns &&
      isClaudeTransientUpstreamError({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        errorMessage,
      });
    const transientRetryNotBefore = transientUpstream
      ? extractClaudeRetryNotBefore({
          parsed,
          stdout: proc.stdout,
          stderr: proc.stderr,
          errorMessage,
        })
      : null;
    const resolvedErrorCode = providerDisabled
      ? "claude_provider_disabled"
      : loginMeta.requiresLogin
      ? "claude_auth_required"
      : failed && clearSessionForMaxTurns
      ? "max_turns_exhausted"
      : transientUpstream
      ? "claude_transient_upstream"
      : null;
    const resolvedErrorFamily = providerDisabled
      ? "provider_disabled"
      : transientUpstream
      ? "transient_upstream"
      : null;
    const mergedResultJson: Record<string, unknown> = {
      ...parsed,
      ...(failed && clearSessionForMaxTurns ? { stopReason: "max_turns_exhausted" } : {}),
      ...(resolvedErrorFamily ? { errorFamily: resolvedErrorFamily } : {}),
      ...(transientRetryNotBefore ? { retryNotBefore: transientRetryNotBefore.toISOString() } : {}),
      ...(transientRetryNotBefore ? { transientRetryNotBefore: transientRetryNotBefore.toISOString() } : {}),
    };

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage,
      errorCode: resolvedErrorCode,
      errorFamily: resolvedErrorFamily,
      retryNotBefore: transientRetryNotBefore ? transientRetryNotBefore.toISOString() : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "anthropic",
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: mergedResultJson,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  // ELI-78: when enabled (config-gated), a preflight `deny` hard-stops the run.
  // Default false preserves the existing non-fatal preflight behavior.
  const enforceBudgetDeny = asBoolean(config.budgetEnforceDeny, false);
  // ELI-943: cached burn/headroom hint arms forcePreflightAbovePercent in prod. On by
  // default (safe — only forces preflight once a cap is near critical); operators can
  // disable via config.budgetBurnHint=false.
  const burnHintEnabled = asBoolean(config.budgetBurnHint, true);
  const budgetOpts = { burnHint: { enabled: burnHintEnabled } };
  try {
    // ELI-78: preflight via SDK helper before the (potentially costly) claude provider call.
    // Rough est from prompt size; non-fatal to preserve existing adapter error/timeout behavior.
    try {
      await withBudget(ctx, async (b) => {
        const estTokens = Math.max(50, Math.ceil((prompt?.length || 2000) / 4));
        await b.preflightIfRequired({
          provider: "anthropic",
          model: "claude",
          estimatedQty: estTokens,
          estimatedCostMicros: Math.ceil(estTokens * 3),
        });
      }, { enforceDeny: enforceBudgetDeny, ...budgetOpts });
    } catch (preflightErr) {
      if (isPolicyCostError(preflightErr, POLICY_ERROR.BUDGET_HARD_STOPPED)) {
        await onLog("stderr", `[paperclip] budget preflight DENY hard-stop: ${preflightErr}\n`);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorMessage: "Budget preflight denied this call (hard stop).",
          errorCode: "budget_denied",
          provider: "anthropic",
          biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
          billingType,
          clearSession: false,
        };
      }
      await onLog("stderr", `[paperclip] budget preflight note: ${preflightErr}\n`);
    }

    // ELI-243: the single-attempt body (initial run + unknown-session retry +
    // cost charging) is factored into executeOnceForAccount() so the multi-account
    // failover loop can invoke it once per configured account against whatever
    // env.CLAUDE_CONFIG_DIR is currently pointed at. It returns the normal
    // AdapterExecutionResult plus the raw parsed/stdout/stderr so the loop can
    // classify auth-class failures via the documented allowlist without re-running
    // the CLI. With no `claudeAccounts` list this runs exactly once, identical to
    // the historical single-account path.
    const executeOnceForAccount = async (): Promise<{
      result: AdapterExecutionResult;
      parsed: Record<string, unknown> | null;
      stdout: string;
      stderr: string;
    }> => {
      const initial = await runAttempt(sessionId ?? null);
      if (
        sessionId &&
        !initial.proc.timedOut &&
        (initial.proc.exitCode ?? 0) !== 0 &&
        initial.parsed &&
        isClaudeUnknownSessionError(initial.parsed)
      ) {
        await onLog(
          "stdout",
          `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        // charge for retry path also via withBudget-wrapped handle (ensures dims + idempotency)
        try {
          await withBudget(ctx, async (b) => {
            const ps = (retry as any).parsedStream || {};
            const u = ps.usage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
            const chCost = typeof ps.costUsd === "number"
              ? Math.ceil(ps.costUsd * 1_000_000)
              : Math.ceil(((u.inputTokens || 0) + (u.outputTokens || 0)) * 3);
            await b.charge({
              provider: "anthropic",
              model: ps.model || "claude",
              kind: "tokens",
              inputTokens: u.inputTokens || 0,
              cachedInputTokens: u.cachedInputTokens || 0,
              outputTokens: u.outputTokens || 0,
              costMicros: chCost,
              requestId: ps.sessionId || undefined,
              idempotencyKey: `anthropic:${ps.sessionId || ctx.runId}`,
              qty: (u.inputTokens || 0) + (u.outputTokens || 0) || 0,
            });
          }, budgetOpts);
        } catch (chargeErr) {
          await onLog("stderr", `[paperclip] cost charge note (non-fatal): ${chargeErr}\n`);
        }
        return {
          result: toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true }),
          parsed: retry.parsed,
          stdout: retry.proc.stdout,
          stderr: retry.proc.stderr,
        };
      }

      // ELI-78: charge using the withBudget SDK helper (wraps post-provider charge; ensures ctx dims + idempotencyKey rule).
      try {
        await withBudget(ctx, async (b) => {
          const ps = initial.parsedStream || {};
          const u = ps.usage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
          const chCost = typeof ps.costUsd === "number"
            ? Math.ceil(ps.costUsd * 1_000_000)
            : Math.ceil(((u.inputTokens || 0) + (u.outputTokens || 0)) * 3);
          await b.charge({
            provider: "anthropic",
            model: ps.model || "claude",
            kind: "tokens",
            inputTokens: u.inputTokens || 0,
            cachedInputTokens: u.cachedInputTokens || 0,
            outputTokens: u.outputTokens || 0,
            costMicros: chCost,
            requestId: ps.sessionId || undefined,
            idempotencyKey: `anthropic:${ps.sessionId || ctx.runId}`,
            qty: (u.inputTokens || 0) + (u.outputTokens || 0) || 0,
          });
        }, budgetOpts);
      } catch (chargeErr) {
        await onLog("stderr", `[paperclip] cost charge note (non-fatal): ${chargeErr}\n`);
      }

      return {
        result: toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId }),
        parsed: initial.parsed,
        stdout: initial.proc.stdout,
        stderr: initial.proc.stderr,
      };
    };

    // ELI-243: attach the per-account audit trail to resultJson without disturbing
    // any other terminal fields. Skipped when there were no rotation rows so the
    // single-account path's resultJson stays byte-for-byte unchanged.
    const mergeAccountAttempts = (
      result: AdapterExecutionResult,
      rows: ClaudeAccountAttempt[],
    ): AdapterExecutionResult =>
      rows.length === 0
        ? result
        : { ...result, resultJson: { ...(result.resultJson ?? {}), claudeAccountAttempts: rows } };

    const claudeAccounts = resolveClaudeAccounts(config);

    // No rotation list configured → identical to the historical single-account
    // path (auth via the already-resolved env.CLAUDE_CONFIG_DIR).
    if (claudeAccounts.length === 0) {
      return (await executeOnceForAccount()).result;
    }

    // Multi-account failover. Try each account in declared order, pointing
    // env.CLAUDE_CONFIG_DIR at its configDir. Advance to the next account only on
    // an auth-class failure (allowlist) or a missing config dir; any other outcome
    // (success or a non-auth failure) terminates the loop and preserves the
    // existing terminal result.
    const attempts: ClaudeAccountAttempt[] = [];
    for (let index = 0; index < claudeAccounts.length; index++) {
      const account: ClaudeAccount = claudeAccounts[index];
      const advancedTo = index + 1 < claudeAccounts.length ? claudeAccounts[index + 1].label : null;
      const startedAt = new Date().toISOString();

      // Missing config dir: record and advance WITHOUT invoking the CLI.
      if (!(await claudeConfigDirExists(account.configDir))) {
        attempts.push({
          attemptIndex: index,
          label: account.label,
          configDir: account.configDir,
          startedAt,
          completedAt: new Date().toISOString(),
          outcome: "config_dir_missing",
          errorMessage: `Config directory not found: ${account.configDir}`,
          advancedTo,
        });
        await onLog(
          "stdout",
          `[paperclip] Claude account "${account.label}" config dir "${account.configDir}" not found; advancing${advancedTo ? ` to "${advancedTo}"` : " (exhausted)"}.\n`,
        );
        continue;
      }

      env.CLAUDE_CONFIG_DIR = account.configDir;
      loggedEnv.CLAUDE_CONFIG_DIR = account.configDir;

      const attempt = await executeOnceForAccount();
      const completedAt = new Date().toISOString();
      const authClass =
        Boolean(attempt.result.errorCode) &&
        isClaudeAuthClassFailure({
          parsed: attempt.parsed,
          stdout: attempt.stdout,
          stderr: attempt.stderr,
        });

      if (authClass) {
        attempts.push({
          attemptIndex: index,
          label: account.label,
          configDir: account.configDir,
          startedAt,
          completedAt,
          outcome: "auth_required",
          errorMessage: attempt.result.errorMessage ?? "Not logged in",
          advancedTo,
        });
        await onLog(
          "stdout",
          `[paperclip] Claude account "${account.label}" requires login; advancing${advancedTo ? ` to "${advancedTo}"` : " (exhausted)"}.\n`,
        );
        continue;
      }

      // Success or non-auth terminal failure: stop rotating. A success records a
      // final audit row; a non-auth failure keeps its existing terminal shape
      // (detail already carried by errorCode/errorMessage) and only carries the
      // prior rotation rows, if any.
      if (!attempt.result.errorCode) {
        attempts.push({
          attemptIndex: index,
          label: account.label,
          configDir: account.configDir,
          startedAt,
          completedAt,
          outcome: "success",
          advancedTo: null,
        });
      }
      return mergeAccountAttempts(attempt.result, attempts);
    }

    // Exhaustion: every configured account produced an auth-class failure (or a
    // missing config dir). Surface the terminal claude_auth_required outcome with
    // the full audit array and an errorMessage listing all attempted labels.
    const exhaustedLabels = claudeAccounts.map((account) => account.label);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Auth required on all ${claudeAccounts.length} configured Claude accounts: ${exhaustedLabels.join(", ")}`,
      errorCode: "claude_auth_required",
      errorFamily: null,
      provider: "anthropic",
      biller: isBedrockAuth(effectiveEnv) ? "aws_bedrock" : "anthropic",
      billingType,
      resultJson: { claudeAccountAttempts: attempts },
      clearSession: false,
    };
  } finally {
    if (paperclipBridge) {
      await paperclipBridge.stop();
    }
    if (restoreRemoteWorkspace) {
      await onLog(
        "stdout",
        `[paperclip] Restoring workspace changes from ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      await restoreRemoteWorkspace();
    }
  }
}
