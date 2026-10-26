import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { FireflySplit } from '../firefly/types.js';
import { patternToMatcher, type PatternMatcher } from './compile.js';

/**
 * Dashboard filters for incoming webhooks. Firefly sends *every* transaction
 * to Sparkfly, most of which (rent, groceries, …) will never become a meal.
 * Filters decide which transactions the dashboard shows:
 *
 *  - include: when at least one is enabled, only matching transactions show;
 *  - exclude: matching transactions are hidden.
 *
 * Within a filter every given field must match (AND). Patterns use the same
 * syntax as rules: exact (case-insensitive) or a `/regex/flags` literal.
 * Filters only affect what is displayed — rules still run on everything.
 */

export const FILTER_FIELDS = ['description', 'destination', 'source', 'category', 'budget', 'tag'] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

const SETTING_KEY = 'webhook_filters';

export const webhookFilterSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  mode: z.enum(['include', 'exclude']),
  enabled: z.boolean().default(true),
  match: z
    .object({
      type: z.enum(['withdrawal', 'deposit', 'transfer']).optional(),
      description: z.string().min(1).optional(),
      destination: z.string().min(1).optional(),
      source: z.string().min(1).optional(),
      category: z.string().min(1).optional(),
      budget: z.string().min(1).optional(),
      tag: z.string().min(1).optional(),
    })
    .refine((m) => Object.keys(m).length > 0, 'a filter needs at least one condition'),
});
export type WebhookFilter = z.infer<typeof webhookFilterSchema>;

export function loadFilters(db: Db): WebhookFilter[] {
  const raw = db.getSetting(SETTING_KEY);
  if (!raw) return [];
  try {
    const parsed = z.array(webhookFilterSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function saveFilters(db: Db, filters: WebhookFilter[]): void {
  db.setSetting(SETTING_KEY, JSON.stringify(filters));
}

export type FilterResult = { ok: true; filter: Omit<WebhookFilter, 'id'> } | { ok: false; errors: string[] };

/** Build a filter from the dashboard form's URL-encoded fields. */
export function filterFromForm(fields: Record<string, string | undefined>): FilterResult {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const errors: string[] = [];
  const mode = str(fields.mode);
  if (mode !== 'include' && mode !== 'exclude') errors.push('mode must be include or exclude');

  const match: WebhookFilter['match'] = {};
  const type = str(fields.type);
  if (type) {
    if (type === 'withdrawal' || type === 'deposit' || type === 'transfer') match.type = type;
    else errors.push(`unknown type "${type}"`);
  }
  for (const f of FILTER_FIELDS) {
    const v = str(fields[f]);
    if (!v) continue;
    try {
      patternToMatcher(v);
      match[f] = v;
    } catch (err) {
      errors.push(`${f}: ${(err as Error).message}`);
    }
  }
  if (Object.keys(match).length === 0) errors.push('give the filter at least one condition');
  if (errors.length > 0) return { ok: false, errors };

  const name = str(fields.name) || describeFilterMatch(match);
  return { ok: true, filter: { name, mode: mode as 'include' | 'exclude', enabled: true, match } };
}

export function describeFilterMatch(m: WebhookFilter['match']): string {
  const bits: string[] = [];
  if (m.type) bits.push(`type = ${m.type}`);
  for (const f of FILTER_FIELDS) if (m[f]) bits.push(`${f} = ${m[f]}`);
  return bits.join(' · ');
}

interface CompiledFilter {
  mode: 'include' | 'exclude';
  test: (split: FireflySplit) => boolean;
}

function compileFilter(f: WebhookFilter): CompiledFilter {
  const checks: ((s: FireflySplit) => boolean)[] = [];
  const m = f.match;
  if (m.type) checks.push((s) => s.type === m.type);
  const field = (spec: string | undefined, get: (s: FireflySplit) => string | null | undefined): void => {
    if (!spec) return;
    const pm: PatternMatcher = patternToMatcher(spec);
    checks.push((s) => pm(get(s)));
  };
  field(m.description, (s) => s.description);
  field(m.destination, (s) => s.destination_name);
  field(m.source, (s) => s.source_name);
  field(m.category, (s) => s.category_name);
  field(m.budget, (s) => s.budget_name);
  if (m.tag) {
    const pm = patternToMatcher(m.tag);
    checks.push((s) => s.tags.some((t) => pm(t)));
  }
  return { mode: f.mode, test: (s) => checks.every((c) => c(s)) };
}

/** Returns a predicate: should this transaction be shown on the dashboard? */
export function visibilityPredicate(filters: WebhookFilter[]): (split: FireflySplit) => boolean {
  const compiled: CompiledFilter[] = [];
  for (const f of filters) {
    if (!f.enabled) continue;
    try {
      compiled.push(compileFilter(f));
    } catch {
      // Validated on save; a stored filter that no longer compiles is ignored.
    }
  }
  const includes = compiled.filter((c) => c.mode === 'include');
  const excludes = compiled.filter((c) => c.mode === 'exclude');
  return (split) => {
    if (includes.length > 0 && !includes.some((c) => c.test(split))) return false;
    return !excludes.some((c) => c.test(split));
  };
}
