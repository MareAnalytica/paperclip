import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyNpmViewFailure,
  collectReleasePackagesForChangedPaths,
  collectWorkspaceDependencyViolations,
  getBaseReleaseState,
  isWorkspaceProtocol,
} from "./check-release-package-bootstrap.mjs";

function pkg(dir, name, publishFromCi, manifest = {}) {
  return { dir, name, publishFromCi, pkg: { name, ...manifest } };
}

test("manifest changes without base state validate all release-enabled packages", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
    { dir: "packages/c", name: "@paperclipai/c", publishFromCi: false },
  ];

  const changedPackages = collectReleasePackagesForChangedPaths(
    ["scripts/release-package-manifest.json"],
    releasePackages,
  );

  assert.deepEqual(
    changedPackages.map((pkg) => pkg.name),
    ["@paperclipai/a", "@paperclipai/b"],
  );
});

test("manifest changes only validate newly release-enabled packages relative to base state", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
    { dir: "packages/c", name: "@paperclipai/c", publishFromCi: false },
  ];
  const baseReleaseState = {
    source: "manifest",
    byDir: new Map([["packages/a", { name: "@paperclipai/a", publishFromCi: true }]]),
  };

  const changedPackages = collectReleasePackagesForChangedPaths(
    ["scripts/release-package-manifest.json"],
    releasePackages,
    baseReleaseState,
  );

  assert.deepEqual(
    changedPackages.map((pkg) => pkg.name),
    ["@paperclipai/b"],
  );
});

test("package-specific changes only validate affected release-enabled packages", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
  ];

  const changedPackages = collectReleasePackagesForChangedPaths(
    ["packages/b/package.json", "README.md"],
    releasePackages,
  );

  assert.deepEqual(
    changedPackages.map((pkg) => pkg.name),
    ["@paperclipai/b"],
  );
});

test("npm E404 failures are treated as missing packages", () => {
  assert.equal(classifyNpmViewFailure("npm error code E404"), "missing");
  assert.equal(classifyNpmViewFailure("404 Not Found"), "missing");
});

test("non-404 npm failures are treated as registry errors", () => {
  assert.equal(classifyNpmViewFailure("npm error code EAI_AGAIN"), "registry_error");
  assert.equal(classifyNpmViewFailure("npm error code E429"), "registry_error");
});

test("isWorkspaceProtocol recognizes workspace specifiers and rejects others", () => {
  assert.equal(isWorkspaceProtocol("workspace:*"), true);
  assert.equal(isWorkspaceProtocol("workspace:^"), true);
  assert.equal(isWorkspaceProtocol("workspace:~"), true);
  assert.equal(isWorkspaceProtocol("workspace:^1.2.3"), true);
  assert.equal(isWorkspaceProtocol("^1.2.3"), false);
  assert.equal(isWorkspaceProtocol("2026.529.0"), false);
  assert.equal(isWorkspaceProtocol(undefined), false);
});

test("enabled package depending on a disabled workspace package is a violation", () => {
  // The live adapter-utils -> paperclip-cost-client edge: enabled package depends on a
  // publishFromCi:false package via workspace:*, which release.sh would pin to an
  // unpublished release version. No npm lookup required — the graph shape alone fails.
  const releasePackages = [
    pkg("packages/adapter-utils", "@paperclipai/adapter-utils", true, {
      dependencies: { "@paperclipai/paperclip-cost-client": "workspace:*" },
    }),
    pkg("packages/paperclip-cost-client", "@paperclipai/paperclip-cost-client", false),
  ];

  const { violations, registryFailures } = collectWorkspaceDependencyViolations(releasePackages);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /@paperclipai\/adapter-utils/);
  assert.match(violations[0], /@paperclipai\/paperclip-cost-client/);
  assert.match(violations[0], /publishFromCi: false/);
  assert.deepEqual(registryFailures, []);
});

test("once the disabled dependency is enabled and published the edge passes", () => {
  const releasePackages = [
    pkg("packages/adapter-utils", "@paperclipai/adapter-utils", true, {
      dependencies: { "@paperclipai/paperclip-cost-client": "workspace:*" },
    }),
    pkg("packages/paperclip-cost-client", "@paperclipai/paperclip-cost-client", true),
  ];

  const npmStatusByName = new Map([["@paperclipai/paperclip-cost-client", "exists"]]);
  const { violations, registryFailures } = collectWorkspaceDependencyViolations(
    releasePackages,
    npmStatusByName,
  );

  assert.deepEqual(violations, []);
  assert.deepEqual(registryFailures, []);
});

test("enabled workspace dependency that is not yet on npm is a violation", () => {
  const releasePackages = [
    pkg("packages/a", "@paperclipai/a", true, {
      dependencies: { "@paperclipai/b": "workspace:^" },
    }),
    pkg("packages/b", "@paperclipai/b", true),
  ];

  const npmStatusByName = new Map([["@paperclipai/b", "missing"]]);
  const { violations } = collectWorkspaceDependencyViolations(releasePackages, npmStatusByName);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not exist on npm yet/);
});

test("registry error checking an enabled workspace dependency surfaces separately", () => {
  const releasePackages = [
    pkg("packages/a", "@paperclipai/a", true, {
      dependencies: { "@paperclipai/b": "workspace:*" },
    }),
    pkg("packages/b", "@paperclipai/b", true),
  ];

  const npmStatusByName = new Map([["@paperclipai/b", "registry_error"]]);
  const { violations, registryFailures } = collectWorkspaceDependencyViolations(
    releasePackages,
    npmStatusByName,
  );

  assert.deepEqual(violations, []);
  assert.equal(registryFailures.length, 1);
  assert.match(registryFailures[0], /@paperclipai\/b/);
});

test("workspace dependency on a package absent from the repo is a violation", () => {
  const releasePackages = [
    pkg("packages/a", "@paperclipai/a", true, {
      dependencies: { "@paperclipai/ghost": "workspace:*" },
    }),
  ];

  const { violations } = collectWorkspaceDependencyViolations(releasePackages);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /not a package in this repo/);
});

test("non-workspace and disabled-package dependencies are ignored", () => {
  const releasePackages = [
    pkg("packages/a", "@paperclipai/a", true, {
      dependencies: { "@paperclipai/b": "^1.0.0", lodash: "^4.0.0" },
    }),
    // A disabled package's own workspace deps are not enforced — it is never published.
    pkg("packages/c", "@paperclipai/c", false, {
      dependencies: { "@paperclipai/d": "workspace:*" },
    }),
    pkg("packages/b", "@paperclipai/b", true),
    pkg("packages/d", "@paperclipai/d", false),
  ];

  const { violations, registryFailures } = collectWorkspaceDependencyViolations(releasePackages);

  assert.deepEqual(violations, []);
  assert.deepEqual(registryFailures, []);
});

test("base release state falls back to public packages when manifest is absent", () => {
  const releasePackages = [
    { dir: "packages/a", name: "@paperclipai/a", publishFromCi: true },
    { dir: "packages/b", name: "@paperclipai/b", publishFromCi: true },
  ];

  const baseReleaseState = getBaseReleaseState("base-sha", releasePackages, (_revision, filePath) => {
    if (filePath === "scripts/release-package-manifest.json") {
      return null;
    }

    if (filePath === "packages/a/package.json") {
      return JSON.stringify({ name: "@paperclipai/a", private: false });
    }

    if (filePath === "packages/b/package.json") {
      return JSON.stringify({ name: "@paperclipai/b", private: true });
    }

    return null;
  });

  assert.equal(baseReleaseState?.source, "public-packages");
  assert.deepEqual([...baseReleaseState.byDir.entries()], [
    ["packages/a", { name: "@paperclipai/a", publishFromCi: true }],
  ]);
});
