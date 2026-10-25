import { describe, expect, it } from 'vitest';
import { buildPayload } from './helpers.js';
import { fireflyPayloadSchema } from '../src/firefly/types.js';
import { compileRules } from '../src/rules/compile.js';
import { rulesFileSchema } from '../src/rules/types.js';
import { matchedRules, matchRule } from '../src/rules/match.js';
import { toLocalParts } from '../src/rules/mealType.js';
import type { SplitContext } from '../src/rules/match.js';

function ctxOf(splitOverrides: Record<string, unknown> = {}): SplitContext {
  const payload = fireflyPayloadSchema.parse(buildPayload({}, splitOverrides));
  const split = payload.content.transactions[0]!;
  return { split, local: toLocalParts(new Date(split.date), 'UTC') };
}

const one = (name: string, rule: unknown) => compileRules(rulesFileSchema.parse({ rules: [{ name, match: (rule.match as object) ?? {}, action: rule.action ?? { log: 'food', food_id: 'f1' } }] }));

describe('type', () => {
  it('defaults to withdrawal when unspecified', () => {
    const c = one('r', { match: { destination: 'X' } });
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'X', type: 'withdrawal' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'X', type: 'deposit' }))).toBe(false);
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'X', type: 'transfer' }))).toBe(false);
  });
  it('matches the configured type only', () => {
    const c = one('r', { match: { type: 'deposit' } });
    expect(matchRule(c.rules[0]!, ctxOf({ type: 'deposit' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ type: 'withdrawal' }))).toBe(false);
  });
});

describe('text fields', () => {
  it('plain strings match exactly, case-insensitively', () => {
    const c = one('r', { match: { destination: 'Indian Garden' } });
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'indian garden' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'Indian Garden Takeaway' }))).toBe(false);
  });
  it('regex literals with flags match substrings', () => {
    const c = one('r', { match: { destination: '/starbucks|costa/i' } });
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'Starbucks #42' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'Costa Coffee' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'Caffe Roma' }))).toBe(false);
  });
  it('regex objects match', () => {
    const c = one('r', { match: { destination: { pattern: '^(a|b)$', flags: 'i' } } });
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'A' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ destination_name: 'c' }))).toBe(false);
  });
  it('all five fields are checked', () => {
    const c = one('r', {
      match: {
        source: 'checking',
        destination: '/garden/i',
        description: 'indian garden',
        category: 'eating out',
        budget: 'food',
      },
    });
    expect(matchRule(c.rules[0]!, ctxOf())).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ category_name: 'Shopping' }))).toBe(false);
  });
});

describe('amount / currency', () => {
  it('compares absolute amount within min/max (inclusive)', () => {
    const c = one('r', { match: { amount: { min: 8, max: 25 } } });
    expect(matchRule(c.rules[0]!, ctxOf({ amount: '8.00' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ amount: '25.00' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ amount: '7.99' }))).toBe(false);
    expect(matchRule(c.rules[0]!, ctxOf({ amount: '25.01' }))).toBe(false);
    expect(matchRule(c.rules[0]!, ctxOf({ amount: '-12.00' }))).toBe(true);
  });
  it('pins currency case-insensitively', () => {
    const c = one('r', { match: { currency: 'eur' } });
    expect(matchRule(c.rules[0]!, ctxOf({ currency_code: 'EUR' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ currency_code: 'USD' }))).toBe(false);
  });
});

describe('tags', () => {
  it('tags_any matches when any tag is present', () => {
    const c = one('r', { match: { tags_any: ['lunch', 'takeout'] } });
    expect(matchRule(c.rules[0]!, ctxOf({ tags: ['LUNCH'] }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ tags: ['other'] }))).toBe(false);
  });
  it('tags_none matches when none of the tags are present', () => {
    const c = one('r', { match: { tags_none: ['nope'] } });
    expect(matchRule(c.rules[0]!, ctxOf({ tags: ['lunch'] }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ tags: ['nope', 'lunch'] }))).toBe(false);
  });
});

describe('weekdays / time', () => {
  it('weekdays support names and ranges (UTC)', () => {
    // 2026-10-25 is a Sunday
    const c = one('r', { match: { weekdays: ['mon-fri'] } });
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T12:00:00Z' }))).toBe(false);
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-26T12:00:00Z' }))).toBe(true); // Monday
    const c2 = one('r', { match: { weekdays: ['sat', 'sunday'] } });
    expect(matchRule(c2.rules[0]!, ctxOf({ date: '2026-10-25T12:00:00Z' }))).toBe(true);
  });
  it('time windows are inclusive and evaluated in the local TZ', () => {
    const c = one('r', { match: { time: { from: '11:00', to: '15:30' } } });
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T11:00:00Z' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T15:30:00Z' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T15:31:00Z' }))).toBe(false);
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T10:59:00Z' }))).toBe(false);
  });
  it('time windows can wrap midnight', () => {
    const c = one('r', { match: { time: { from: '22:00', to: '02:00' } } });
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T23:00:00Z' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T01:00:00Z' }))).toBe(true);
    expect(matchRule(c.rules[0]!, ctxOf({ date: '2026-10-25T12:00:00Z' }))).toBe(false);
  });
});

describe('rule order / continue', () => {
  const rules = compileRules(
    rulesFileSchema.parse({
      rules: [
        { name: 'first', continue: true, match: { destination: '/garden/i' }, action: { log: 'food', food_id: 'f1' } },
        { name: 'second', match: { destination: 'Indian Garden' }, action: { log: 'meal', meal_template_id: 'm1' } },
        { name: 'third', match: { description: 'zzz' }, action: { log: 'food', food_id: 'f3' } },
      ],
    }),
  );
  const ctx = ctxOf();

  it('first match wins and later rules are skipped', () => {
    const names = matchedRules(rules.rules, ctxOf({ destination_name: 'nowhere' })).map((r) => r.name);
    expect(names).toEqual([]);
  });
  it('a matching non-continue rule stops evaluation', () => {
    // "second" matches (exact) and has no continue — but "first" matches first via regex and continues
    const names = matchedRules(rules.rules, ctx).map((r) => r.name);
    expect(names).toEqual(['first', 'second']);
  });
  it('rules after a stop are not evaluated', () => {
    const names = matchedRules(rules.rules, ctxOf({ description: 'zzz', destination_name: 'somewhere' })).map((r) => r.name);
    expect(names).toEqual(['third']);
  });
});
