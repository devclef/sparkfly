import type { FireflySplit } from '../firefly/types.js';
import type { CompiledRule } from './compile.js';
import { rangeContains, type LocalParts } from './mealType.js';

export interface SplitContext {
  split: FireflySplit;
  /** Wall-clock parts of the split date in the configured TZ. */
  local: LocalParts;
}

/** Does a single (compiled) rule match this transaction split? */
export function matchRule(rule: CompiledRule, ctx: SplitContext): boolean {
  const { split, local } = ctx;

  if (split.type !== rule.type) return false;

  const m = rule.matchers;
  if (m.source && !m.source(split.source_name)) return false;
  if (m.destination && !m.destination(split.destination_name)) return false;
  if (m.description && !m.description(split.description)) return false;
  if (m.category && !m.category(split.category_name)) return false;
  if (m.budget && !m.budget(split.budget_name)) return false;

  if (rule.currency && split.currency_code.toLowerCase() !== rule.currency) return false;

  if (rule.amountMin !== null || rule.amountMax !== null) {
    const amount = Math.abs(Number(split.amount));
    if (!Number.isFinite(amount)) return false;
    if (rule.amountMin !== null && amount < rule.amountMin) return false;
    if (rule.amountMax !== null && amount > rule.amountMax) return false;
  }

  if (rule.tagsAny.size > 0) {
    const tags = new Set(split.tags.map((t) => t.toLowerCase()));
    if (![...rule.tagsAny].some((t) => tags.has(t))) return false;
  }
  if (rule.tagsNone.size > 0) {
    const tags = new Set(split.tags.map((t) => t.toLowerCase()));
    if ([...rule.tagsNone].some((t) => tags.has(t))) return false;
  }

  if (rule.weekdays && !rule.weekdays.has(local.weekday)) return false;

  if (rule.timeRange) {
    const minutes = local.hour * 60 + local.minute;
    if (!rangeContains(rule.timeRange, minutes)) return false;
  }

  return true;
}

/**
 * Evaluate rules in order. First match wins unless the rule sets
 * `continue: true`, in which case later rules are checked too (and may each
 * produce their own entry).
 */
export function matchedRules(rules: CompiledRule[], ctx: SplitContext): CompiledRule[] {
  const hits: CompiledRule[] = [];
  for (const rule of rules) {
    if (matchRule(rule, ctx)) {
      hits.push(rule);
      if (!rule.cont) break;
    }
  }
  return hits;
}

/** Compact description used in "no rule matched" log lines. */
export function describeSplit(split: FireflySplit): string {
  const bits = [`${split.type} ${split.amount} ${split.currency_code}`];
  if (split.description) bits.push(JSON.stringify(split.description));
  if (split.destination_name) bits.push(`→ ${split.destination_name}`);
  if (split.category_name) bits.push(`[${split.category_name}]`);
  return bits.join(' ');
}
