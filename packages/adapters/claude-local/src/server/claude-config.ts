import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const SEEDED_SHARED_FILES = [
  ".credentials.json",
  "credentials.json",
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
] as const;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function collectSeedFiles(sourceDir: string): Promise<Array<{ name: string; sourcePath: string }>> {
  const files: Array<{ name: string; sourcePath: string }> = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    files.push({ name, sourcePath });
  }
  return files;
}

async function buildSeedSnapshotKey(files: Array<{ name: string; sourcePath: string }>): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(await fs.readFile(file.sourcePath));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: Array<{ name: string; sourcePath: string }>;
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.copyFile(file.sourcePath, path.join(stagingDir, file.name));
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

/**
 * One entry in the ELI-241 Option B multi-account failover list. `label` is a
 * human-readable identifier surfaced in the per-account audit trail; `configDir`
 * is an absolute Claude config directory. The adapter never seeds or creates the
 * directory — a missing one is recorded as a `config_dir_missing` attempt and the
 * loop advances.
 */
export interface ClaudeAccount {
  label: string;
  configDir: string;
}

/**
 * ELI-243: resolve the optional, ordered `claudeAccounts` rotation list from the
 * resolved adapter config. Returns `[]` when the field is absent, empty, or
 * malformed — in which case the adapter preserves its existing single-account
 * behavior (auth via `env.CLAUDE_CONFIG_DIR`). When present, ordering is
 * significant: the first entry is primary, the rest are failover candidates in
 * declared order. Entries missing a `label` or `configDir` are skipped.
 */
export function resolveClaudeAccounts(
  config: Record<string, unknown>,
): ClaudeAccount[] {
  const raw = (config as { claudeAccounts?: unknown }).claudeAccounts;
  if (!Array.isArray(raw)) return [];
  const accounts: ClaudeAccount[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const label = nonEmpty(typeof record.label === "string" ? record.label : undefined);
    const configDir = nonEmpty(typeof record.configDir === "string" ? record.configDir : undefined);
    if (!label || !configDir) continue;
    accounts.push({ label, configDir: path.resolve(configDir) });
  }
  return accounts;
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}
