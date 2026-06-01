import { readFileSync } from "node:fs";

// Skew tolerance when comparing a recorded child start against an observed
// process start. Absorbs `/proc/stat` btime second-truncation plus scheduling
// and measurement noise.
export const PROCESS_IDENTITY_SKEW_TOLERANCE_MS = 30 * 1000;

// Liveness probe. On Linux PIDs are recycled, so this is a best-effort signal
// rather than proof that the original child is still alive. EPERM means a
// process exists but is not ours -> still counts as alive.
export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

// Wall-clock time (ms) at which THIS control-plane process started. Any agent
// child we genuinely spawned was forked during our lifetime, so its recorded
// start cannot predate this. Used as a boot-epoch gate: a run whose recorded
// child start predates our boot belonged to a previous pod incarnation, so a
// still-"alive" PID at that number must have been reused (DEE-660).
export function selfProcessStartWallMs(): number {
  return Date.now() - process.uptime() * 1000;
}

export function readBootTimeSeconds(): number | null {
  try {
    const stat = readFileSync("/proc/stat", "utf8");
    const match = stat.match(/^btime\s+(\d+)/m);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

// /proc/<pid>/stat field 22 (1-indexed) is starttime in clock ticks since boot.
// The process name (field 2) may contain spaces/parens, so parse from the last
// ")" rather than naive whitespace splitting.
export function readProcStartTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = stat.lastIndexOf(")");
    if (rparen < 0) return null;
    const rest = stat.slice(rparen + 2).trim().split(/\s+/);
    // After "(comm)" the remaining fields start at field 3 (state). starttime is
    // field 22, i.e. index 19 of this post-comm slice.
    const ticks = rest[19];
    if (ticks == null) return null;
    const parsed = Number.parseInt(ticks, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Real Linux kernels expose CLK_TCK as one of a tiny set of values (almost
// always 100). We cannot read sysconf(_SC_CLK_TCK) without a native binding, so
// we derive the rate from our own /proc start ticks anchored to our known
// wall-clock start. DEE-662 H1: that derivation is noisy at small process
// self-age (btime is truncated to whole seconds), so a raw ratio must NOT be
// trusted verbatim — a ~10% error scales the absolute start time by hours on a
// long-uptime host and would false-finalize a genuinely-alive child. We instead
// snap the derived ratio onto the nearest canonical value only when it is close
// enough, and otherwise refuse to resolve (return null) so the /proc start-time
// gate is skipped in favour of the bounded detached horizon.
const CANONICAL_CLOCK_TICKS = [100, 250, 1000] as const;
const CLOCK_TICK_REL_TOLERANCE = 0.1;

// Snap a raw derived ticks/sec onto a canonical CLK_TCK, or null when it is too
// far from any canonical value to trust. Pure + exported for unit testing.
export function snapToCanonicalClockTicks(rawTicksPerSec: number): number | null {
  if (!Number.isFinite(rawTicksPerSec) || rawTicksPerSec <= 0) return null;
  for (const canonical of CANONICAL_CLOCK_TICKS) {
    if (Math.abs(rawTicksPerSec - canonical) / canonical <= CLOCK_TICK_REL_TOLERANCE) {
      return canonical;
    }
  }
  return null;
}

let cachedClockTicksPerSecond: number | null = null;

function resolveClockTicksPerSecond(): number | null {
  const selfTicks = readProcStartTicks(process.pid);
  const btime = readBootTimeSeconds();
  if (selfTicks == null || btime == null) return null;
  const elapsedSec = selfProcessStartWallMs() / 1000 - btime;
  if (!(elapsedSec > 0)) return null;
  return snapToCanonicalClockTicks(selfTicks / elapsedSec);
}

// Resolved CLK_TCK (one of the canonical values) or null when the runtime
// derivation is too noisy to trust. Only a confident canonical result is
// cached, so a noisy startup call (reapOrphanedRuns runs at boot) does not
// poison later, larger-self-age derivations.
export function clockTicksPerSecond(): number | null {
  if (cachedClockTicksPerSecond != null) return cachedClockTicksPerSecond;
  const resolved = resolveClockTicksPerSecond();
  if (resolved != null) cachedClockTicksPerSecond = resolved;
  return resolved;
}

// Wall-clock start (ms) of the live process currently at `pid`, or null if it
// cannot be determined (non-Linux, procfs unreadable, CLK_TCK unresolved, race).
export function procStartWallMs(pid: number): number | null {
  const ticks = readProcStartTicks(pid);
  const btime = readBootTimeSeconds();
  const ticksPerSec = clockTicksPerSecond();
  if (ticks == null || btime == null || ticksPerSec == null) return null;
  return (btime + ticks / ticksPerSec) * 1000;
}

// Decide whether the PID recorded for an orphaned run is plausibly STILL the
// original agent child, as opposed to a reused PID now held by an unrelated
// process. Bare liveness (`isProcessAlive`) is insufficient on Linux because
// low PIDs are recycled after a pod restart (DEE-660: pid 58 -> esbuild helper).
// Returns false (treat as gone -> finalize) when the PID is dead OR when its
// observed start time post-dates the recorded child start, via two independent
// signals:
//   1. boot-epoch gate  — recorded child predates this process incarnation
//   2. /proc start-time — live PID started after we recorded the child
// When the recorded start is unknown or procfs is unreadable, identity is
// inconclusive and we conservatively report alive; the bounded detached horizon
// in reapOrphanedRuns guarantees forward progress in that case.
export function isRecordedChildAlive(
  pid: number | null | undefined,
  recordedStartedAt: Date | string | null | undefined,
  deps: {
    isAlive?: (pid: number) => boolean;
    selfStartMs?: () => number;
    procStartMs?: (pid: number) => number | null;
    toleranceMs?: number;
  } = {},
): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  const isAlive = deps.isAlive ?? isProcessAlive;
  if (!isAlive(pid)) return false;

  const recordedMs =
    recordedStartedAt == null ? NaN : new Date(recordedStartedAt).getTime();
  if (!Number.isFinite(recordedMs)) return true; // no recorded start -> cannot judge identity

  const tolerance = deps.toleranceMs ?? PROCESS_IDENTITY_SKEW_TOLERANCE_MS;

  // (1) Boot-epoch gate: the recorded child cannot belong to this incarnation.
  const selfStartMs = (deps.selfStartMs ?? selfProcessStartWallMs)();
  if (Number.isFinite(selfStartMs) && recordedMs < selfStartMs - tolerance) {
    return false;
  }

  // (2) /proc start-time gate: live PID started after we recorded the child.
  const observedStartMs = (deps.procStartMs ?? procStartWallMs)(pid);
  if (observedStartMs != null && observedStartMs > recordedMs + tolerance) {
    return false;
  }

  return true;
}

// Boot-epoch reuse guard for process *termination* (signalling). The reaper and
// recovery already clean up orphaned PIDs/process-groups aggressively, including
// descendant-only groups whose leader has exited and runs with no recorded
// start. The one situation where that is dangerous is PID/PGID *recycling across
// a pod restart* (DEE-660: pid/pgid 58 -> esbuild) — and that case is precisely
// identified by the recorded child start predating this process's boot. So we
// suppress signalling ONLY when we can positively prove the recorded metadata
// belongs to a prior incarnation; every other case (recent start, or no recorded
// start at all) preserves the existing best-effort cleanup behavior.
//
// Returns true ONLY when there is affirmative evidence the recorded child started
// before this process booted. Inconclusive inputs (missing recorded/self start)
// return false so existing cleanup is preserved.
//
// NOTE (deliberate scope): this does not defend against PID/PGID reuse WITHIN a
// single long-running process incarnation (a leader exits and its number is
// later reused before the stale run is reaped). Fully guarding that would require
// rejecting descendant-only groups with a dead leader, which regresses the
// intended orphaned-descendant-group cleanup (covered by an existing test that
// seeds no processStartedAt). The pod-restart class above is the observed DEE-660
// failure mode; this guard is strictly safer than the prior unconditional kill.
export function isRecordedFromPriorBootEpoch(
  recordedStartedAt: Date | string | null | undefined,
  deps: { selfStartMs?: () => number; toleranceMs?: number } = {},
): boolean {
  const recordedMs =
    recordedStartedAt == null ? NaN : new Date(recordedStartedAt).getTime();
  if (!Number.isFinite(recordedMs)) return false;
  const selfStartMs = (deps.selfStartMs ?? selfProcessStartWallMs)();
  if (!Number.isFinite(selfStartMs)) return false;
  const tolerance = deps.toleranceMs ?? PROCESS_IDENTITY_SKEW_TOLERANCE_MS;
  return recordedMs < selfStartMs - tolerance;
}

// Whether a recorded process GROUP may be signalled (SIGTERM/SIGKILL) during
// orphan cleanup. Process-group cleanup is intentionally best-effort (it reaps
// leaked descendants), but it must never signal a recycled PGID. Two reuse
// classes are guarded:
//   - prior-boot reuse (pod restart): rejected via the boot-epoch gate.
//   - same-incarnation leader-PID reuse: when the group LEADER pid is alive it
//     may be a recycled PID (commonly processGroupId === processPid), so we
//     require it to pass full /proc identity. When the leader pid is already
//     dead, a still-alive group is a legitimate descendant-only set from this
//     incarnation and cleanup is allowed (matches the long-standing orphaned-
//     descendant-group behavior; a dead leader cannot be a freshly-recycled
//     live process).
export function isRecordedGroupTerminable(
  processGroupId: number | null | undefined,
  recordedStartedAt: Date | string | null | undefined,
  deps: {
    isAlive?: (pid: number) => boolean;
    selfStartMs?: () => number;
    procStartMs?: (pid: number) => number | null;
    toleranceMs?: number;
  } = {},
): boolean {
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return false;
  }
  if (isRecordedFromPriorBootEpoch(recordedStartedAt, deps)) return false;
  const isAlive = deps.isAlive ?? isProcessAlive;
  if (isAlive(processGroupId) && !isRecordedChildAlive(processGroupId, recordedStartedAt, deps)) {
    return false;
  }
  return true;
}
