#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { buildReleasePackagePlan } from "./release-package-map.mjs";

// Dependency sections that ship to external consumers via `npm install`. devDependencies
// are intentionally excluded: npm does not install a published package's devDependencies,
// so an unresolvable workspace devDep cannot break a downstream install.
const WORKSPACE_DEP_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"];

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function isWorkspaceProtocol(spec) {
  // Matches workspace:*, workspace:^, workspace:~, workspace:^1.2.3, etc.
  return typeof spec === "string" && spec.startsWith("workspace:");
}

function classifyNpmViewFailure(output) {
  return /\bE404\b|404 Not Found|could not be found/i.test(output) ? "missing" : "registry_error";
}

function inspectNpmPackage(packageName) {
  const result = spawnSync("npm", ["view", packageName, "name", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    return { status: "exists" };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const failureType = classifyNpmViewFailure(output);

  if (failureType === "missing") {
    return { status: "missing" };
  }

  return {
    status: "registry_error",
    detail: output || `npm view exited with status ${result.status ?? "unknown"}`,
  };
}

function readGitFileAtRevision(revision, filePath) {
  const result = spawnSync("git", ["show", `${revision}:${normalizePath(filePath)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    return result.stdout;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (
    /exists on disk, but not in/i.test(output) ||
    /does not exist in/i.test(output)
  ) {
    return null;
  }

  throw new Error(`failed to read ${filePath} at ${revision}:\n${output || "git show failed"}`);
}

function getBaseReleaseState(
  revision,
  releasePackages = buildReleasePackagePlan(),
  readFileAtRevision = readGitFileAtRevision,
) {
  if (!revision) return null;

  const manifestText = readFileAtRevision(revision, "scripts/release-package-manifest.json");

  if (manifestText) {
    const manifestEntries = JSON.parse(manifestText);

    if (!Array.isArray(manifestEntries)) {
      throw new Error(`expected scripts/release-package-manifest.json at ${revision} to contain an array`);
    }

    return {
      source: "manifest",
      byDir: new Map(
        manifestEntries
          .filter((entry) => entry?.publishFromCi === true && typeof entry.dir === "string" && typeof entry.name === "string")
          .map((entry) => [entry.dir, { name: entry.name, publishFromCi: true }]),
      ),
    };
  }

  const byDir = new Map();

  for (const pkg of releasePackages) {
    const packageJsonText = readFileAtRevision(revision, `${pkg.dir}/package.json`);
    if (!packageJsonText) continue;

    const basePackage = JSON.parse(packageJsonText);
    if (basePackage.private) continue;

    byDir.set(pkg.dir, {
      name: basePackage.name,
      publishFromCi: true,
    });
  }

  return {
    source: "public-packages",
    byDir,
  };
}

function collectReleasePackagesForChangedPaths(
  changedPaths,
  releasePackages = buildReleasePackagePlan(),
  baseReleaseState = null,
) {
  const normalizedChangedPaths = changedPaths.map(normalizePath);
  const manifestFileChanged = normalizedChangedPaths.includes("scripts/release-package-manifest.json");
  const changedReleasePackages = [];
  const seen = new Set();

  for (const pkg of releasePackages) {
    if (!pkg.publishFromCi) continue;
    const packageJsonPath = `${pkg.dir}/package.json`;
    const packageJsonChanged = normalizedChangedPaths.includes(packageJsonPath);
    const basePackage = baseReleaseState?.byDir.get(pkg.dir);
    const newlyReleaseEnabled =
      manifestFileChanged &&
      (!baseReleaseState || !basePackage || basePackage.publishFromCi !== true || basePackage.name !== pkg.name);
    const isRelevant = packageJsonChanged || newlyReleaseEnabled;

    if (!isRelevant) continue;
    if (seen.has(pkg.name)) continue;

    changedReleasePackages.push(pkg);
    seen.add(pkg.name);
  }

  return changedReleasePackages;
}

// Validate that every `publishFromCi: true` package's intra-repo `workspace:*` dependency
// edges resolve once published. scripts/release.sh rewrites `workspace:*` to the concrete
// release version at publish time, so a workspace dep that is NOT itself release-enabled (and
// published at that same version) ships an unresolvable `@scope/dep@<version>` that external
// `npm install` cannot satisfy. The legacy "changed manifest" gate misses this because the
// offending edge can sit latent until the next routine release of the enabled package.
//
// `npmStatusByName` maps a dependency name to "exists" | "missing" | "registry_error". It is
// only consulted for release-enabled dep targets; disabled / not-in-repo targets fail on the
// graph shape alone and need no registry lookup. Pure + injectable for unit testing.
function collectWorkspaceDependencyViolations(releasePackages, npmStatusByName = new Map()) {
  const byName = new Map(releasePackages.map((pkg) => [pkg.name, pkg]));
  const violations = [];
  const registryFailures = [];

  for (const pkg of releasePackages) {
    if (!pkg.publishFromCi) continue;

    for (const section of WORKSPACE_DEP_SECTIONS) {
      const deps = pkg.pkg?.[section] ?? {};

      for (const [depName, spec] of Object.entries(deps)) {
        if (!isWorkspaceProtocol(spec)) continue;

        const dep = byName.get(depName);

        if (!dep) {
          violations.push(
            `${pkg.name} (${pkg.dir}) declares ${depName} as "${spec}" in ${section}, but ${depName} is not a package in this repo; a workspace: dependency must resolve to a local package`,
          );
          continue;
        }

        if (!dep.publishFromCi) {
          violations.push(
            `${pkg.name} (${pkg.dir}) depends on ${depName} as "${spec}" in ${section}, but ${depName} (${dep.dir}) is not release-enabled (publishFromCi: false). scripts/release.sh rewrites "${spec}" to the concrete release version at publish time, so the next ${pkg.name} release would ship an unresolvable ${depName}@<version> dependency. Enable publishFromCi for ${depName} (and bootstrap its first npm publish) or remove the dependency`,
          );
          continue;
        }

        const npmStatus = npmStatusByName.get(depName);

        if (npmStatus === "missing") {
          violations.push(
            `${pkg.name} (${pkg.dir}) depends on ${depName} as "${spec}" in ${section}; ${depName} is release-enabled but does not exist on npm yet, so the rewritten dependency cannot resolve. Bootstrap the first publish of ${depName} before merge`,
          );
        } else if (npmStatus === "registry_error") {
          registryFailures.push(
            `${depName} (dependency of ${pkg.name}) could not be checked against npm due to a registry error`,
          );
        }
      }
    }
  }

  return { violations, registryFailures };
}

function main(changedPaths) {
  const releasePackages = buildReleasePackagePlan();
  const baseReleaseState = getBaseReleaseState(process.env.PAPERCLIP_RELEASE_BOOTSTRAP_BASE_SHA, releasePackages);
  const changedReleasePackages = collectReleasePackagesForChangedPaths(changedPaths, releasePackages, baseReleaseState);

  // Memoize npm lookups by package name so the changed-package pass and the
  // workspace-dependency pass never view the same package twice.
  const npmStatusCache = new Map();
  function lookupNpmStatus(packageName) {
    if (!npmStatusCache.has(packageName)) {
      npmStatusCache.set(packageName, inspectNpmPackage(packageName));
    }
    return npmStatusCache.get(packageName);
  }

  const missingPackages = [];
  const registryFailures = [];

  for (const pkg of changedReleasePackages) {
    const npmStatus = lookupNpmStatus(pkg.name);

    if (npmStatus.status === "missing") {
      missingPackages.push(pkg);
      continue;
    }

    if (npmStatus.status === "registry_error") {
      registryFailures.push({ pkg, detail: npmStatus.detail });
    }
  }

  if (missingPackages.length > 0) {
    const details = missingPackages
      .map(
        (pkg) =>
          `${pkg.name} (${pkg.dir}) is release-enabled but does not exist on npm yet; bootstrap the first publish before merge or keep it out of CI release enrollment`,
      )
      .join("\n- ");

    throw new Error(`release package bootstrap check failed:\n- ${details}`);
  }

  if (registryFailures.length > 0) {
    const details = registryFailures
      .map(
        ({ pkg, detail }) =>
          `${pkg.name} (${pkg.dir}) could not be checked against npm due to a registry error:\n${detail}`,
      )
      .join("\n- ");

    throw new Error(`release package bootstrap check could not verify npm state:\n- ${details}`);
  }

  // Always validate the full workspace-dependency graph of release-enabled packages,
  // independent of which manifests changed in this PR. A latent unresolvable edge (an
  // enabled package depending on a disabled/unpublished workspace package) would otherwise
  // stay green until the offending package's next routine release ships a broken dependency.
  const enabledDepTargets = new Set();
  const byName = new Map(releasePackages.map((pkg) => [pkg.name, pkg]));
  for (const pkg of releasePackages) {
    if (!pkg.publishFromCi) continue;
    for (const section of WORKSPACE_DEP_SECTIONS) {
      for (const [depName, spec] of Object.entries(pkg.pkg?.[section] ?? {})) {
        if (!isWorkspaceProtocol(spec)) continue;
        const dep = byName.get(depName);
        // Only release-enabled targets need an npm presence check; disabled / not-in-repo
        // targets are rejected on graph shape alone.
        if (dep?.publishFromCi) enabledDepTargets.add(depName);
      }
    }
  }

  const npmStatusByName = new Map();
  for (const depName of enabledDepTargets) {
    npmStatusByName.set(depName, lookupNpmStatus(depName).status);
  }

  const { violations, registryFailures: depRegistryFailures } = collectWorkspaceDependencyViolations(
    releasePackages,
    npmStatusByName,
  );

  if (violations.length > 0) {
    throw new Error(`release workspace dependency check failed:\n- ${violations.join("\n- ")}`);
  }

  if (depRegistryFailures.length > 0) {
    throw new Error(
      `release workspace dependency check could not verify npm state:\n- ${depRegistryFailures.join("\n- ")}`,
    );
  }

  if (changedReleasePackages.length === 0) {
    process.stdout.write(
      "No release-enabled package manifests changed in this PR; workspace dependency graph OK.\n",
    );
    return;
  }

  process.stdout.write(
    `Release bootstrap OK for changed manifests: ${changedReleasePackages.map((pkg) => pkg.name).join(", ")}; workspace dependency graph OK.\n`,
  );
}

if (process.argv[1] && normalizePath(process.argv[1]).endsWith("scripts/check-release-package-bootstrap.mjs")) {
  main(process.argv.slice(2));
}

export {
  classifyNpmViewFailure,
  collectReleasePackagesForChangedPaths,
  collectWorkspaceDependencyViolations,
  getBaseReleaseState,
  isWorkspaceProtocol,
};
