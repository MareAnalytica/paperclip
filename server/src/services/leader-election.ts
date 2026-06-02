import { createAdvisoryLockSession, type AdvisoryLockSession } from "@paperclipai/db";

/**
 * Scheduler singleton guard via PostgreSQL session-scoped advisory locks
 * (DEE-699). Lets paperclip run with replicas>1 safely: every pod keeps serving
 * HTTP + /api/health, but exactly one pod (the "leader") runs the heartbeat
 * scheduler — timers, reconcilers, orphan reaping, and dispatch.
 *
 * Why an advisory lock and not per-path idempotency: the scheduler seam in
 * server/src/index.ts wraps every non-issue/reconciler side-effect (the CEO
 * heartbeat timer fires through the non-transactional `tickTimers` enqueue
 * path). Gating that one seam by a single-leader guard makes the whole class
 * safe with one change, instead of having to prove each present and future
 * reconciler path idempotent.
 *
 * Failover semantics:
 *  - The lock is held on a DEDICATED connection (postgres `max: 1`). A pooled
 *    connection is wrong here: `pg_advisory_lock` is bound to the physical
 *    backend session, and the connection must stay checked out for the lock's
 *    whole lifetime.
 *  - Graceful shutdown (rolling restart — the common case) calls stop(), which
 *    releases the lock immediately so the survivor is promoted on its next poll.
 *  - Hard crash: the session-scoped lock auto-releases when Postgres detects the
 *    dead backend (TCP keepalive), after which a survivor acquires on its next
 *    poll. Failover time is therefore bounded by the poll interval plus
 *    Postgres' dead-connection detection.
 */

/** The lock primitive this manager drives; backed by a dedicated DB connection. */
export type LeaderLockClient = AdvisoryLockSession;

export interface LeaderElectionLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface LeaderElectionOptions {
  connectionString: string;
  classId: number;
  objId: number;
  pollIntervalMs: number;
  logger: LeaderElectionLogger;
  /** Fired once on each follower→leader transition. */
  onAcquire?: () => void;
  /** Fired once on each leader→follower transition (e.g. connection loss). */
  onLose?: () => void;
  /** Injectable for tests; defaults to a dedicated single-connection postgres client. */
  createClient?: (connectionString: string) => LeaderLockClient;
  /** Injectable scheduler; defaults to setInterval/clearInterval. */
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface SchedulerLeaderElection {
  start(): void;
  stop(): Promise<void>;
  isLeader(): boolean;
  /** Run a single election poll now (exposed for tests/deterministic ticks). */
  poll(): Promise<void>;
}

export function createSchedulerLeaderElection(
  options: LeaderElectionOptions,
): SchedulerLeaderElection {
  const {
    connectionString,
    classId,
    objId,
    pollIntervalMs,
    logger,
    onAcquire,
    onLose,
    createClient = createAdvisoryLockSession,
    setInterval: setIntervalFn = setInterval,
    clearInterval: clearIntervalFn = clearInterval,
  } = options;

  let leader = false;
  let client: LeaderLockClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;
  let stopped = false;

  async function destroyClient(): Promise<void> {
    const current = client;
    client = null;
    if (!current) return;
    try {
      await current.end();
    } catch (err) {
      logger.warn({ err }, "scheduler leader-election: failed to close lock connection");
    }
  }

  function demote(reason: string): void {
    if (!leader) return;
    leader = false;
    logger.warn({ reason, classId, objId }, "scheduler leader-election: lost leadership");
    try {
      onLose?.();
    } catch (err) {
      logger.error({ err }, "scheduler leader-election: onLose handler threw");
    }
  }

  async function poll(): Promise<void> {
    if (stopped || polling) return;
    polling = true;
    try {
      if (leader) {
        // Confirm we still hold a live connection (and therefore the lock).
        try {
          await client!.ping();
        } catch (err) {
          demote("connection_lost");
          await destroyClient();
        }
        return;
      }

      if (!client) {
        try {
          client = createClient(connectionString);
        } catch (err) {
          logger.error({ err }, "scheduler leader-election: failed to open lock connection");
          client = null;
          return;
        }
      }

      let acquired = false;
      try {
        acquired = await client.tryAcquire(classId, objId);
      } catch (err) {
        logger.warn({ err }, "scheduler leader-election: acquire attempt failed");
        await destroyClient();
        return;
      }

      if (acquired) {
        leader = true;
        logger.info({ classId, objId }, "scheduler leader-election: acquired leadership");
        try {
          onAcquire?.();
        } catch (err) {
          logger.error({ err }, "scheduler leader-election: onAcquire handler threw");
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      stopped = false;
      // Attempt immediately so a fresh single-leader deployment is promoted
      // without waiting a full poll interval, then keep polling.
      void poll();
      timer = setIntervalFn(() => {
        void poll();
      }, pollIntervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearIntervalFn(timer);
        timer = null;
      }
      // Release the lock explicitly on graceful shutdown for fast failover.
      if (client && leader) {
        try {
          await client.release(classId, objId);
        } catch (err) {
          logger.warn({ err }, "scheduler leader-election: failed to release lock on stop");
        }
      }
      demote("stopped");
      await destroyClient();
    },
    isLeader() {
      return leader;
    },
    poll,
  };
}
