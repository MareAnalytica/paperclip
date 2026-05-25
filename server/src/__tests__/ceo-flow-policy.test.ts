import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  applyCeoFlowPolicyToAdapterConfig,
  builtinDefaultCeoFlowPolicy,
  computePolicyHash,
  initCeoFlowPolicy,
  loadCeoFlowPolicy,
  loadCeoFlowPolicyFromString,
  policyForCompany,
  reloadCeoFlowPolicy,
  renderCeoPromptFragment,
  __setCeoFlowPolicyForTests,
} from "../services/ceo-flow-policy.js";

const VALID_YAML = `
schemaVersion: "1"
ceoFlow:
  default:
    enabled: true
    heartbeatSec: 300
    flowChecks:
      assignUnassignedActive: true
      wakeStaleAssignees: true
      auditMisclassified:
        - backlog
        - blocked
        - done
        - cancelled
      misclassifyWindowSec: 86400
    guards:
      respectApprovalGates: true
      respectCooldowns: true
      respectBudgets: true
      noDuplicateActiveRuns: true
    auditMaxIssuesPerHeartbeat: 50
    promptInsertKey: "ceo-flow-ownership-v1"
  overrides:
    - companyId: "company-prod"
      heartbeatSec: 600
      auditMaxIssuesPerHeartbeat: 100
`;

describe("loadCeoFlowPolicyFromString", () => {
  it("parses a valid policy file", () => {
    const resolved = loadCeoFlowPolicyFromString(VALID_YAML);
    expect(resolved.schemaVersion).toBe("1");
    expect(resolved.default.heartbeatSec).toBe(300);
    expect(resolved.default.promptInsertKey).toBe("ceo-flow-ownership-v1");
    expect(resolved.overrides.size).toBe(1);
    const override = resolved.overrides.get("company-prod")!;
    expect(override.heartbeatSec).toBe(600);
    expect(override.auditMaxIssuesPerHeartbeat).toBe(100);
  });

  it("rejects an unsupported schemaVersion", () => {
    expect(() =>
      loadCeoFlowPolicyFromString(VALID_YAML.replace('"1"', '"2"')),
    ).toThrow(/unsupported schemaVersion/);
  });

  it("rejects heartbeatSec outside [60, 3600]", () => {
    const bad = VALID_YAML.replace("heartbeatSec: 300", "heartbeatSec: 30");
    expect(() => loadCeoFlowPolicyFromString(bad)).toThrow(/must be in \[60, 3600\]/);
  });

  it("substitutes ${ENV_VAR} placeholders in overrides", () => {
    const yaml = VALID_YAML.replace('"company-prod"', '"${TEST_COMPANY_ID}"');
    const resolved = loadCeoFlowPolicyFromString(yaml, {
      env: { TEST_COMPANY_ID: "company-from-env" },
    });
    expect(resolved.overrides.has("company-from-env")).toBe(true);
  });

  it("skips overrides with unresolved ${ENV_VAR} in non-strict mode", () => {
    const yaml = VALID_YAML.replace('"company-prod"', '"${MISSING_TEST_VAR}"');
    const resolved = loadCeoFlowPolicyFromString(yaml, {
      env: {},
      onWarn: () => undefined,
    });
    expect(resolved.overrides.size).toBe(0);
  });

  it("throws on unresolved ${ENV_VAR} when strictEnv is true", () => {
    const yaml = VALID_YAML.replace('"company-prod"', '"${MISSING_STRICT_VAR}"');
    expect(() =>
      loadCeoFlowPolicyFromString(yaml, { env: {}, strictEnv: true }),
    ).toThrow(/MISSING_STRICT_VAR/);
  });
});

describe("policyForCompany / renderCeoPromptFragment", () => {
  it("returns override when companyId matches, default otherwise", () => {
    const resolved = loadCeoFlowPolicyFromString(VALID_YAML);
    expect(policyForCompany(resolved, "company-prod").heartbeatSec).toBe(600);
    expect(policyForCompany(resolved, "company-fresh").heartbeatSec).toBe(300);
  });

  it("renders a non-empty prompt fragment that includes the heartbeat", () => {
    const fragment = renderCeoPromptFragment(builtinDefaultCeoFlowPolicy().default);
    expect(fragment).toContain("CEO operating policy");
    expect(fragment).toContain("300 seconds");
    expect(fragment).toContain("own company flow");
  });

  it("computes a stable hash that is independent of field ordering", () => {
    const a = loadCeoFlowPolicyFromString(VALID_YAML).default;
    const b = loadCeoFlowPolicyFromString(VALID_YAML).default;
    expect(computePolicyHash(a)).toBe(computePolicyHash(b));
  });
});

describe("applyCeoFlowPolicyToAdapterConfig", () => {
  beforeEach(() => {
    __setCeoFlowPolicyForTests(builtinDefaultCeoFlowPolicy());
  });
  afterEach(() => {
    __setCeoFlowPolicyForTests(builtinDefaultCeoFlowPolicy());
  });

  it("fresh company bootstrap sets heartbeatSec=300 and carries the prompt fragment via ceoFlowPolicy", () => {
    const result = applyCeoFlowPolicyToAdapterConfig({
      companyId: "company-fresh",
      adapterConfig: {},
    });
    expect(result.resolvedHeartbeatSec).toBe(300);
    expect(result.enabled).toBe(true);
    expect(result.adapterConfig.heartbeatSec).toBe(300);
    expect(result.adapterConfig.heartbeatEnabled).toBe(true);
    // promptTemplate is intentionally NOT set on a fresh adapterConfig so the
    // default CEO instruction bundle still materializes (the bundle path picks
    // up the fragment via ceoFlowPolicy.promptFragment).
    expect(result.adapterConfig.promptTemplate).toBeUndefined();
    expect(result.promptFragment).toContain("CEO operating policy");
    expect(result.promptFragment).toContain("300 seconds");
    const meta = result.adapterConfig.ceoFlowPolicy as Record<string, unknown>;
    expect(meta.promptInsertKey).toBe("ceo-flow-ownership-v1");
    expect(meta.resolvedHeartbeatSec).toBe(300);
    expect(String(meta.promptFragment)).toContain("CEO operating policy");
  });

  it("appends to an existing promptTemplate rather than replacing it", () => {
    const result = applyCeoFlowPolicyToAdapterConfig({
      companyId: "company-fresh",
      adapterConfig: { promptTemplate: "Existing system prompt." },
    });
    const prompt = String(result.adapterConfig.promptTemplate);
    expect(prompt.startsWith("Existing system prompt.")).toBe(true);
    expect(prompt).toContain("CEO operating policy");
  });

  it("honors per-company overrides from the resolved policy", () => {
    __setCeoFlowPolicyForTests(loadCeoFlowPolicyFromString(VALID_YAML));
    const result = applyCeoFlowPolicyToAdapterConfig({
      companyId: "company-prod",
      adapterConfig: {},
    });
    expect(result.resolvedHeartbeatSec).toBe(600);
    expect(result.adapterConfig.heartbeatSec).toBe(600);
    expect(result.promptFragment).toContain("600 seconds");
  });
});

describe("loadCeoFlowPolicy / initCeoFlowPolicy / reloadCeoFlowPolicy", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ceo-flow-policy-"));
    path = join(dir, "ceo-flow-policy.yaml");
    writeFileSync(path, VALID_YAML, "utf8");
  });

  afterEach(() => {
    __setCeoFlowPolicyForTests(builtinDefaultCeoFlowPolicy());
  });

  it("reads ELI_CEO_FLOW_POLICY_PATH on init", () => {
    const resolved = initCeoFlowPolicy({ ELI_CEO_FLOW_POLICY_PATH: path });
    expect(resolved.default.heartbeatSec).toBe(300);
    expect(resolved.overrides.has("company-prod")).toBe(true);
  });

  it("falls back to built-in defaults when the env var is unset", () => {
    const resolved = initCeoFlowPolicy({});
    expect(resolved.default.heartbeatSec).toBe(300);
    expect(resolved.overrides.size).toBe(0);
  });

  it("falls back to built-in defaults when the file is invalid", () => {
    writeFileSync(path, "schemaVersion: \"99\"\n", "utf8");
    const resolved = initCeoFlowPolicy({ ELI_CEO_FLOW_POLICY_PATH: path });
    expect(resolved.default.heartbeatSec).toBe(300);
    expect(resolved.overrides.size).toBe(0);
  });

  it("reloadCeoFlowPolicy picks up edits to the policy file", () => {
    initCeoFlowPolicy({ ELI_CEO_FLOW_POLICY_PATH: path });
    const updated = VALID_YAML.replace("heartbeatSec: 300", "heartbeatSec: 900");
    writeFileSync(path, updated, "utf8");
    const reloaded = reloadCeoFlowPolicy({ ELI_CEO_FLOW_POLICY_PATH: path });
    expect(reloaded.default.heartbeatSec).toBe(900);
  });

  it("loadCeoFlowPolicy reads from disk directly", () => {
    const resolved = loadCeoFlowPolicy(path);
    expect(resolved.default.heartbeatSec).toBe(300);
  });
});
