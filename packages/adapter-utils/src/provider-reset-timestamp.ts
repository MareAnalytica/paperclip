// Generic provider reset-timestamp parser (ticket ELI-864).
//
// When a provider/harness reports a weekly / session / 5-hour / quota limit it
// usually also tells us *when* the window resets, in free-form human text such
// as:
//
//   weekly limit · resets Jun 7, 2am (UTC)
//   Usage limit reached. Resets at 3:15 AM (UTC).
//   You're out of extra usage · resets 4pm (America/Chicago)
//   try again at 11:31 PM (America/Chicago)
//   limit reached — available again 2026-06-07T02:00:00Z
//
// The cross-run cooldown circuit-breaker (provider_account_cooldowns) honours
// this reset instant instead of a short default back-off, so a new root run
// does not keep re-trying an exhausted provider until its real reset
// (ELI-855/ELI-864).
//
// This module is provider-agnostic on purpose: each adapter owns *detecting*
// that a failure is a limit (its own marker regexes), but the conversion of a
// reset phrase to a concrete `Date` is shared here so Claude, Codex, OpenCode,
// Grok, MiniMax-backed and future adapters parse identically and benefit from
// the same fixes. The functions are pure and `now`-injectable for testing.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// A bare ISO-8601 instant (with or without an explicit offset). Handled first
// so providers that already emit machine timestamps need no clock/date parsing.
const ISO_RE = /^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?$/i;

// "Jun 7", "June 7, 2026", "Jun. 7th" — month name + day + optional year.
const MONTH_DATE_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i;
// "6/7", "06/07/2026" — interpreted as month/day[/year] (US provider convention).
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

// "2am", "2:30 pm", "11:31 PM" (12-hour) and "14:00", "02:00" (24-hour).
const CLOCK_12_RE = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i;
const CLOCK_24_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

// Trailing timezone written in parentheses, e.g. "... 2am (UTC)".
const TRAILING_TZ_PAREN_RE = /\(([^)]+)\)\s*[.!]?\s*$/;
// Free-text reset phrase used by the generic scanner. Captures the reset clause
// (and an optional parenthesised timezone) following a limit-ish marker.
const RESET_PHRASE_RE =
  /\b(?:resets?|reset\s+at|try\s+again\s+(?:at|in)?|available\s+again(?:\s+at)?|retry\s+after|back\s+(?:on|at))\b\s*[:-]?\s*([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

/**
 * Resolve a timezone hint to a value `Intl` accepts, or null when it is not a
 * usable IANA / UTC zone. Note: bare abbreviations like "PST"/"EST" are not
 * IANA zones and resolve to null (same limitation as the prior per-adapter
 * parsers); "UTC"/"GMT" and full IANA names ("America/Chicago") are accepted.
 */
export function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Build the UTC instant for a wall-clock (year/month/day/hour/minute) in a given
 * IANA timezone. Returns null when the wall-clock does not exist in that zone
 * (e.g. an invalid calendar date, or a DST spring-forward gap).
 */
function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0),
  );
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

/** Local-time wall-clock instant, verifying the calendar date did not overflow. */
function dateFromLocalWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): Date | null {
  const candidate = new Date(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  if (
    candidate.getFullYear() !== input.year ||
    candidate.getMonth() !== input.month - 1 ||
    candidate.getDate() !== input.day
  ) {
    return null;
  }
  return candidate;
}

/** Clock-only reset: the next occurrence of hour:minute, rolling to tomorrow if already past. */
function nextClockTime(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZone: string | null;
}): Date | null {
  if (input.timeZone) {
    const nowParts = readTimeZoneParts(input.now, input.timeZone);
    let retryAt = dateFromTimeZoneWallClock({
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: input.hour,
      minute: input.minute,
      timeZone: input.timeZone,
    });
    if (!retryAt) return null;
    if (retryAt.getTime() <= input.now.getTime()) {
      const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
      retryAt = dateFromTimeZoneWallClock({
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
        hour: input.hour,
        minute: input.minute,
        timeZone: input.timeZone,
      });
    }
    return retryAt;
  }

  const retryAt = new Date(input.now);
  retryAt.setHours(input.hour, input.minute, 0, 0);
  if (retryAt.getTime() <= input.now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

/** Dated reset: a specific calendar day, choosing the next year when none is given. */
function datedClockTime(input: {
  now: Date;
  month: number;
  day: number;
  hour: number;
  minute: number;
  year: number | null;
  timeZone: string | null;
}): Date | null {
  const build = (year: number): Date | null =>
    input.timeZone
      ? dateFromTimeZoneWallClock({
          year,
          month: input.month,
          day: input.day,
          hour: input.hour,
          minute: input.minute,
          timeZone: input.timeZone,
        })
      : dateFromLocalWallClock({
          year,
          month: input.month,
          day: input.day,
          hour: input.hour,
          minute: input.minute,
        });

  if (input.year != null) return build(input.year);

  // No year given: anchor on `now`'s year (in the target zone) and bump forward
  // a year if that instant is already in the past — handles a Dec→Jan reset.
  const baseYear = input.timeZone ? readTimeZoneParts(input.now, input.timeZone).year : input.now.getFullYear();
  const candidate = build(baseYear);
  if (candidate && candidate.getTime() >= input.now.getTime()) return candidate;
  return build(baseYear + 1) ?? candidate;
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const m12 = text.match(CLOCK_12_RE);
  if (m12) {
    const hour12 = Number.parseInt(m12[1] ?? "", 10);
    const minute = Number.parseInt(m12[2] ?? "0", 10);
    if (Number.isInteger(hour12) && hour12 >= 1 && hour12 <= 12 && minute >= 0 && minute <= 59) {
      let hour24 = hour12 % 12;
      if ((m12[3] ?? "").toLowerCase() === "p") hour24 += 12;
      return { hour: hour24, minute };
    }
  }
  const m24 = text.match(CLOCK_24_RE);
  if (m24) {
    const hour = Number.parseInt(m24[1] ?? "", 10);
    const minute = Number.parseInt(m24[2] ?? "", 10);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }
  return null;
}

function parseDate(text: string): { month: number; day: number; year: number | null } | null {
  const named = text.match(MONTH_DATE_RE);
  if (named) {
    const month = MONTHS[(named[1] ?? "").slice(0, 3).toLowerCase()];
    const day = Number.parseInt(named[2] ?? "", 10);
    if (month && Number.isInteger(day) && day >= 1 && day <= 31) {
      const year = named[3] ? Number.parseInt(named[3], 10) : null;
      return { month, day, year };
    }
  }
  const numeric = text.match(NUMERIC_DATE_RE);
  if (numeric) {
    const month = Number.parseInt(numeric[1] ?? "", 10);
    const day = Number.parseInt(numeric[2] ?? "", 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year: number | null = numeric[3] ? Number.parseInt(numeric[3], 10) : null;
      if (year != null && year < 100) year += 2000;
      return { month, day, year };
    }
  }
  return null;
}

/**
 * Parse a provider reset clause (the text following "resets"/"try again at"/…)
 * into a concrete UTC instant. Handles, in order of preference:
 *  - bare ISO-8601 instants;
 *  - dated resets ("Jun 7, 2am", "June 7 2026 02:00", "6/7 2pm");
 *  - clock-only resets ("2am", "11:31 PM", "14:00"), rolling to tomorrow if past.
 *
 * `timeZoneHint` (e.g. a parenthesised "(UTC)" captured separately by an adapter)
 * takes precedence; otherwise a trailing "(...)" in the text is used. Returns
 * null when nothing parseable is present, so callers keep their default back-off.
 */
export function parseProviderResetTimestamp(
  rawText: string,
  now: Date = new Date(),
  timeZoneHint?: string | null,
): Date | null {
  const text = (rawText ?? "").trim();
  if (!text) return null;

  // 1. Machine timestamp.
  if (ISO_RE.test(text)) {
    const iso = new Date(text);
    return Number.isNaN(iso.getTime()) ? null : iso;
  }

  // 2. Resolve a timezone: explicit hint wins, else a trailing parenthesised zone.
  let tzRaw = timeZoneHint?.trim() || null;
  let body = text;
  const paren = text.match(TRAILING_TZ_PAREN_RE);
  if (paren) {
    body = text.slice(0, paren.index).trim();
    if (!tzRaw) tzRaw = paren[1] ?? null;
  }
  const timeZone = normalizeResetTimeZone(tzRaw);

  // 3. Parse the clock and (optional) date out of the remaining text.
  const clock = parseClock(body);
  const date = parseDate(body);
  if (!clock && !date) return null;

  const hour = clock?.hour ?? 0;
  const minute = clock?.minute ?? 0;

  if (date) {
    return datedClockTime({ now, month: date.month, day: date.day, hour, minute, year: date.year, timeZone });
  }
  return nextClockTime({ now, hour, minute, timeZone });
}

/**
 * Generic limit-reset scanner for any provider's free-text error output. Finds a
 * "resets / try again at / available again …" phrase and converts it to an
 * instant via {@link parseProviderResetTimestamp}. Adapters that surface a
 * structured reset string should call {@link parseProviderResetTimestamp}
 * directly; this is the fallback for unstructured provider messages.
 */
export function extractProviderResetTimestamp(text: string | null | undefined, now: Date = new Date()): Date | null {
  const haystack = (text ?? "").replace(/\r\n/g, "\n");
  if (!haystack.trim()) return null;
  const match = haystack.match(RESET_PHRASE_RE);
  if (!match) return null;
  return parseProviderResetTimestamp(match[1] ?? "", now, match[2]);
}
