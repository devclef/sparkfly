import { z } from 'zod';

/**
 * The subset of the Firefly III webhook payload Sparkfly relies on.
 * Firefly sends the full transaction group; extra fields are ignored.
 */
export const fireflySplitSchema = z.object({
  transaction_journal_id: z.union([z.number().int(), z.string()]),
  type: z.enum(['withdrawal', 'deposit', 'transfer']),
  date: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'unparseable ISO date'),
  amount: z.string(),
  currency_code: z.string(),
  description: z.string().nullable().optional(),
  source_name: z.string().nullable().optional(),
  destination_name: z.string().nullable().optional(),
  category_name: z.string().nullable().optional(),
  budget_name: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().nullable().optional(),
});

export const fireflyPayloadSchema = z.object({
  uuid: z.string().min(1),
  user_id: z.number().int().optional(),
  user_group_id: z.number().int().optional(),
  trigger: z.string().min(1),
  response: z.string().optional(),
  url: z.string().optional(),
  version: z.string().optional(),
  content: z.object({
    id: z.number().int().optional(),
    group_title: z.string().nullable().optional(),
    transactions: z.array(fireflySplitSchema),
  }),
});

export type FireflySplit = z.infer<typeof fireflySplitSchema>;
export type FireflyPayload = z.infer<typeof fireflyPayloadSchema>;

/** Split id as we store it (Firefly uses integers, but treat as string-safe). */
export function journalIdOf(split: FireflySplit): string {
  return String(split.transaction_journal_id);
}
