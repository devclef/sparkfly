import type { MealTypeAutoSpec } from './types.js';

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Convert an absolute Date into wall-clock parts in the given IANA zone.
 * Firefly sends ISO dates with an offset; everything Sparkfly writes to
 * SparkyFitness (entry_date, entry_time, weekday/time filters, auto meal
 * type) is decided in this local zone.
 */
export function toLocalParts(date: Date, timeZone: string): LocalParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = WEEKDAY_MAP[get('weekday') ?? ''] ?? 0;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday,
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function formatDateFromParts(p: LocalParts): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatTimeFromParts(p: LocalParts): string {
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export interface MinuteRange {
  from: number;
  to: number;
}

/** Parse "HH:MM-HH:MM" into minutes-since-midnight. Throws on bad input. */
export function parseRange(spec: string): MinuteRange {
  const m = spec.match(/^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new Error(`invalid time range "${spec}" (expected "HH:MM-HH:MM")`);
  return { from: Number(m[1]) * 60 + Number(m[2]), to: Number(m[3]) * 60 + Number(m[4]) };
}

/** Inclusive on both ends; wraps midnight when from > to (e.g. 17:30-03:59). */
export function rangeContains(range: MinuteRange, minutes: number): boolean {
  const { from, to } = range;
  if (from <= to) return minutes >= from && minutes <= to;
  return minutes >= from || minutes <= to;
}

const AUTO_ORDER = ['breakfast', 'lunch', 'snacks', 'dinner'] as const;

/**
 * Pick a meal type from the local time of day using the configured ranges.
 * Falls back to "dinner" when the ranges have a gap that covers the time
 * (only possible with user-customised ranges; the defaults are gap-free and
 * the dinner range wraps midnight, so 00:00 → dinner).
 */
export function autoMealType(parts: LocalParts, spec: MealTypeAutoSpec): string {
  const minutes = parts.hour * 60 + parts.minute;
  for (const name of AUTO_ORDER) {
    if (rangeContains(parseRange(spec[name]), minutes)) return name;
  }
  return 'dinner';
}
