import { describe, expect, it } from 'vitest';
import { fireflySplitSchema, type FireflySplit } from '../src/firefly/types.js';
import { filterFromForm, loadFilters, saveFilters, visibilityPredicate, type WebhookFilter } from '../src/rules/webhookFilters.js';
import { makeDb } from './helpers.js';

const split = (o: Partial<FireflySplit> = {}): FireflySplit =>
  fireflySplitSchema.parse({
    transaction_journal_id: 1,
    type: 'withdrawal',
    date: '2026-10-25T12:41:00Z',
    amount: '14.50',
    currency_code: 'EUR',
    description: 'Indian Garden',
    destination_name: 'Indian Garden',
    budget_name: 'Food',
    category_name: 'Eating out',
    tags: ['lunch'],
    ...o,
  });

const f = (id: number, mode: 'include' | 'exclude', match: WebhookFilter['match'], enabled = true): WebhookFilter => ({
  id, name: `f${id}`, mode, enabled, match,
});

describe('webhook filters', () => {
  it('shows everything when there are no filters', () => {
    expect(visibilityPredicate([])(split())).toBe(true);
  });

  it('include filters show only matching transactions', () => {
    const vis = visibilityPredicate([f(1, 'include', { budget: 'food' })]);
    expect(vis(split())).toBe(true);
    expect(vis(split({ budget_name: 'Rent' }))).toBe(false);
    expect(vis(split({ budget_name: null }))).toBe(false);
  });

  it('several include filters are OR-ed, fields within one are AND-ed', () => {
    const vis = visibilityPredicate([
      f(1, 'include', { budget: 'Food', category: 'Eating out' }),
      f(2, 'include', { tag: '/coffee/i' }),
    ]);
    expect(vis(split())).toBe(true);
    expect(vis(split({ category_name: 'Groceries' }))).toBe(false);
    expect(vis(split({ budget_name: null, tags: ['Coffee-run'] }))).toBe(true);
  });

  it('exclude filters hide matching transactions, also inside an include', () => {
    const vis = visibilityPredicate([
      f(1, 'include', { budget: 'Food' }),
      f(2, 'exclude', { description: '/supermarket/i' }),
    ]);
    expect(vis(split())).toBe(true);
    expect(vis(split({ description: 'REWE Supermarket' }))).toBe(false);
  });

  it('ignores disabled filters', () => {
    const vis = visibilityPredicate([f(1, 'exclude', { type: 'withdrawal' }, false)]);
    expect(vis(split())).toBe(true);
  });

  it('builds filters from the form and rejects empty or invalid ones', () => {
    const ok = filterFromForm({ mode: 'include', budget: 'Food', description: ' ' });
    expect(ok).toEqual({ ok: true, filter: { name: 'budget = Food', mode: 'include', enabled: true, match: { budget: 'Food' } } });
    const empty = filterFromForm({ mode: 'exclude' });
    expect(empty.ok).toBe(false);
    const badRegex = filterFromForm({ mode: 'exclude', description: '/(/' });
    expect(badRegex.ok).toBe(false);
    const badMode = filterFromForm({ mode: 'maybe', budget: 'Food' });
    expect(badMode.ok).toBe(false);
  });

  it('persists filters in the settings table', () => {
    const db = makeDb();
    expect(loadFilters(db)).toEqual([]);
    saveFilters(db, [f(1, 'include', { budget: 'Food' })]);
    expect(loadFilters(db)).toEqual([f(1, 'include', { budget: 'Food' })]);
    db.close();
  });
});
