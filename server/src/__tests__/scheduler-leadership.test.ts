import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSchedulerLeader,
  notifyLeaderOfQueuedRun,
  resetSchedulerLeadership,
  setSchedulerLeadership,
} from "../services/scheduler-leadership.js";

describe("scheduler-leadership process-global signal (DEE-700)", () => {
  afterEach(() => {
    resetSchedulerLeadership();
    vi.restoreAllMocks();
  });

  it("defaults to leader=true so single-replica behavior is unchanged", () => {
    // No setSchedulerLeadership() call == leader election disabled.
    expect(isSchedulerLeader()).toBe(true);
  });

  it("reflects the wired predicate (follower vs leader)", () => {
    let leader = false;
    setSchedulerLeadership({ isLeader: () => leader });
    expect(isSchedulerLeader()).toBe(false);
    leader = true;
    expect(isSchedulerLeader()).toBe(true);
  });

  it("fails closed to follower if the predicate throws (never execute on unconfirmed leadership)", () => {
    setSchedulerLeadership({
      isLeader: () => {
        throw new Error("election connection lost");
      },
    });
    expect(isSchedulerLeader()).toBe(false);
  });

  it("resetSchedulerLeadership restores the leader=true default and clears the notifier", async () => {
    const notifier = vi.fn();
    setSchedulerLeadership({ isLeader: () => false, notifyQueuedRun: notifier });
    resetSchedulerLeadership();
    expect(isSchedulerLeader()).toBe(true);
    await notifyLeaderOfQueuedRun("agent-1");
    expect(notifier).not.toHaveBeenCalled();
  });

  it("notifyLeaderOfQueuedRun forwards the agent id to the wired notifier", async () => {
    const notifier = vi.fn().mockResolvedValue(undefined);
    setSchedulerLeadership({ isLeader: () => false, notifyQueuedRun: notifier });
    await notifyLeaderOfQueuedRun("agent-42");
    expect(notifier).toHaveBeenCalledExactlyOnceWith("agent-42");
  });

  it("notifyLeaderOfQueuedRun is a no-op when no notifier is wired", async () => {
    setSchedulerLeadership({ isLeader: () => false });
    await expect(notifyLeaderOfQueuedRun("agent-1")).resolves.toBeUndefined();
  });

  it("swallows notifier failures (NOTIFY is a latency optimization, the leader tick is the backstop)", async () => {
    const notifier = vi.fn().mockRejectedValue(new Error("notify connection dropped"));
    setSchedulerLeadership({ isLeader: () => true, notifyQueuedRun: notifier });
    await expect(notifyLeaderOfQueuedRun("agent-1")).resolves.toBeUndefined();
    expect(notifier).toHaveBeenCalledOnce();
  });
});
