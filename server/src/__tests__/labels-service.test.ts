import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, labels } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres label service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService labels", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-labels-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(labels);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [row] = await db
      .insert(companies)
      .values({ name: "Label Co", issuePrefix: "LBL" })
      .returning();
    companyId = row!.id;
  }

  it("createLabel persists optional description", async () => {
    await seedCompany();
    const created = await svc.createLabel(companyId, {
      name: "urgent",
      color: "#ff0000",
      description: "Mark issues that need same-day attention",
    });
    expect(created.description).toBe("Mark issues that need same-day attention");

    const listed = await svc.listLabels(companyId);
    expect(listed[0]?.description).toBe("Mark issues that need same-day attention");
  });

  it("createLabel defaults description to null when not provided", async () => {
    await seedCompany();
    const created = await svc.createLabel(companyId, {
      name: "casual",
      color: "#00ff00",
    });
    expect(created.description).toBeNull();
  });

  it("updateLabel patches name, color, description independently", async () => {
    await seedCompany();
    const created = await svc.createLabel(companyId, {
      name: "old",
      color: "#000000",
      description: "old desc",
    });

    const renamed = await svc.updateLabel(created.id, { name: "new" });
    expect(renamed?.name).toBe("new");
    expect(renamed?.color).toBe("#000000");
    expect(renamed?.description).toBe("old desc");

    const recolored = await svc.updateLabel(created.id, { color: "#ffffff" });
    expect(recolored?.color).toBe("#ffffff");
    expect(recolored?.description).toBe("old desc");

    const redescribed = await svc.updateLabel(created.id, { description: "new desc" });
    expect(redescribed?.description).toBe("new desc");

    const cleared = await svc.updateLabel(created.id, { description: null });
    expect(cleared?.description).toBeNull();
  });

  it("updateLabel returns null for unknown id", async () => {
    await seedCompany();
    const result = await svc.updateLabel("00000000-0000-0000-0000-000000000000", { name: "x" });
    expect(result).toBeNull();
  });
});
