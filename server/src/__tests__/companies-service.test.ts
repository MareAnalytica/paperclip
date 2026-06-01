import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries generated issue prefixes when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Aron Existing",
      issuePrefix: "ARO",
    });

    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("AROA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["ARO", "AROA"]);
  });

  it("defaults trustLevel/capabilityTags/policies and round-trips overrides", async () => {
    const svc = companyService(db);

    const defaulted = await svc.create({ name: "Defaulted Co" });
    expect(defaulted.trustLevel).toBe("standard");
    expect(defaulted.capabilityTags).toEqual([]);
    expect(defaulted.policies).toBeNull();

    const custom = await svc.create({
      name: "Custom Co",
      trustLevel: "elevated",
      capabilityTags: ["scraping", "analytics"],
      policies: { budget: { monthlyCents: 1000 }, model: "sonnet" },
    });
    expect(custom.trustLevel).toBe("elevated");
    expect(custom.capabilityTags).toEqual(["scraping", "analytics"]);
    expect(custom.policies).toEqual({ budget: { monthlyCents: 1000 }, model: "sonnet" });

    const updated = await svc.update(custom.id, {
      trustLevel: "restricted",
      capabilityTags: ["analytics"],
      policies: null,
    });
    expect(updated?.trustLevel).toBe("restricted");
    expect(updated?.capabilityTags).toEqual(["analytics"]);
    expect(updated?.policies).toBeNull();

    const fetched = await svc.getById(custom.id);
    expect(fetched?.trustLevel).toBe("restricted");
    expect(fetched?.capabilityTags).toEqual(["analytics"]);
    expect(fetched?.policies).toBeNull();
  });
});
