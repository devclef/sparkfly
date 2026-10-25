import { parseRange, type MinuteRange } from './mealType.js';
import type { ActionSpec, PatternSpec, RulesFile } from './types.js';

/**
 * Rules are compiled once at startup: regexes are constructed, weekday lists
 * expanded and time ranges parsed. A misconfigured rule therefore fails the
 * boot instead of every incoming webhook.
 */

export type PatternMatcher = (value: string | null | undefined) => boolean;

export function patternToMatcher(spec: PatternSpec): PatternMatcher {
  let re: RegExp | null = null;
  if (typeof spec === 'object') {
    try {
      re = new RegExp(spec.pattern, spec.flags);
    } catch (err) {
      throw new Error(`invalid regex ${JSON.stringify(spec)}: ${(err as Error).message}`);
    }
  } else {
    const literal = spec.match(/^\/(.+)\/([a-z]*)$/);
    if (literal) {
      try {
        re = new RegExp(literal[1] ?? '', literal[2] ?? '');
      } catch (err) {
        throw new Error(`invalid regex literal "${spec}": ${(err as Error).message}`);
      }
    } else {
      const needle = spec.toLowerCase();
      return (value) => (value ?? '').toLowerCase() === needle;
    }
  }
  const compiled = re as RegExp;
  return (value) => (value == null ? false : compiled.test(value));
}

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export function expandWeekdays(specs: string[]): Set<number> {
  const days = new Set<number>();
  for (const raw of specs) {
    const s = raw.toLowerCase().trim();
    const range = s.match(/^([a-z]+)-([a-z]+)$/);
    if (range) {
      const from = WEEKDAY_ALIASES[range[1] ?? ''];
      const to = WEEKDAY_ALIASES[range[2] ?? ''];
      if (from === undefined || to === undefined) throw new Error(`unknown weekday in "${raw}"`);
      if (from > to) throw new Error(`weekday range "${raw}" wraps around; list the days instead (e.g. [fri, sat, sun, mon])`);
      for (let d = from; d <= to; d++) days.add(d);
    } else {
      const day = WEEKDAY_ALIASES[s];
      if (day === undefined) throw new Error(`unknown weekday "${raw}" (use mon..sun or monday..sunday)`);
      days.add(day);
    }
  }
  return days;
}

/** How a pattern spec should be displayed in logs / the UI. */
function displaySpec(spec: PatternSpec | undefined): string | null {
  if (spec === undefined) return null;
  if (typeof spec === 'string') return spec;
  return `/${spec.pattern}/${spec.flags}`;
}

export interface CompiledRule {
  /** The rule name — also its stable id in the links table. */
  name: string;
  /** Whether later rules are still evaluated after a match. */
  cont: boolean;
  /** Defaults to withdrawal (refunds/deposits are ignored). */
  type: 'withdrawal' | 'deposit' | 'transfer';
  matchers: {
    source: PatternMatcher | null;
    destination: PatternMatcher | null;
    description: PatternMatcher | null;
    category: PatternMatcher | null;
    budget: PatternMatcher | null;
  };
  /** Raw specs, kept for display. */
  display: {
    source: string | null;
    destination: string | null;
    description: string | null;
    category: string | null;
    budget: string | null;
  };
  currency: string | null;
  amountMin: number | null;
  amountMax: number | null;
  tagsAny: Set<string>;
  tagsNone: Set<string>;
  weekdays: Set<number> | null;
  timeRange: MinuteRange | null;
  action: ActionSpec;
}

export interface CompiledRules {
  rules: CompiledRule[];
  defaults: RulesFile['defaults'];
}

export function compileRules(file: RulesFile): CompiledRules {
  const rules: CompiledRule[] = file.rules.map((rule) => {
    const m = rule.match;
    const compileField = (spec: PatternSpec | undefined): PatternMatcher | null =>
      spec === undefined ? null : patternToMatcher(spec);
    let weekdays: Set<number> | null = null;
    if (m.weekdays) weekdays = expandWeekdays(m.weekdays);
    let timeRange: MinuteRange | null = null;
    if (m.time) {
      try {
        timeRange = parseRange(`${m.time.from}-${m.time.to}`);
      } catch {
        throw new Error(`rule "${rule.name}": invalid match.time window ${JSON.stringify(m.time)}`);
      }
    }
    return {
      name: rule.name,
      cont: rule['continue'],
      type: m.type ?? 'withdrawal',
      matchers: {
        source: compileField(m.source),
        destination: compileField(m.destination),
        description: compileField(m.description),
        category: compileField(m.category),
        budget: compileField(m.budget),
      },
      display: {
        source: displaySpec(m.source),
        destination: displaySpec(m.destination),
        description: displaySpec(m.description),
        category: displaySpec(m.category),
        budget: displaySpec(m.budget),
      },
      currency: m.currency?.toLowerCase() ?? null,
      amountMin: m.amount?.min ?? null,
      amountMax: m.amount?.max ?? null,
      tagsAny: new Set((m.tags_any ?? []).map((t) => t.toLowerCase())),
      tagsNone: new Set((m.tags_none ?? []).map((t) => t.toLowerCase())),
      weekdays,
      timeRange,
      action: rule.action,
    };
  });
  return { rules, defaults: file.defaults };
}

const WD_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const fmt = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** One-line human summary for the status page and logs. */
export function summarizeMatch(rule: CompiledRule): string {
  const parts: string[] = [rule.type];
  if (rule.display.destination) parts.push(`destination ${rule.display.destination}`);
  if (rule.display.source) parts.push(`source ${rule.display.source}`);
  if (rule.display.description) parts.push(`description ${rule.display.description}`);
  if (rule.display.category) parts.push(`category ${rule.display.category}`);
  if (rule.display.budget) parts.push(`budget ${rule.display.budget}`);
  if (rule.currency) parts.push(`currency ${rule.currency.toUpperCase()}`);
  if (rule.amountMin !== null || rule.amountMax !== null) {
    parts.push(`amount ${rule.amountMin ?? '…'}–${rule.amountMax ?? '…'}`);
  }
  if (rule.tagsAny.size) parts.push(`tags_any [${[...rule.tagsAny].join(', ')}]`);
  if (rule.tagsNone.size) parts.push(`tags_none [${[...rule.tagsNone].join(', ')}]`);
  if (rule.weekdays) parts.push(`weekdays [${[...rule.weekdays].map((d) => WD_NAMES[d] ?? String(d)).join(', ')}]`);
  if (rule.timeRange) parts.push(`time ${fmt(rule.timeRange.from)}–${fmt(rule.timeRange.to)}`);
  return parts.join(', ');
}

/** One-line human summary of the action. */
export function summarizeAction(rule: CompiledRule): string {
  const a = rule.action;
  const target =
    a.log === 'meal' ? `meal ${a.meal_template_id}` :
    a.log === 'food' ? `food ${a.food_id}${a.variant_id ? ` (variant ${a.variant_id})` : ''}` :
    `foods [${a.foods?.map((f) => f.food_id).join(', ')}]`;
  const extras: string[] = [`meal_type ${a.meal_type}`];
  if (a.quantity_from_amount) extras.push(`qty=amount/${a.quantity_from_amount.per_unit}`);
  else extras.push(`qty ${a.quantity}`);
  if (a.note) extras.push(`note "${a.note}"`);
  return `${a.log} ${target}, ${extras.join(', ')}`;
}
