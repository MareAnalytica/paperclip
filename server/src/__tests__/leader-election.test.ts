import { describe, expect, it, vi } from "vitest";
import {
  createSchedulerLeaderElection,
  type LeaderLockClient,
} from "../services/leader-election.js";

const CLASS_ID = 0x70636c70;
const OBJ_ID = 0x73636864;

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * A shared advisory-lock simulator: exactly one client can hold (classId,objId)
 * at a time, mirroring pg_try_advisory_lock semantics across sessions.
 */
function createSharedLock() {
  let holder: symbol | null = null;
  return {
    isHeld: () => holder !== null,
    tryAcquire(session: symbol): boolean {
      if (holder === null) {
        holder = session;
        return true;
      }
      return holder === session; // re-entrant for the same session
    },
    release(session: symbol): void {
      if (holder === session) holder = null;
    },
  };
}

interface FakeClientControls {
  client: LeaderLockClient;
  failPing: () => void;
  failAcquire: () => void;
  endCalls: () => number;
  drop: () => void; // simulate connection death (releases the lock like a dropped session)
}

function makeFakeClient(
  shared: ReturnType<typeof createSharedLock>,
): FakeClientControls {
  const session = Symbol("session");
  let pingFails = false;
  let acquireFails = false;
  let alive = true;
  let ends = 0;
  const client: LeaderLockClient = {
    async tryAcquire(classId, objId) {
      if (!alive) throw new Error("connection closed");
      if (acquireFails) throw new Error("acquire boom");
      expect(classId).toBe(CLASS_ID);
      expect(objId).toBe(OBJ_ID);
      return shared.tryAcquire(session);
    },
    async release() {
      shared.release(session);
    },
    async ping() {
      if (!alive || pingFails) throw new Error("connection lost");
    },
    async end() {
      ends += 1;
      alive = false;
      shared.release(session);
    },
  };
  return {
    client,
    failPing: () => {
      pingFails = true;
    },
    failAcquire: () => {
      acquireFails = true;
    },
    endCalls: () => ends,
    drop: () => {
      alive = false;
      shared.release(session);
    },
  };
}

const noopScheduler = {
  setInterval: (_handler: () => void, _ms: number) =>
    0 as unknown as ReturnType<typeof setInterval>,
  clearInterval: (_handle: ReturnType<typeof setInterval>) => {},
};

describe("createSchedulerLeaderElection", () => {
  it("acquires leadership when the lock is free and fires onAcquire exactly once", async () => {
    const shared = createSharedLock();
    const fake = makeFakeClient(shared);
    const onAcquire = vi.fn();

    const election = createSchedulerLeaderElection({
      connectionString: "postgres://test",
      classId: CLASS_ID,
      objId: OBJ_ID,
      pollIntervalMs: 1000,
      logger: silentLogger,
      onAcquire,
      createClient: () => fake.client,
      ...noopScheduler,
    });

    expect(election.isLeader()).toBe(false);
    await election.poll();
    expect(election.isLeader()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);

    // Subsequent polls while leader must not re-acquire or re-fire onAcquire.
    await election.poll();
    await election.poll();
    expect(onAcquire).toHaveBeenCalledTimes(1);
    expect(election.isLeader()).toBe(true);
  });

  it("only one of two instances becomes leader; the survivor takes over after release", async () => {
    const shared = createSharedLock();
    const a = makeFakeClient(shared);
    const b = makeFakeClient(shared);
    const onLoseA = vi.fn();

    const electionA = createSchedulerLeaderElection({
      connectionString: "postgres://test",
      classId: CLASS_ID,
      objId: OBJ_ID,
      pollIntervalMs: 1000,
      logger: silentLogger,
      onLose: onLoseA,
      createClient: () => a.client,
      ...noopScheduler,
    });
    const electionB = createSchedulerLeaderElection({
      connectionString: "postgres://test",
      classId: CLASS_ID,
      objId: OBJ_ID,
      pollIntervalMs: 1000,
      logger: silentLogger,
      createClient: () => b.client,
      ...noopScheduler,
    });

    await electionA.poll();
    await electionB.poll();
    expect(electionA.isLeader()).toBe(true);
    expect(electionB.isLeader()).toBe(false);

    // Leader A shuts down gracefully → releases the lock.
    await electionA.stop();
    expect(onLoseA).toHaveBeenCalledTimes(1);
    expect(shared.isHeld()).toBe(false);

    // B acquires on its next poll.
    await electionB.poll();
    expect(electionB.isLeader()).toBe(true);
  });

  it("demotes and fires onLose when the lock connection is lost, then re-acquires", async () => {
    const shared = createSharedLock();
    let created = 0;
    const clients: FakeClientControls[] = [];
    const onLose = vi.fn();
    const onAcquire = vi.fn();

    const election = createSchedulerLeaderElection({
      connectionString: "postgres://test",
      classId: CLASS_ID,
      objId: OBJ_ID,
      pollIntervalMs: 1000,
      logger: silentLogger,
      onAcquire,
      onLose,
      createClient: () => {
        const fake = makeFakeClient(shared);
        clients.push(fake);
        created += 1;
        return fake.client;
      },
      ...noopScheduler,
    });

    await election.poll();
    expect(election.isLeader()).toBe(true);
    expect(created).toBe(1);

    // Connection dies: ping fails -> demote on next poll.
    clients[0].drop();
    await election.poll();
    expect(election.isLeader()).toBe(false);
    expect(onLose).toHaveBeenCalledTimes(1);

    // A fresh client is created and leadership re-acquired on the following poll.
    await election.poll();
    expect(election.isLeader()).toBe(true);
    expect(created).toBe(2);
    expect(onAcquire).toHaveBeenCalledTimes(2);
  });

  it("stays a follower and recycles the client when an acquire attempt throws", async () => {
    const shared = createSharedLock();
    const fake = makeFakeClient(shared);
    fake.failAcquire();
    const onAcquire = vi.fn();

    const election = createSchedulerLeaderElection({
      connectionString: "postgres://test",
      classId: CLASS_ID,
      objId: OBJ_ID,
      pollIntervalMs: 1000,
      logger: silentLogger,
      onAcquire,
      createClient: () => fake.client,
      ...noopScheduler,
    });

    await election.poll();
    expect(election.isLeader()).toBe(false);
    expect(onAcquire).not.toHaveBeenCalled();
    expect(fake.endCalls()).toBe(1); // bad client torn down for retry
  });

  it("stop() releases the lock and tears down the connection", async () => {
    const shared = createSharedLock();
    const fake = makeFakeClient(shared);

    const election = createSchedulerLeaderElection({
      connectionString: "postgres://test",
      classId: CLASS_ID,
      objId: OBJ_ID,
      pollIntervalMs: 1000,
      logger: silentLogger,
      createClient: () => fake.client,
      ...noopScheduler,
    });

    await election.poll();
    expect(election.isLeader()).toBe(true);
    expect(shared.isHeld()).toBe(true);

    await election.stop();
    expect(election.isLeader()).toBe(false);
    expect(shared.isHeld()).toBe(false);
    expect(fake.endCalls()).toBe(1);

    // After stop, polls are inert (no resurrection).
    await election.poll();
    expect(election.isLeader()).toBe(false);
  });
});
