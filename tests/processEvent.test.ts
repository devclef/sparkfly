import { describe, expect, it } from 'vitest';
import { EventProcessor } from '../src/core/processEvent.js';
import { RetryLater } from '../src/core/queue.js';
import {
  RULES_FILE,
  buildPayload,
  compileFile,
  fakeSparky,
  makeDb,
  makeSparky,
  testConfig,
} from './helpers.js';

async function insertEvent(db: ReturnType<typeof makeDb>, payload: unknown): Promise<number> {
  const raw = JSON.stringify(payload);
  const { id } = db.insertEvent({ uuid: String(payload && (payload as { uuid?: string }).uuid) ?? 'u', trigger: (payload as { trigger: string }).trigger, rawJson: raw });
  return id;
}

function makeProcessor(opts: { dryRun?: boolean; failNext?: number; maxAttempts?: number } = {}) {
  const db = makeDb();
  const fake = fakeSparky();
  fake.failNext = opts.failNext ?? 0;
  const cfg = testConfig({
    dryRun: opts.dryRun ?? false,
    retry: { maxAttempts: opts.maxAttempts ?? 3, baseDelayMs: 1, maxDelayMs: 10 },
  });
  const processor = new EventProcessor({
    db,
    cfg,
    sparky: opts.dryRun ? null : makeSparky(cfg, fake),
    compiled: compileFile(RULES_FILE),
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  return { db, fake, cfg, processor, insert: (p: unknown) => insertEvent(db, p) };
}

describe('processEvent: STORE_TRANSACTION', () => {
  it('logs a saved meal for a matching rule and stores the link', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload());

    await processor.process(id);

    const event = db.getEvent(id)!;
    expect(event.status).toBe('succeeded');
    expect(event.result_summary).toBe('splits=1 logged=1');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.method).toBe('POST');
    expect(fake.calls[0]!.path).toBe('/api/food-entry-meals');
    expect(fake.calls[0]!.body).toEqual({
      meal_template_id: 'meal-tikka',
      meal_type: 'lunch', // 12:41 UTC is inside 11:00-15:59
      entry_date: '2026-10-25',
      entry_time: '12:41',
      quantity: 1,
      unit: 'serving',
      notes: 'Indian Garden – 14.50 EUR',
    });

    const links = db.linksForJournal('1234');
    expect(links).toHaveLength(1);
    expect(links[0]!.rule_id).toBe('Indian Garden');
    expect(links[0]!.kind).toBe('meal');
    expect(links[0]!.sparky_entry_id).toBe('1');
  });

  it('logs a single food with the idempotency source/source_id', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({}, { destination_name: 'Starbucks #7' }));

    await processor.process(id);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.path).toBe('/api/food-entries');
    expect(fake.calls[0]!.body).toMatchObject({
      food_id: 'food-latte',
      meal_type: 'snacks',
      source: 'firefly',
      source_id: '1234',
      entry_date: '2026-10-25',
    });
    expect(db.linksForJournal('1234')[0]!.kind).toBe('food');
  });

  it('dry run never calls SparkyFitness and stores no links', async () => {
    const { db, fake, processor, insert } = makeProcessor({ dryRun: true });
    const id = await insert(buildPayload());

    await processor.process(id);

    expect(fake.calls).toHaveLength(0);
    expect(db.linksForJournal('1234')).toHaveLength(0);
    const event = db.getEvent(id)!;
    expect(event.status).toBe('succeeded');
    expect(event.result_summary).toContain('dry_run');
    expect(db.logForEvent(id).some((l) => l.message.includes('would log'))).toBe(true);
  });

  it('skips transactions tagged with the global skip tag', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({}, { tags: ['lunch', 'no-sparky'] }));

    await processor.process(id);

    expect(fake.calls).toHaveLength(0);
    expect(db.getEvent(id)!.result_summary).toBe('splits=1 logged=0 (journal 1234 skipped (skip tag))');
  });

  it('succeeds with logged=0 when no rule matches', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({}, { destination_name: 'Nowhere Else' }));

    await processor.process(id);

    expect(fake.calls).toHaveLength(0);
    expect(db.getEvent(id)!.result_summary).toBe('splits=1 logged=0 (journal 1234 no match)');
  });

  it('handles split transactions journal by journal', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const payload = buildPayload({}, {});
    const p = payload as { content: { transactions: object[] } };
    p.content.transactions.push({
      transaction_journal_id: 5678,
      type: 'withdrawal',
      date: '2026-10-25T12:41:00Z',
      amount: '3.20',
      currency_code: 'EUR',
      description: 'Costa',
      source_name: 'Checking',
      destination_name: 'Costa Coffee',
      category_name: null,
      budget_name: null,
      tags: [],
      notes: null,
    });
    const id = await insert(payload);

    await processor.process(id);

    expect(fake.calls).toHaveLength(2);
    expect(db.getEvent(id)!.result_summary).toBe('splits=2 logged=2');
    expect(db.linksForJournal('5678')[0]!.rule_id).toBe('Coffee');
  });

  it('omits entry_time and picks dinner for 00:00 transactions', async () => {
    const { fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({}, { date: '2026-10-25T00:00:00Z' }));

    await processor.process(id);

    expect(fake.calls[0]!.body).toMatchObject({
      meal_type: 'dinner',
      entry_date: '2026-10-25',
    });
    expect(fake.calls[0]!.body).not.toHaveProperty('entry_time');
  });

  it('scales quantity with quantity_from_amount', async () => {
    const base = makeProcessor();
    const rules = compileFile({
      ...RULES_FILE,
      rules: [
        {
          name: 'Big order',
          match: { destination: 'Indian Garden' },
          action: { log: 'food', food_id: 'f', quantity: 1, meal_type: 'lunch', quantity_from_amount: { per_unit: 14.5 } },
        },
      ],
    });
    const proc = new EventProcessor({
      db: base.db,
      cfg: base.cfg,
      sparky: makeSparky(base.cfg, base.fake),
      compiled: rules,
      logger: { info() {}, warn() {}, error() {} } as never,
    });
    const id = await base.insert(buildPayload({}, { amount: '29.00' }));
    await proc.process(id);
    expect(base.fake.calls[0]!.body).toMatchObject({ food_id: 'f', quantity: 2, meal_type: 'lunch' });
  });

  it('continues to later rules when continue: true', async () => {
    const { db, fake, cfg, insert } = makeProcessor();
    const rules = compileFile({
      ...RULES_FILE,
      rules: [
        { name: 'A', continue: true, match: { destination: '/garden/i' }, action: { log: 'food', food_id: 'fa', meal_type: 'lunch' } },
        { name: 'B', match: { destination: 'Indian Garden' }, action: { log: 'meal', meal_template_id: 'mb', meal_type: 'lunch' } },
      ],
    });
    const proc = new EventProcessor({ db, cfg, sparky: makeSparky(cfg, fake), compiled: rules, logger: { info() {}, warn() {}, error() {} } as never });
    const id = await insert(buildPayload());
    await proc.process(id);
    expect(fake.calls.map((c) => c.path).sort()).toEqual(['/api/food-entries', '/api/food-entry-meals']);
    expect(db.linksForJournal('1234').map((l) => l.rule_id).sort()).toEqual(['A', 'B']);
  });
});

describe('processEvent: lifecycle triggers', () => {
  // Full lifecycle coverage (update / replace / delete / retries) lives in
  // tests/lifecycle.test.ts; these check the no-op edge cases.
  it('handles UPDATE_TRANSACTION with nothing linked and no match', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({ trigger: 'UPDATE_TRANSACTION', uuid: 'l1' }, { destination_name: 'Nowhere Else' }));
    await processor.process(id);
    expect(fake.calls).toHaveLength(0);
    const event = db.getEvent(id)!;
    expect(event.status).toBe('succeeded');
    expect(event.result_summary).toBe('splits=1 updated=0 created=0 deleted=0 (journal 1234 no changes)');
  });

  it('handles DESTROY_TRANSACTION for a journal without links', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({ trigger: 'DESTROY_TRANSACTION', uuid: 'l2' }));
    await processor.process(id);
    expect(fake.calls).toHaveLength(0);
    expect(db.getEvent(id)!.status).toBe('succeeded');
    expect(db.getEvent(id)!.result_summary).toBe('splits=1 deleted=0 (journal 1234 no links)');
  });

  it('skips unknown triggers', async () => {
    const { db, processor, insert } = makeProcessor();
    const id = await insert(buildPayload({ trigger: 'CREATE_BUDGET' }));
    await processor.process(id);
    expect(db.getEvent(id)!.status).toBe('skipped');
    expect(db.getEvent(id)!.result_summary).toContain('unsupported trigger');
  });
});

describe('processEvent: retries and failures', () => {
  it('marks failed + throws RetryLater on the first failure, succeeds on retry', async () => {
    const { db, fake, processor, insert } = makeProcessor({ failNext: 1 });
    const id = await insert(buildPayload());

    await expect(processor.process(id)).rejects.toBeInstanceOf(RetryLater);
    expect(db.getEvent(id)!.status).toBe('failed');
    expect(db.getEvent(id)!.attempts).toBe(1);
    expect(db.getEvent(id)!.last_error).toContain('500');

    await processor.process(id);
    expect(db.getEvent(id)!.status).toBe('succeeded');
    expect(fake.calls).toHaveLength(2); // one per attempt (the upsert source_id dedupes in Sparky)
  });

  it('does not create a duplicate meal when a meal was already linked (idempotent retry)', async () => {
    const { db, fake, processor, insert } = makeProcessor();
    const id = await insert(buildPayload());
    await processor.process(id);

    // simulate a redelivery of the same logical event (new row, same journal)
    const id2 = await insert(buildPayload({ uuid: 'uuid-2' }));
    await processor.process(id2);

    const mealCalls = fake.calls.filter((c) => c.path === '/api/food-entry-meals');
    expect(mealCalls).toHaveLength(1);
    expect(db.getEvent(id2)!.result_summary).toContain('logged=1');
  });

  it('gives up (dead) after maxAttempts', async () => {
    const { db, fake, processor, insert } = makeProcessor({ failNext: 99, maxAttempts: 2 });
    const id = await insert(buildPayload());

    await expect(processor.process(id)).rejects.toBeInstanceOf(RetryLater);
    expect(db.getEvent(id)!.status).toBe('failed');
    await processor.process(id); // final attempt: marks dead, resolves
    const event = db.getEvent(id)!;
    expect(event.status).toBe('dead');
    expect(event.attempts).toBe(2);
    expect(fake.calls).toHaveLength(2);
  });

  it('backoffDelay grows exponentially and is capped', () => {
    const { processor } = makeProcessor();
    const a = processor.backoffDelay(1);
    const b = processor.backoffDelay(5);
    const c = processor.backoffDelay(50);
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(10);
    expect(b).toBeGreaterThan(a / 2);
    expect(c).toBeLessThanOrEqual(10);
  });
});
