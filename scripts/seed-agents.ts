/**
 * seed-agents.ts -- Paperclip Fleet Agent Seeder
 *
 * Imports agent definitions from the agency-agents repository into Paperclip AI.
 * Reads YAML frontmatter + Markdown body from .md files, maps categories to
 * departments, builds an org chart hierarchy, and creates everything via the
 * Paperclip REST API.
 *
 * ============================================================================
 * Environment Variables
 * ============================================================================
 *
 *   PAPERCLIP_API_URL   (required) Base URL of the Paperclip API.
 *                        Example: http://paperclip.paperclip.svc.cluster.local:3100
 *
 *   PAPERCLIP_AUTH_TOKEN (required) Bearer token for Paperclip API authentication.
 *
 *   AGENTS_DIR           (required) Absolute path to the agency-agents directory
 *                        containing .md agent definition files.
 *
 *   DRY_RUN              (optional) Set to "true" to parse and validate without
 *                        making API calls. Useful for testing the parser.
 *
 * ============================================================================
 * Usage
 * ============================================================================
 *
 *   # Install dependencies
 *   npm install
 *
 *   # Run the seed script
 *   PAPERCLIP_API_URL=http://localhost:3100 \
 *   PAPERCLIP_AUTH_TOKEN=your-token \
 *   AGENTS_DIR=/path/to/agency-agents \
 *   npm run seed
 *
 *   # Dry run (parse only, no API calls)
 *   PAPERCLIP_API_URL=http://localhost:3100 \
 *   PAPERCLIP_AUTH_TOKEN=your-token \
 *   AGENTS_DIR=/path/to/agency-agents \
 *   npm run seed:dry-run
 *
 * ============================================================================
 * Paperclip API Endpoints Used
 * ============================================================================
 *
 *   POST /api/companies              Create the MareAnalytica company
 *   GET  /api/companies?name=X       Check if company exists (idempotency)
 *   POST /api/departments            Create a department under the company
 *   GET  /api/departments?name=X     Check if department exists (idempotency)
 *   POST /api/agents                 Create an agent profile
 *   GET  /api/agents?name=X          Check if agent exists (idempotency)
 *   POST /api/org-chart/positions    Set org chart position for an agent
 *
 * ============================================================================
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import departmentMappingRaw from "./department-mapping.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of each entry in department-mapping.json */
interface DepartmentMappingEntry {
  name: string;
  description: string;
}

/** The full department mapping keyed by lowercase category */
type DepartmentMapping = Record<string, DepartmentMappingEntry>;

/** Parsed frontmatter fields from an agency-agents .md file */
interface AgentFrontmatter {
  name?: string;
  category?: string;
  description?: string;
  model?: string;
  tools?: string[];
  role?: string;
  [key: string]: unknown;
}

/** A fully parsed agent definition ready for import */
interface ParsedAgent {
  filename: string;
  name: string;
  category: string;
  description: string;
  model: string;
  tools: string[];
  role: string;
  systemPrompt: string;
  adapter: "codex_local" | "claude_local";
  budgetMonthly: number;
}

/** Result of attempting to parse a single .md file */
type ParseResult =
  | { ok: true; agent: ParsedAgent }
  | { ok: false; filename: string; reason: string };

/** API response envelope -- Paperclip wraps responses in { data, error } */
interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}

/** Minimal shape of a created company from the API */
interface CompanyRecord {
  id: string;
  name: string;
}

/** Minimal shape of a created department from the API */
interface DepartmentRecord {
  id: string;
  name: string;
  companyId: string;
}

/** Minimal shape of a created agent from the API */
interface AgentRecord {
  id: string;
  name: string;
  departmentId?: string;
}

/** Minimal shape of an org chart position from the API */
interface PositionRecord {
  id: string;
  agentId: string;
  parentId?: string | null;
}

/** Accumulated counters for the summary report */
interface ImportSummary {
  totalFiles: number;
  successCount: number;
  skippedCount: number;
  skippedReasons: Array<{ filename: string; reason: string }>;
  departmentsCreated: string[];
  orgChartDepth: number;
  failedApiCalls: number;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  const stream = level === "ERROR" || level === "WARN" ? process.stderr : process.stdout;
  stream.write(`[${timestamp}] [${level}] ${message}${metaStr}\n`);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Config {
  apiUrl: string;
  authToken: string;
  agentsDir: string;
  dryRun: boolean;
}

function loadConfig(): Config {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const authToken = process.env.PAPERCLIP_AUTH_TOKEN;
  const agentsDir = process.env.AGENTS_DIR;
  const dryRun = process.env.DRY_RUN === "true";

  const missing: string[] = [];
  if (!apiUrl) missing.push("PAPERCLIP_API_URL");
  if (!authToken) missing.push("PAPERCLIP_AUTH_TOKEN");
  if (!agentsDir) missing.push("AGENTS_DIR");

  if (missing.length > 0) {
    log("ERROR", `Missing required environment variables: ${missing.join(", ")}`);
    log("ERROR", "See script header comments for usage instructions.");
    process.exit(1);
  }

  if (!existsSync(agentsDir!)) {
    log("ERROR", `AGENTS_DIR does not exist: ${agentsDir}`);
    process.exit(1);
  }

  return {
    apiUrl: apiUrl!.replace(/\/+$/, ""), // strip trailing slashes
    authToken: authToken!,
    agentsDir: agentsDir!,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Paperclip API Client
// ---------------------------------------------------------------------------

class PaperclipClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string, authToken: string) {
    this.baseUrl = baseUrl;
    this.headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    };
  }

  /** Generic GET request */
  private async get<T>(path: string): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    log("DEBUG", `GET ${url}`);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: this.headers,
      });
      if (!response.ok) {
        const body = await response.text();
        return { error: `HTTP ${response.status}: ${body}` };
      }
      return (await response.json()) as ApiResponse<T>;
    } catch (err) {
      return { error: `Network error: ${(err as Error).message}` };
    }
  }

  /** Generic POST request */
  private async post<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${path}`;
    log("DEBUG", `POST ${url}`);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const responseBody = await response.text();
        return { error: `HTTP ${response.status}: ${responseBody}` };
      }
      return (await response.json()) as ApiResponse<T>;
    } catch (err) {
      return { error: `Network error: ${(err as Error).message}` };
    }
  }

  // -- Company ----------------------------------------------------------------

  async findCompanyByName(name: string): Promise<CompanyRecord | null> {
    const res = await this.get<CompanyRecord[]>(
      `/api/companies?name=${encodeURIComponent(name)}`
    );
    if (res.error || !res.data) return null;
    const companies = Array.isArray(res.data) ? res.data : [res.data];
    return companies.find((c) => c.name === name) ?? null;
  }

  async createCompany(name: string): Promise<CompanyRecord | null> {
    const res = await this.post<CompanyRecord>("/api/companies", { name });
    if (res.error) {
      log("ERROR", `Failed to create company "${name}"`, { error: res.error });
      return null;
    }
    return res.data ?? null;
  }

  // -- Department -------------------------------------------------------------

  async findDepartmentByName(
    companyId: string,
    name: string
  ): Promise<DepartmentRecord | null> {
    const res = await this.get<DepartmentRecord[]>(
      `/api/departments?companyId=${encodeURIComponent(companyId)}&name=${encodeURIComponent(name)}`
    );
    if (res.error || !res.data) return null;
    const departments = Array.isArray(res.data) ? res.data : [res.data];
    return departments.find((d) => d.name === name) ?? null;
  }

  async createDepartment(
    companyId: string,
    name: string,
    description: string
  ): Promise<DepartmentRecord | null> {
    const res = await this.post<DepartmentRecord>("/api/departments", {
      companyId,
      name,
      description,
    });
    if (res.error) {
      log("ERROR", `Failed to create department "${name}"`, { error: res.error });
      return null;
    }
    return res.data ?? null;
  }

  // -- Agent ------------------------------------------------------------------

  async findAgentByName(name: string): Promise<AgentRecord | null> {
    const res = await this.get<AgentRecord[]>(
      `/api/agents?name=${encodeURIComponent(name)}`
    );
    if (res.error || !res.data) return null;
    const agents = Array.isArray(res.data) ? res.data : [res.data];
    return agents.find((a) => a.name === name) ?? null;
  }

  async createAgent(payload: {
    name: string;
    description: string;
    departmentId: string;
    companyId: string;
    adapter: string;
    model: string;
    systemPrompt: string;
    budgetMonthly: number;
    role: string;
    tools: string[];
  }): Promise<AgentRecord | null> {
    const res = await this.post<AgentRecord>("/api/agents", payload);
    if (res.error) {
      log("ERROR", `Failed to create agent "${payload.name}"`, { error: res.error });
      return null;
    }
    return res.data ?? null;
  }

  // -- Org Chart --------------------------------------------------------------

  async createPosition(payload: {
    agentId: string;
    companyId: string;
    title: string;
    parentId?: string | null;
  }): Promise<PositionRecord | null> {
    const res = await this.post<PositionRecord>("/api/org-chart/positions", payload);
    if (res.error) {
      log("ERROR", `Failed to create org chart position for "${payload.title}"`, {
        error: res.error,
      });
      return null;
    }
    return res.data ?? null;
  }
}

// ---------------------------------------------------------------------------
// File Parsing
// ---------------------------------------------------------------------------

const departmentMapping = departmentMappingRaw as DepartmentMapping;

/**
 * Discover all .md files in the agents directory (non-recursive, top-level only).
 * Returns sorted filenames for deterministic processing order.
 */
function discoverAgentFiles(agentsDir: string): string[] {
  const entries = readdirSync(agentsDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

/**
 * Parse a single .md file from the agency-agents repo.
 *
 * Expected format:
 *   ---
 *   name: Agent Name
 *   category: engineering
 *   description: What the agent does
 *   model: claude-sonnet-4-20250514
 *   tools:
 *     - tool-a
 *     - tool-b
 *   ---
 *   # System Prompt
 *   The markdown body becomes the system prompt.
 *
 * Agents with a `tools` field (non-empty array) are assigned the codex_local
 * adapter. All others are assigned claude_local.
 */
function parseAgentFile(agentsDir: string, filename: string): ParseResult {
  const filepath = join(agentsDir, filename);
  let raw: string;

  try {
    raw = readFileSync(filepath, "utf-8");
  } catch (err) {
    return {
      ok: false,
      filename,
      reason: `Could not read file: ${(err as Error).message}`,
    };
  }

  // Parse YAML frontmatter
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    return {
      ok: false,
      filename,
      reason: `Malformed YAML frontmatter: ${(err as Error).message}`,
    };
  }

  const fm = parsed.data as AgentFrontmatter;

  // Validate required field: name
  if (!fm.name || typeof fm.name !== "string" || fm.name.trim().length === 0) {
    return {
      ok: false,
      filename,
      reason: "Missing or empty 'name' field in frontmatter",
    };
  }

  // Validate and normalize category
  const rawCategory = (fm.category ?? "").toString().toLowerCase().trim();
  if (!rawCategory) {
    return {
      ok: false,
      filename,
      reason: "Missing 'category' field in frontmatter",
    };
  }

  if (!(rawCategory in departmentMapping)) {
    return {
      ok: false,
      filename,
      reason: `Unknown category "${rawCategory}" -- not found in department-mapping.json`,
    };
  }

  // Extract tools array, default to empty
  const tools: string[] = Array.isArray(fm.tools) ? fm.tools.map(String) : [];

  // Determine adapter based on whether the agent has tools
  const adapter: "codex_local" | "claude_local" =
    tools.length > 0 ? "codex_local" : "claude_local";

  const agent: ParsedAgent = {
    filename,
    name: fm.name.trim(),
    category: rawCategory,
    description: (fm.description ?? "").toString().trim(),
    model: (fm.model ?? "claude-sonnet-4-20250514").toString().trim(),
    tools,
    role: (fm.role ?? "").toString().trim(),
    systemPrompt: parsed.content.trim(),
    adapter,
    budgetMonthly: 5, // $5/month default for individual agents
  };

  return { ok: true, agent };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("INFO", "=== Paperclip Fleet Agent Seeder ===");

  // -- Load configuration ---------------------------------------------------
  const config = loadConfig();
  log("INFO", `API URL: ${config.apiUrl}`);
  log("INFO", `Agents directory: ${config.agentsDir}`);
  log("INFO", `Dry run: ${config.dryRun}`);

  // -- Discover and parse agent files ---------------------------------------
  const filenames = discoverAgentFiles(config.agentsDir);
  log("INFO", `Discovered ${filenames.length} .md files`);

  if (filenames.length === 0) {
    log("WARN", "No .md files found in AGENTS_DIR. Nothing to import.");
    process.exit(0);
  }

  const summary: ImportSummary = {
    totalFiles: filenames.length,
    successCount: 0,
    skippedCount: 0,
    skippedReasons: [],
    departmentsCreated: [],
    orgChartDepth: 0,
    failedApiCalls: 0,
  };

  // Parse all files first, collecting successes and failures
  const parsedAgents: ParsedAgent[] = [];
  for (const filename of filenames) {
    const result = parseAgentFile(config.agentsDir, filename);
    if (result.ok) {
      parsedAgents.push(result.agent);
    } else {
      summary.skippedCount++;
      summary.skippedReasons.push({
        filename: result.filename,
        reason: result.reason,
      });
      log("WARN", `Skipped ${result.filename}: ${result.reason}`);
    }
  }

  log("INFO", `Parsed ${parsedAgents.length} valid agents, skipped ${summary.skippedCount}`);

  // Group agents by department
  const agentsByDepartment = new Map<string, ParsedAgent[]>();
  for (const agent of parsedAgents) {
    const deptKey = agent.category;
    if (!agentsByDepartment.has(deptKey)) {
      agentsByDepartment.set(deptKey, []);
    }
    agentsByDepartment.get(deptKey)!.push(agent);
  }

  log("INFO", `Agents span ${agentsByDepartment.size} departments`);

  // -- Dry run stops here ---------------------------------------------------
  if (config.dryRun) {
    log("INFO", "DRY RUN -- skipping API calls");
    printDryRunSummary(parsedAgents, agentsByDepartment, summary);
    process.exit(summary.skippedCount > 0 ? 1 : 0);
  }

  // -- Initialize API client ------------------------------------------------
  const client = new PaperclipClient(config.apiUrl, config.authToken);

  // -- Step 1: Create or find MareAnalytica company -------------------------
  log("INFO", "Step 1: Ensuring MareAnalytica company exists...");
  let company = await client.findCompanyByName("MareAnalytica");
  if (company) {
    log("INFO", `Company "MareAnalytica" already exists (id: ${company.id})`);
  } else {
    company = await client.createCompany("MareAnalytica");
    if (!company) {
      log("ERROR", "Failed to create company. Cannot proceed.");
      process.exit(1);
    }
    log("INFO", `Created company "MareAnalytica" (id: ${company.id})`);
  }

  // -- Step 2: Create CEO agent and root org chart position -----------------
  log("INFO", "Step 2: Ensuring CEO agent exists at org chart root...");

  let ceoAgent = await client.findAgentByName("MareAnalytica CEO");
  if (ceoAgent) {
    log("INFO", `CEO agent already exists (id: ${ceoAgent.id})`);
  } else {
    ceoAgent = await client.createAgent({
      name: "MareAnalytica CEO",
      description:
        "Chief Executive Officer -- root of the MareAnalytica org chart. " +
        "Coordinates department leads and oversees all agent operations.",
      departmentId: "", // CEO sits above departments
      companyId: company.id,
      adapter: "claude_local",
      model: "claude-sonnet-4-20250514",
      systemPrompt:
        "You are the CEO of MareAnalytica's AI agent fleet. You oversee all " +
        "departments and ensure agents operate within their governance boundaries. " +
        "You coordinate cross-department initiatives and escalate issues that " +
        "require human intervention.",
      budgetMonthly: 50,
      role: "CEO",
      tools: [],
    });
    if (!ceoAgent) {
      log("ERROR", "Failed to create CEO agent. Cannot proceed.");
      process.exit(1);
    }
    log("INFO", `Created CEO agent (id: ${ceoAgent.id})`);
  }

  // Create CEO org chart position (root -- no parent)
  const ceoPosition = await client.createPosition({
    agentId: ceoAgent.id,
    companyId: company.id,
    title: "Chief Executive Officer",
    parentId: null,
  });
  if (ceoPosition) {
    log("INFO", `CEO org chart position set (id: ${ceoPosition.id})`);
  } else {
    log("WARN", "Could not create CEO org chart position (may already exist)");
  }

  // -- Step 3: Create departments and department leads ----------------------
  log("INFO", "Step 3: Creating departments and department leads...");

  // Track department IDs and lead position IDs for agent assignment
  const departmentRecords = new Map<string, DepartmentRecord>();
  const leadPositionRecords = new Map<string, PositionRecord>();

  for (const [categoryKey, agents] of agentsByDepartment.entries()) {
    const mappingEntry = departmentMapping[categoryKey];
    if (!mappingEntry) {
      log("WARN", `No mapping for category "${categoryKey}" -- skipping department`);
      continue;
    }

    const deptName = mappingEntry.name;
    const deptDesc = mappingEntry.description;

    // Create or find department
    let dept = await client.findDepartmentByName(company.id, deptName);
    if (dept) {
      log("INFO", `Department "${deptName}" already exists (id: ${dept.id})`);
    } else {
      dept = await client.createDepartment(company.id, deptName, deptDesc);
      if (!dept) {
        log("ERROR", `Failed to create department "${deptName}" -- skipping its ${agents.length} agents`);
        summary.failedApiCalls++;
        for (const agent of agents) {
          summary.skippedCount++;
          summary.skippedReasons.push({
            filename: agent.filename,
            reason: `Department "${deptName}" could not be created`,
          });
        }
        continue;
      }
      log("INFO", `Created department "${deptName}" (id: ${dept.id})`);
      summary.departmentsCreated.push(deptName);
    }
    departmentRecords.set(categoryKey, dept);

    // Create department lead agent
    const leadName = `${deptName} Lead`;
    let leadAgent = await client.findAgentByName(leadName);
    if (leadAgent) {
      log("INFO", `Department lead "${leadName}" already exists (id: ${leadAgent.id})`);
    } else {
      leadAgent = await client.createAgent({
        name: leadName,
        description: `Department lead for ${deptName}. Manages ${agents.length} agents and oversees department operations.`,
        departmentId: dept.id,
        companyId: company.id,
        adapter: "claude_local",
        model: "claude-sonnet-4-20250514",
        systemPrompt:
          `You are the ${deptName} department lead at MareAnalytica. You coordinate ` +
          `the ${agents.length} agents in your department, approve their work within ` +
          `governance boundaries, and escalate cross-department issues to the CEO.`,
        budgetMonthly: 50, // $50/month for department leads
        role: "Department Lead",
        tools: [],
      });
      if (!leadAgent) {
        log("ERROR", `Failed to create lead agent for "${deptName}"`);
        summary.failedApiCalls++;
      }
    }

    // Create lead's org chart position (parent = CEO)
    if (leadAgent && ceoPosition) {
      const leadPos = await client.createPosition({
        agentId: leadAgent.id,
        companyId: company.id,
        title: `${deptName} Lead`,
        parentId: ceoPosition.id,
      });
      if (leadPos) {
        leadPositionRecords.set(categoryKey, leadPos);
        log("INFO", `Org chart position for "${leadName}" set under CEO`);
      } else {
        log("WARN", `Could not set org chart position for "${leadName}" (may already exist)`);
      }
    }
  }

  // -- Step 4: Create individual agents and assign org chart positions ------
  log("INFO", "Step 4: Creating individual agents...");

  for (const agent of parsedAgents) {
    const dept = departmentRecords.get(agent.category);
    if (!dept) {
      summary.skippedCount++;
      summary.skippedReasons.push({
        filename: agent.filename,
        reason: `Department for category "${agent.category}" was not created`,
      });
      log("WARN", `Skipping agent "${agent.name}" -- no department record`);
      continue;
    }

    // Idempotency check
    const existingAgent = await client.findAgentByName(agent.name);
    if (existingAgent) {
      log("INFO", `Agent "${agent.name}" already exists (id: ${existingAgent.id}) -- skipping`);
      summary.successCount++; // Count existing agents as success (idempotent)
      continue;
    }

    // Create the agent
    const created = await client.createAgent({
      name: agent.name,
      description: agent.description,
      departmentId: dept.id,
      companyId: company.id,
      adapter: agent.adapter,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      budgetMonthly: agent.budgetMonthly,
      role: agent.role,
      tools: agent.tools,
    });

    if (!created) {
      summary.failedApiCalls++;
      summary.skippedCount++;
      summary.skippedReasons.push({
        filename: agent.filename,
        reason: "API call to create agent failed",
      });
      continue;
    }

    log("INFO", `Created agent "${agent.name}" (id: ${created.id}, adapter: ${agent.adapter})`);

    // Assign org chart position (parent = department lead)
    const leadPos = leadPositionRecords.get(agent.category);
    if (leadPos) {
      const agentPos = await client.createPosition({
        agentId: created.id,
        companyId: company.id,
        title: agent.name,
        parentId: leadPos.id,
      });
      if (agentPos) {
        log("DEBUG", `Org chart position for "${agent.name}" set under ${agent.category} lead`);
      } else {
        log("WARN", `Could not set org chart position for "${agent.name}"`);
      }
    }

    summary.successCount++;
  }

  // -- Org chart depth: CEO (1) -> dept lead (2) -> individual agent (3) ----
  summary.orgChartDepth = 3;

  // -- Print summary report -------------------------------------------------
  printSummaryReport(summary);

  // -- Exit code: non-zero if any failures ----------------------------------
  const hasFailures = summary.failedApiCalls > 0 || summary.skippedCount > 0;
  process.exit(hasFailures ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Summary Reports
// ---------------------------------------------------------------------------

function printSummaryReport(summary: ImportSummary): void {
  log("INFO", "");
  log("INFO", "============================================================");
  log("INFO", "                  SEED SUMMARY REPORT                       ");
  log("INFO", "============================================================");
  log("INFO", `Total files processed:      ${summary.totalFiles}`);
  log("INFO", `Successfully imported:      ${summary.successCount}`);
  log("INFO", `Skipped:                    ${summary.skippedCount}`);
  log("INFO", `Failed API calls:           ${summary.failedApiCalls}`);
  log("INFO", `Departments created:        ${summary.departmentsCreated.length}`);
  if (summary.departmentsCreated.length > 0) {
    log("INFO", `  Departments: ${summary.departmentsCreated.join(", ")}`);
  }
  log("INFO", `Org chart depth:            ${summary.orgChartDepth}`);
  log("INFO", "");

  if (summary.skippedReasons.length > 0) {
    log("INFO", "--- Skipped Files ---");
    for (const { filename, reason } of summary.skippedReasons) {
      log("INFO", `  ${filename}: ${reason}`);
    }
    log("INFO", "");
  }

  log("INFO", "============================================================");
}

function printDryRunSummary(
  allAgents: ParsedAgent[],
  byDept: Map<string, ParsedAgent[]>,
  summary: ImportSummary
): void {
  log("INFO", "");
  log("INFO", "============================================================");
  log("INFO", "              DRY RUN SUMMARY REPORT                        ");
  log("INFO", "============================================================");
  log("INFO", `Total files discovered:     ${summary.totalFiles}`);
  log("INFO", `Successfully parsed:        ${allAgents.length}`);
  log("INFO", `Skipped (parse errors):     ${summary.skippedCount}`);
  log("INFO", `Departments detected:       ${byDept.size}`);
  log("INFO", "");

  // Per-department breakdown
  log("INFO", "--- Agents by Department ---");
  for (const [category, deptAgents] of byDept.entries()) {
    const mapping = departmentMapping[category];
    const deptName = mapping ? mapping.name : category;
    const codexCount = deptAgents.filter((a) => a.adapter === "codex_local").length;
    const claudeCount = deptAgents.filter((a) => a.adapter === "claude_local").length;
    log("INFO", `  ${deptName}: ${deptAgents.length} agents (codex_local: ${codexCount}, claude_local: ${claudeCount})`);
  }
  log("INFO", "");

  // Adapter summary
  const totalCodex = allAgents.filter((a) => a.adapter === "codex_local").length;
  const totalClaude = allAgents.filter((a) => a.adapter === "claude_local").length;
  log("INFO", "--- Adapter Assignment ---");
  log("INFO", `  codex_local (has tools):  ${totalCodex}`);
  log("INFO", `  claude_local (no tools):  ${totalClaude}`);
  log("INFO", "");

  // Budget summary
  const agentBudget = allAgents.length * 5;
  const leadBudget = byDept.size * 50;
  const ceoBudget = 50;
  log("INFO", "--- Budget Defaults ---");
  log("INFO", `  Individual agents:        ${allAgents.length} x $5/month = $${agentBudget}/month`);
  log("INFO", `  Department leads:         ${byDept.size} x $50/month = $${leadBudget}/month`);
  log("INFO", `  CEO:                      1 x $50/month = $${ceoBudget}/month`);
  log("INFO", `  Total monthly budget:     $${agentBudget + leadBudget + ceoBudget}/month`);
  log("INFO", "");

  // Planned org chart
  log("INFO", "--- Org Chart Structure ---");
  log("INFO", "  Level 0: MareAnalytica CEO");
  for (const [category] of byDept.entries()) {
    const mapping = departmentMapping[category];
    const deptName = mapping ? mapping.name : category;
    log("INFO", `  Level 1: ${deptName} Lead`);
    const deptMembers = byDept.get(category) ?? [];
    const displayCount = Math.min(deptMembers.length, 3);
    for (let i = 0; i < displayCount; i++) {
      log("INFO", `    Level 2: ${deptMembers[i].name}`);
    }
    if (deptMembers.length > 3) {
      log("INFO", `    ... and ${deptMembers.length - 3} more`);
    }
  }
  log("INFO", `  Org chart depth: 3 (CEO -> department lead -> individual agent)`);
  log("INFO", "");

  if (summary.skippedReasons.length > 0) {
    log("INFO", "--- Skipped Files ---");
    for (const { filename, reason } of summary.skippedReasons) {
      log("INFO", `  ${filename}: ${reason}`);
    }
    log("INFO", "");
  }

  log("INFO", "============================================================");
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  log("ERROR", `Unhandled error: ${(err as Error).message}`);
  log("ERROR", (err as Error).stack ?? "No stack trace");
  process.exit(1);
});
