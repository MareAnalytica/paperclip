export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
  canForceRelease: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    canCreateAgents: role === "ceo",
    // ELI-912: CEO/flow-controller agents may force-release wedged issue
    // checkouts and in_review execution stages by default. Any other agent
    // (e.g. a designated ops agent) can be granted this explicitly via
    // `permissions.canForceRelease = true`. Config-driven so it stays portable
    // across companies — no agent ids are hard-coded in platform code.
    canForceRelease: role === "ceo",
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  const preserved = { ...record };
  return {
    ...preserved,
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
    canForceRelease:
      typeof record.canForceRelease === "boolean"
        ? record.canForceRelease
        : defaults.canForceRelease,
  };
}
