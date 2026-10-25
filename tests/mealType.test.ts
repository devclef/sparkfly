import { describe, expect, it } from 'vitest';
import { autoMealType, parseRange, rangeContains, toLocalParts } from '../src/rules/mealType.js';
import { DEFAULT_MEAL_TYPE_AUTO } from '../src/rules/types.js';

const RANGES = { ...DEFAULT_MEAL_TYPE_AUTO };

const at = (s: string) => toLocalParts(new Date(s), 'UTC');

describe('autoMealType (UTC, default ranges)', () => {
  it.each([
    ['2026-10-25T04:00:00Z', 'breakfast'],
    ['2026-10-25T10:59:00Z', 'breakfast'],
    ['2026-10-25T11:00:00Z', 'lunch'],
    ['2026-10-25T15:59:00Z', 'lunch'],
    ['2026-10-25T16:00:00Z', 'snacks'],
    ['2026-10-25T17:29:00Z', 'snacks'],
    ['2026-10-25T17:30:00Z', 'dinner'],
    // midnight belongs to the wrapping dinner range
    ['2026-10-25T00:00:00Z', 'dinner'],
    ['2026-10-25T03:59:00Z', 'dinner'],
  ])('%s → %s', (date, expected) => {
    expect(autoMealType(at(date), RANGES)).toBe(expected);
  });
});

describe('parseRange / rangeContains', () => {
  it('parses minutes', () => {
    expect(parseRange('11:00-15:59')).toEqual({ from: 660, to: 959 });
  });
  it('is inclusive on both ends', () => {
    const r = parseRange('11:00-15:59');
    expect(rangeContains(r, 660)).toBe(true);
    expect(rangeContains(r, 959)).toBe(true);
    expect(rangeContains(r, 659)).toBe(false);
    expect(rangeContains(r, 960)).toBe(false);
  });
  it('wraps midnight', () => {
    const r = parseRange('17:30-03:59');
    expect(rangeContains(r, 17 * 60 + 30)).toBe(true);
    expect(rangeContains(r, 0)).toBe(true);
    expect(rangeContains(r, 3 * 60 + 59)).toBe(true);
    expect(rangeContains(r, 4 * 60)).toBe(false);
    expect(rangeContains(r, 12 * 60)).toBe(false);
  });
  it('rejects garbage', () => {
    expect(() => parseRange('25:00-10:00')).toThrow();
    expect(() => parseRange('noon')).toThrow();
  });
});

describe('toLocalParts', () => {
  it('converts to the requested zone', () => {
    // 2026-10-20 is a plain CEST Tuesday (2026-10-25 is the EU DST-end date)
    const p = toLocalParts(new Date('2026-10-20T12:41:00Z'), 'Europe/Berlin');
    expect(p).toMatchObject({ year: 2026, month: 10, day: 20, hour: 14, minute: 41, weekday: 2 }); // Tuesday, UTC+2
  });
  it('handles negative offsets', () => {
    const p = toLocalParts(new Date('2026-10-25T12:41:00-05:00'), 'UTC');
    expect(p).toMatchObject({ hour: 17, minute: 41 });
  });
});
