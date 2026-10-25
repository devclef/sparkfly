import { z } from 'zod';

/**
 * A pattern spec is either:
 *  - a plain string: exact match, case-insensitive — unless it is written as
 *    a regex literal `/pattern/flags` (e.g. `/starbucks|costa/i`);
 *  - an object: `{ pattern: "...", flags: "i" }`.
 */
const patternValue = z.union([
  z.string().min(1),
  z.object({ pattern: z.string().min(1), flags: z.string().default('') }),
]);
export type PatternSpec = z.infer<typeof patternValue>;

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const RANGES = /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/;

export const matchSchema = z.object({
  /** Firefly split type. Default: `withdrawal` (ignore refunds/deposits). */
  type: z.enum(['withdrawal', 'deposit', 'transfer']).optional(),
  source: patternValue.optional(),
  destination: patternValue.optional(),
  description: patternValue.optional(),
  category: patternValue.optional(),
  budget: patternValue.optional(),
  /** Pin the transaction currency (case-insensitive). */
  currency: z.string().min(1).optional(),
  amount: z
    .object({ min: z.number().optional(), max: z.number().optional() })
    .refine((a) => a.min !== undefined || a.max !== undefined, 'give amount a min and/or max')
    .optional(),
  /** Match if the transaction has at least one of these tags (case-insensitive). */
  tags_any: z.array(z.string().min(1)).optional(),
  /** Match if the transaction has none of these tags (case-insensitive). */
  tags_none: z.array(z.string().min(1)).optional(),
  /** e.g. [mon-fri] or [sat, sun] — evaluated in the configured TZ. */
  weekdays: z.array(z.string().min(1)).optional(),
  /** Local time window in the configured TZ, inclusive, may wrap midnight. */
  time: z.object({
    from: z.string().regex(TIME, 'expected "HH:MM"'),
    to: z.string().regex(TIME, 'expected "HH:MM"'),
  }).optional(),
});

const foodItemSchema = z.object({
  food_id: z.string().min(1),
  variant_id: z.string().optional(),
  quantity: z.number().positive().default(1),
  unit: z.string().optional(),
  note: z.string().optional(),
});

export const actionSchema = z.object({
  /** meal = saved-meal template, food = single food, foods = several single foods. */
  log: z.enum(['meal', 'food', 'foods']),
  meal_template_id: z.string().min(1).optional(),
  food_id: z.string().min(1).optional(),
  variant_id: z.string().optional(),
  foods: z.array(foodItemSchema).min(1).optional(),
  /** auto | breakfast | lunch | dinner | snacks | <custom type name> */
  meal_type: z.string().min(1).default('auto'),
  quantity: z.number().positive().default(1),
  unit: z.string().default('serving'),
  /** `{{var}}` templates: description, amount, currency, category, destination,
   *  source, budget, date, time, tags, group_title */
  note: z.string().optional(),
  /** Off by default: quantity = round(amount / per_unit), minimum 1. */
  quantity_from_amount: z.object({ per_unit: z.number().positive() }).optional(),
});

export const ruleSchema = z.object({
  name: z.string().min(1),
  /** Keep evaluating later rules after this one matches. Default: false. */
  'continue': z.boolean().default(false),
  match: matchSchema.default({}),
  action: actionSchema,
});

export const mealTypeRangeSchema = z.string().regex(RANGES, 'expected "HH:MM-HH:MM", e.g. "11:00-15:59"');

export const DEFAULT_MEAL_TYPE_AUTO = {
  breakfast: '04:00-10:59',
  lunch: '11:00-15:59',
  snacks: '16:00-17:29',
  dinner: '17:30-03:59',
} as const;

export const DEFAULTS = {
  meal_type_auto: { ...DEFAULT_MEAL_TYPE_AUTO },
  global_skip_tag: 'no-sparky',
} as const;

export const rulesFileSchema = z.object({
  rules: z.array(ruleSchema).default([]),
  defaults: z
    .object({
      /** Time ranges (inclusive, in the configured TZ) used by `meal_type: auto`. */
      meal_type_auto: z
        .object({
          breakfast: mealTypeRangeSchema.default(DEFAULT_MEAL_TYPE_AUTO.breakfast),
          lunch: mealTypeRangeSchema.default(DEFAULT_MEAL_TYPE_AUTO.lunch),
          snacks: mealTypeRangeSchema.default(DEFAULT_MEAL_TYPE_AUTO.snacks),
          dinner: mealTypeRangeSchema.default(DEFAULT_MEAL_TYPE_AUTO.dinner),
        })
        .default({ ...DEFAULT_MEAL_TYPE_AUTO }),
      /** Tagging a Firefly transaction with this skips it entirely. */
      global_skip_tag: z.string().min(1).default('no-sparky'),
    })
    .default({ ...DEFAULTS, meal_type_auto: { ...DEFAULT_MEAL_TYPE_AUTO } }),
});

export type MatchSpec = z.infer<typeof matchSchema>;
export type ActionSpec = z.infer<typeof actionSchema>;
export type FoodItemSpec = z.infer<typeof foodItemSchema>;
export type RuleSpec = z.infer<typeof ruleSchema>;
export type RulesFile = z.infer<typeof rulesFileSchema>;
export type MealTypeAutoSpec = RulesFile['defaults']['meal_type_auto'];
