import { logger } from "../middleware/logger.js";

/**
 * Process-global heartbeat-scheduler leadership signal (DEE-700).
 *
 * DEE-699 gated the scheduler `setInterval` tick + startup recovery in
 * server/src/index.ts behind a pg_advisory_lock leader election. That alone is
 * necessary but not sufficient: run execution is ALSO dispatched inline from
 * HTTP request handlers (`heartbeat.wakeup` -> `enqueueWakeup` ->
 * `startNextQueuedRunForAgent` -> `executeRun`), which runs on whichever pod the
 * load balancer picked — not necessarily the leader.
 *
 * Each route registers its OWN `heartbeatService` instance
 * (issues / agents / approvals / issue-tree-control / routines / ...), so
 * leadership cannot be threaded through a single constructor — it is a
 * per-process fact. This module holds that per-process signal. `index.ts` sets
 * it once when leader election is enabled; every `heartbeatService` instance in
 * the process reads it to decide whether it may EXECUTE a run inline (leader) or
 * must only ENQUEUE it and signal the leader via NOTIFY (follower).
 *
 * Default is leader = true so single-replica deployments (election disabled)
 * keep exact pre-DEE-700 behavior: the one pod always executes inline.
 */

export type QueuedRunNotifier = (agentId: string) => void | Promise<void>;

let isLeaderFn: () => boolean = () => true;
let notifier: QueuedRunNotifier | null = null;

/**
 * Wire the per-process leadership signal. Called once from `index.ts` when
 * `schedulerLeaderElectionEnabled` is on.
 */
export function setSchedulerLeadership(opts: {
  isLeader: () => boolean;
  notifyQueuedRun?: QueuedRunNotifier | null;
}): void {
  isLeaderFn = opts.isLeader;
  notifier = opts.notifyQueuedRun ?? null;
}

/** Restore single-replica defaults (leader = true, no notifier). For tests/shutdown. */
export function resetSchedulerLeadership(): void {
  isLeaderFn = () => true;
  notifier = null;
}

/** Whether THIS process currently leads the heartbeat scheduler. */
export function isSchedulerLeader(): boolean {
  try {
    return isLeaderFn();
  } catch (err) {
    // A throwing predicate must never wedge dispatch. Fail closed to "follower"
    // so this pod never executes a run on leadership it cannot confirm; the real
    // leader's scheduler tick (which reads the election object directly) remains
    // the correctness backstop and will still drain the queue.
    logger.error({ err }, "scheduler leadership predicate threw; treating pod as follower");
    return false;
  }
}

/**
 * Signal the leader that a run was enqueued on this (follower) pod, so it drains
 * the queue immediately instead of waiting up to one scheduler interval. Best
 * effort: the leader's periodic `resumeQueuedRuns()` is the correctness backstop,
 * so a failed or absent notifier only costs latency.
 */
export async function notifyLeaderOfQueuedRun(agentId: string): Promise<void> {
  if (!notifier) return;
  try {
    await notifier(agentId);
  } catch (err) {
    logger.warn({ err, agentId }, "queued-run leader NOTIFY failed; leader tick will still drain");
  }
}
