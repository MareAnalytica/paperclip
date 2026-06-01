import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, providerAccountCooldowns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  getActiveProviderCooldownIds,
  upsertProviderAccountCooldown,
} from "../services/provider-account-cooldown.js";

// DB-level evidence for ticket ELI-855: the cooldown round-trips through real
// Postgres (migration 0097 applies, the unique (company, provider) upsert with
// GREATEST window extension behaves, and the active-read filter honours
// `cooldown_until > now`). Guarded so hosts without embedded Postgres skip.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider-account-cooldown tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("provider_account_cooldowns (DB round-trip)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  const NOW = new Date("2026-06-01T12:00:00.000Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-provider-cooldown-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(providerAccountCooldowns);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Acceptance #1 — a recorded cooldown is observable for scheduler decisions.
  it("records a cooldown from a limit error and surfaces it as active", async () => {
    const cooldownUntil = new Date(NOW.getTime() + 90 * 60_000);
    await upsertProviderAccountCooldown(db, {
      companyId,
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal",
      cooldownUntil,
      source: "provider_header",
      reason: "provider_fallback_limit",
      now: NOW,
    });

    const active = await getActiveProviderCooldownIds(db, companyId, NOW);
    expect([...active]).toEqual(["claude-code-personal"]);
  });

  // GREATEST: a later, shorter back-off must never shorten an honoured window,
  // and (ELI-857) must not mislabel the kept window's provenance either.
  it("keeps the longer window AND its provenance when re-upserting the same provider", async () => {
    const longWindow = new Date(NOW.getTime() + 120 * 60_000);
    const shortWindow = new Date(NOW.getTime() + 10 * 60_000);
    const runLong = randomUUID();
    const issueLong = randomUUID();
    const runShort = randomUUID();
    const issueShort = randomUUID();
    const base = {
      companyId,
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal" as string | null,
      now: NOW,
    };
    // Long window from an honoured provider reset, with its own audit ids.
    await upsertProviderAccountCooldown(db, {
      ...base,
      cooldownUntil: longWindow,
      source: "provider_header",
      reason: "provider_fallback_limit",
      lastRunId: runLong,
      lastIssueId: issueLong,
    });
    // Later, shorter default back-off from a different run/issue: window loses,
    // and so must its provenance.
    await upsertProviderAccountCooldown(db, {
      ...base,
      account: "personal-other",
      cooldownUntil: shortWindow,
      source: "retryAfterMinutesDefault",
      reason: "provider_fallback_default",
      lastRunId: runShort,
      lastIssueId: issueShort,
    });

    const rows = await db
      .select({
        cooldownUntil: providerAccountCooldowns.cooldownUntil,
        account: providerAccountCooldowns.account,
        source: providerAccountCooldowns.source,
        reason: providerAccountCooldowns.reason,
        lastRunId: providerAccountCooldowns.lastRunId,
        lastIssueId: providerAccountCooldowns.lastIssueId,
      })
      .from(providerAccountCooldowns)
      .where(
        and(
          eq(providerAccountCooldowns.companyId, companyId),
          eq(providerAccountCooldowns.providerId, "claude-code-personal"),
        ),
      );
    expect(rows).toHaveLength(1); // one row per (company, provider)
    expect(rows[0]!.cooldownUntil.getTime()).toBe(longWindow.getTime());
    // Provenance stays pinned to the event that owns the live (long) window.
    expect(rows[0]!.source).toBe("provider_header");
    expect(rows[0]!.reason).toBe("provider_fallback_limit");
    expect(rows[0]!.account).toBe("personal");
    expect(rows[0]!.lastRunId).toBe(runLong);
    expect(rows[0]!.lastIssueId).toBe(issueLong);
  });

  // The reverse of ELI-857: when a *longer* window arrives later it wins, so its
  // provenance must replace the older row's — provenance follows the live window.
  it("restamps provenance when a later, longer window extends the cooldown", async () => {
    const shortWindow = new Date(NOW.getTime() + 10 * 60_000);
    const longWindow = new Date(NOW.getTime() + 120 * 60_000);
    const runShort = randomUUID();
    const issueShort = randomUUID();
    const runLong = randomUUID();
    const issueLong = randomUUID();
    const base = {
      companyId,
      providerId: "claude-code-personal",
      adapterType: "claude_local",
      account: "personal" as string | null,
      now: NOW,
    };
    await upsertProviderAccountCooldown(db, {
      ...base,
      cooldownUntil: shortWindow,
      source: "retryAfterMinutesDefault",
      reason: "provider_fallback_default",
      lastRunId: runShort,
      lastIssueId: issueShort,
    });
    await upsertProviderAccountCooldown(db, {
      ...base,
      cooldownUntil: longWindow,
      source: "provider_header",
      reason: "provider_fallback_limit",
      lastRunId: runLong,
      lastIssueId: issueLong,
    });

    const rows = await db
      .select({
        cooldownUntil: providerAccountCooldowns.cooldownUntil,
        source: providerAccountCooldowns.source,
        reason: providerAccountCooldowns.reason,
        lastRunId: providerAccountCooldowns.lastRunId,
        lastIssueId: providerAccountCooldowns.lastIssueId,
      })
      .from(providerAccountCooldowns)
      .where(
        and(
          eq(providerAccountCooldowns.companyId, companyId),
          eq(providerAccountCooldowns.providerId, "claude-code-personal"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cooldownUntil.getTime()).toBe(longWindow.getTime());
    expect(rows[0]!.source).toBe("provider_header");
    expect(rows[0]!.reason).toBe("provider_fallback_limit");
    expect(rows[0]!.lastRunId).toBe(runLong);
    expect(rows[0]!.lastIssueId).toBe(issueLong);
  });

  // Acceptance #3 — an elapsed window is no longer returned (provider eligible).
  it("excludes a provider whose window has elapsed", async () => {
    await upsertProviderAccountCooldown(db, {
      companyId,
      providerId: "claude-code-aflabox",
      adapterType: "claude_local",
      account: "aflabox",
      cooldownUntil: new Date(NOW.getTime() + 5 * 60_000),
      source: "provider_header",
      now: NOW,
    });

    // Read from a point in time after the window: provider is eligible again.
    const afterReset = new Date(NOW.getTime() + 6 * 60_000);
    const active = await getActiveProviderCooldownIds(db, companyId, afterReset);
    expect(active.size).toBe(0);
  });
});
