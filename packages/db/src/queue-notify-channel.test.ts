import { afterEach, describe, expect, it } from "vitest";
import { createQueueNotifyChannel } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queue-notify-channel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-queue-notify-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function waitFor(fn: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return fn();
}

describeEmbeddedPostgres("createQueueNotifyChannel (DEE-700 LISTEN/NOTIFY)", () => {
  it("delivers a NOTIFY payload across a separate connection to a LISTEN handler", async () => {
    const connectionString = await createTempDatabase();
    const listener = createQueueNotifyChannel(connectionString, "heartbeat_run_queued");
    const sender = createQueueNotifyChannel(connectionString, "heartbeat_run_queued");
    const received: string[] = [];
    try {
      await listener.listen((payload) => received.push(payload));
      // A different pod (separate connection) enqueues and signals the leader.
      await sender.notify("agent-123");

      const got = await waitFor(() => received.includes("agent-123"));
      expect(got).toBe(true);
      expect(received).toEqual(["agent-123"]);
    } finally {
      await listener.end();
      await sender.end();
    }
  });

  it("ping resolves on a live connection and rejects after end()", async () => {
    const connectionString = await createTempDatabase();
    const channel = createQueueNotifyChannel(connectionString, "heartbeat_run_queued");
    await expect(channel.ping()).resolves.toBeUndefined();
    await channel.end();
    await expect(channel.ping()).rejects.toBeDefined();
  });

  it("rejects an unsafe channel identifier", () => {
    expect(() => createQueueNotifyChannel("postgres://unused", "bad channel; DROP")).toThrow(
      /Unsafe NOTIFY channel/,
    );
  });
});
