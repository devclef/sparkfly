import { ruleSchema, type RuleSpec } from './types.js';
import { validateRuleSpec } from './load.js';

export type SpecResult = { ok: true; spec: RuleSpec } | { ok: false; errors: string[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const csv = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);

function finalize(parsed: RuleSpec): SpecResult {
  try {
    validateRuleSpec(parsed);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  return { ok: true, spec: parsed };
}

/**
 * Build a rule spec from the web form's URL-encoded fields. Empty fields are
 * omitted entirely, so a rule can match on as little as a destination.
 */
export function specFromForm(fields: Record<string, string | undefined>): SpecResult {
  const errors: string[] = [];
  const name = str(fields.name);

  const match: Record<string, unknown> = {};
  const type = str(fields.type);
  if (type) match.type = type;
  for (const f of ['source', 'destination', 'description', 'category', 'budget'] as const) {
    const v = str(fields[f]);
    if (v) match[f] = v;
  }
  const currency = str(fields.currency);
  if (currency) match.currency = currency;

  const amountMin = str(fields.amount_min);
  const amountMax = str(fields.amount_max);
  if (amountMin || amountMax) {
    const amount: Record<string, number> = {};
    if (amountMin) {
      const n = Number(amountMin);
      if (!Number.isFinite(n)) errors.push('amount min must be a number');
      else amount.min = n;
    }
    if (amountMax) {
      const n = Number(amountMax);
      if (!Number.isFinite(n)) errors.push('amount max must be a number');
      else amount.max = n;
    }
    if (Object.keys(amount).length > 0) match.amount = amount;
  }

  for (const f of ['tags_any', 'tags_none'] as const) {
    const v = csv(str(fields[f]));
    if (v.length > 0) match[f] = v;
  }
  const weekdays = csv(str(fields.weekdays));
  if (weekdays.length > 0) match.weekdays = weekdays;

  const timeFrom = str(fields.time_from);
  const timeTo = str(fields.time_to);
  if (timeFrom || timeTo) {
    if (!timeFrom || !timeTo) errors.push('the time window needs both a "from" and a "to"');
    else match.time = { from: timeFrom, to: timeTo };
  }

  const log = str(fields.log);
  const action: Record<string, unknown> = {
    log,
    meal_type: str(fields.meal_type) || 'auto',
    quantity: str(fields.quantity) === '' ? 1 : Number(str(fields.quantity)),
    unit: str(fields.unit) || 'serving',
  };
  const note = str(fields.note);
  if (note) action.note = note;

  if (log === 'meal') {
    // Set only when present: an empty string would fail the zod min(1)
    // before the friendlier cross-field error ("meal_template_id is missing").
    const t = str(fields.meal_template_id);
    if (t) action.meal_template_id = t;
  } else if (log === 'food') {
    const f = str(fields.food_id);
    if (f) action.food_id = f;
    const variant = str(fields.variant_id);
    if (variant) action.variant_id = variant;
  } else if (log === 'foods') {
    const n = Math.max(0, Math.floor(Number(str(fields.foods_count)) || 0));
    const foods: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const item: Record<string, unknown> = { food_id: str(fields[`foods_${i}_food_id`]) };
      const q = str(fields[`foods_${i}_quantity`]);
      if (q !== '') item.quantity = Number(q);
      const v = str(fields[`foods_${i}_variant_id`]);
      if (v) item.variant_id = v;
      const u = str(fields[`foods_${i}_unit`]);
      if (u) item.unit = u;
      const it = str(fields[`foods_${i}_note`]);
      if (it) item.note = it;
      foods.push(item);
    }
    if (foods.length > 0) action.foods = foods;
  }

  const perUnit = str(fields.quantity_from_amount_per_unit);
  if (perUnit) {
    const n = Number(perUnit);
    if (!Number.isFinite(n) || n <= 0) errors.push('quantity_from_amount per_unit must be a positive number');
    else action.quantity_from_amount = { per_unit: n };
  }

  const parsed = ruleSchema.safeParse({
    name,
    'continue': fields.cont === 'on' || fields.cont === 'true',
    match,
    action,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${issue.path.join('.') || '(rule)'}: ${issue.message}`);
    }
    return { ok: false, errors };
  }
  if (errors.length > 0) return { ok: false, errors };
  return finalize(parsed.data);
}

/** Build a rule spec from a JSON body (the /api/rules programmatic API). */
export function specFromJson(body: unknown): SpecResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: ['body must be a rule object: { name, match, action }'] };
  }
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join('.') || '(rule)'}: ${i.message}`);
    return { ok: false, errors };
  }
  return finalize(parsed.data);
}
