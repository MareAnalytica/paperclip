import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "/home/brandonc/repo/paperclip/server/src/middleware/auth.ts";
import { getActorInfo } from "/home/brandonc/repo/paperclip/server/src/routes/authz.ts";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

describe("DEE-707 run id hygiene", () => {
  it("actor middleware should not preserve non-uuid board run ids from headers", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-run-id", "6fa7e0a4-6bcc-4ab4-a1ac-ece1548d3f15-suffix");

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeUndefined();
  });

  it("getActorInfo should drop invalid board run ids", () => {
    const req = {
      actor: {
        type: "board",
        userId: "user-1",
        source: "board_key",
        runId: "cb4872c6-10ac-49c4-8397-ed873d07eccc-extra",
      },
    } as any;

    expect(getActorInfo(req)).toEqual({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
    });
  });

  it("getActorInfo should preserve valid uuid board run ids", () => {
    const req = {
      actor: {
        type: "board",
        userId: "user-1",
        source: "board_key",
        runId: "35ee0e2c-ebae-46a2-b36c-03223d030a72",
      },
    } as any;

    expect(getActorInfo(req)).toEqual({
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: "35ee0e2c-ebae-46a2-b36c-03223d030a72",
    });
  });
});
