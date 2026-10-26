import { describe, expect, it } from 'vitest';
import { EventProcessor } from '../src/core/processEvent.js';
import { RetryLater } from '../src/core/queue.js';
import type { Db } from '../src/db/index.js';
import {
  RULES_FILE,
  buildPayload,
  compileFile,
  fakeSparky,
  makeDb,
  makeSparky,
  testConfig,
  type SparkyCall,
} from './helpers.js';

interface Env {
  db: Db;
  fake: ReturnType<typeof fakeSparky>;
  processor: EventProcessor;
  insert(payload: unknown): number;
}

function makeEnv(
  opts: { dryRun?: boolean; maxAttempts?: number; rules?: unknown; db?: Db; fake?: ReturnType<typeof fakeSparky> } = {},
): Env {
  const db = opts.db ?? makeDb();
  const fake = opts.fake ?? fakeSparky();
  const cfg = testConfig({
    dryRun: opts.dryRun ?? false,
    retry: { maxAttempts: opts.maxAttempts ?? 3, baseDelayMs: 1, maxDelayMs: 10 },
  });
  const processor = new EventProcessor({
    db,
    cfg,
    sparky: opts.dryRun ? null : makeSparky(cfg, fake),
    compiled: compileFile(opts.rules ?? RULES_FILE),
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  return {
    db,
    fake,
    processor,
    insert(payload) {
      const { id } = db.insertEvent({
        uuid: String((payload as { uuid?: string }).uuid ?? 'u'),
        trigger: (payload as { trigger: string }).trigger,
        rawJson: JSON.stringify(payload),
      });
      return id;
    },
  };
}

const findCall = (calls: SparkyCall[], method: string, pathPrefix: string): SparkyCall | undefined =>
  calls.find((c) => c.method === method && c.path.startsWith(pathPrefix));

/** STORE the default Indian Garden payload (matches the saved-meal rule). */
async function storeMeal(env: Env): Promise<void> {
  const id = env.insert(buildPayload({ uuid: 'uuid-store' }));
  await env.processor.process(id);
  expect(env.db.getEvent(id)!.status).toBe('succeeded');
}

describe('processEvent: UPDATE_TRANSACTION', () => {
  it('updates a meal entry in place via PUT when the same rule still matches', async () => {
    const env = makeEnv();
    await storeMeal(env);
    expect(env.fake.calls).toHaveLength(1);

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { date: '2026-10-25T13:05:00Z', amount: '20.00' }));
    await env.processor.process(id);

    const event = env.db.getEvent(id)!;
    expect(event.status).toBe('succeeded');
    expect(event.result_summary).toBe('splits=1 updated=1 created=0 deleted=0');

    const put = findCall(env.fake.calls, 'PUT', '/api/food-entry-meals/1');
    expect(put).toBeDefined();
    expect(put!.body).toEqual({
      meal_type: 'lunch',
      entry_date: '2026-10-25',
      entry_time: '13:05',
      quantity: 1,
      unit: 'serving',
      notes: 'Indian Garden – 20.00 EUR',
    });
    // The link is kept and its event reference refreshed.
    const link = env.db.linksForJournal('1234')[0]!;
    expect(link.rule_id).toBe('Indian Garden');
    expect(link.sparky_entry_id).toBe('1');
    expect(link.event_id).toBe(id);
  });

  it('updates a food entry by re-POSTing through the upsert key', async () => {
    const env = makeEnv();
    const storeId = env.insert(buildPayload({ uuid: 'uuid-store' }, { destination_name: 'Starbucks #7' }));
    await env.processor.process(storeId);
    expect(findCall(env.fake.calls, 'POST', '/api/food-entries')).toBeDefined();

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { destination_name: 'Starbucks #7', date: '2026-10-25T16:30:00Z' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 updated=1 created=0 deleted=0');
    const posts = env.fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/food-entries');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toMatchObject({
      food_id: 'food-latte',
      source: 'firefly',
      source_id: '1234',
      entry_time: '16:30',
      meal_type: 'snacks',
    });
    expect(findCall(env.fake.calls, 'PUT', '/api/')).toBeUndefined();
    expect(env.db.linksForJournal('1234')[0]!.rule_id).toBe('Coffee');
  });

  it('deletes the old entry and creates a new one when a different rule matches', async () => {
    const env = makeEnv();
    await storeMeal(env); // meal entry 1 for rule "Indian Garden"

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { destination_name: 'Starbucks #7' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 updated=0 created=1 deleted=1');
    expect(findCall(env.fake.calls, 'DELETE', '/api/food-entry-meals/1')).toBeDefined();
    const post = findCall(env.fake.calls, 'POST', '/api/food-entries');
    expect(post!.body).toMatchObject({ food_id: 'food-latte', source_id: '1234' });

    const links = env.db.linksForJournal('1234');
    expect(links).toHaveLength(1);
    expect(links[0]!.rule_id).toBe('Coffee');
    expect(links[0]!.kind).toBe('food');
  });

  it('deletes the linked entry when no rule matches anymore', async () => {
    const env = makeEnv();
    await storeMeal(env);

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { destination_name: 'Nowhere Else' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 updated=0 created=0 deleted=1');
    expect(findCall(env.fake.calls, 'DELETE', '/api/food-entry-meals/1')).toBeDefined();
    expect(env.db.linksForJournal('1234')).toHaveLength(0);
  });

  it('treats a newly added skip tag as "no match" and deletes the entry', async () => {
    const env = makeEnv();
    await storeMeal(env);

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { tags: ['lunch', 'no-sparky'] }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 updated=0 created=0 deleted=1');
    expect(findCall(env.fake.calls, 'DELETE', '/api/food-entry-meals/1')).toBeDefined();
    expect(env.db.linksForJournal('1234')).toHaveLength(0);
  });

  it('does nothing for a journal with no links and no match', async () => {
    const env = makeEnv();
    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { destination_name: 'Nowhere Else' }));
    await env.processor.process(id);

    expect(env.fake.calls).toHaveLength(0);
    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 updated=0 created=0 deleted=0 (journal 1234 no changes)');
  });

  it('re-creates a meal when SparkyFitness no longer knows the entry (PUT 404)', async () => {
    const env = makeEnv();
    await storeMeal(env);
    env.fake.intercept = (call) =>
      call.method === 'PUT' ? new Response('nope', { status: 404 }) : undefined;

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }, { date: '2026-10-25T13:05:00Z' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.status).toBe('succeeded');
    const posts = env.fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/food-entry-meals');
    expect(posts).toHaveLength(2); // original + re-created
    const link = env.db.linksForJournal('1234')[0]!;
    expect(link.sparky_entry_id).toBe('3'); // id of the re-created entry
  });

  it('re-creates a meal link that has no recorded entry id', async () => {
    const env = makeEnv();
    env.db.upsertLink({ journalId: '1234', ruleId: 'Indian Garden', kind: 'meal', sparkyEntryId: null, eventId: null });

    const id = env.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.status).toBe('succeeded');
    expect(env.fake.calls).toHaveLength(1);
    expect(env.fake.calls[0]!.method).toBe('POST');
    expect(env.db.linksForJournal('1234')[0]!.sparky_entry_id).toBe('1');
  });

  it('replaces the entry when the rule action type changed (meal → food, same rule name)', async () => {
    const mealRules = {
      rules: [
        {
          name: 'IG',
          match: { type: 'withdrawal', destination: 'Indian Garden' },
          action: { log: 'meal', meal_template_id: 'meal-tikka', meal_type: 'lunch', quantity: 1, unit: 'serving' },
        },
      ],
    };
    const foodRules = {
      rules: [
        {
          name: 'IG',
          match: { type: 'withdrawal', destination: 'Indian Garden' },
          action: { log: 'food', food_id: 'food-tikka', meal_type: 'lunch', quantity: 1, unit: 'serving' },
        },
      ],
    };
    // Same database, two rulesets: simulates the rules file being reloaded
    // between the STORE and the UPDATE.
    const before = makeEnv({ rules: mealRules });
    const after = makeEnv({ rules: foodRules, db: before.db, fake: before.fake });

    const storeId = before.insert(buildPayload({ uuid: 'uuid-store' }));
    await before.processor.process(storeId);
    expect(before.db.linksForJournal('1234')[0]!.kind).toBe('meal');

    const id = after.insert(buildPayload({ uuid: 'uuid-upd', trigger: 'UPDATE_TRANSACTION' }));
    await after.processor.process(id);

    expect(after.db.getEvent(id)!.result_summary).toBe('splits=1 updated=0 created=1 deleted=1');
    expect(findCall(before.fake.calls, 'DELETE', '/api/food-entry-meals/1')).toBeDefined();
    expect(findCall(before.fake.calls, 'POST', '/api/food-entries')!.body).toMatchObject({ food_id: 'food-tikka' });
    const link = after.db.linksForJournal('1234')[0]!;
    expect(link.kind).toBe('food');
    expect(link.rule_id).toBe('IG');
  });
});

describe('processEvent: DESTROY_TRANSACTION', () => {
  it('deletes the linked entry and drops the link', async () => {
    const env = makeEnv();
    await storeMeal(env);

    const id = env.insert(buildPayload({ uuid: 'uuid-destroy', trigger: 'DESTROY_TRANSACTION' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.status).toBe('succeeded');
    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 deleted=1');
    expect(findCall(env.fake.calls, 'DELETE', '/api/food-entry-meals/1')).toBeDefined();
    expect(env.db.linksForJournal('1234')).toHaveLength(0);
  });

  it('does nothing when the journal has no links', async () => {
    const env = makeEnv();
    const id = env.insert(buildPayload({ uuid: 'uuid-destroy', trigger: 'DESTROY_TRANSACTION' }));
    await env.processor.process(id);

    expect(env.fake.calls).toHaveLength(0);
    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 deleted=0 (journal 1234 no links)');
  });

  it('deletes every item of a multi-food rule', async () => {
    const env = makeEnv({
      rules: {
        rules: [
          {
            name: 'Lunch combo',
            match: { type: 'withdrawal', destination: 'Bento Box' },
            action: {
              log: 'foods',
              foods: [
                { food_id: 'food-rice', quantity: 1 },
                { food_id: 'food-chicken', quantity: 2, unit: 'piece' },
              ],
              meal_type: 'lunch',
              quantity: 1,
              unit: 'serving',
            },
          },
        ],
      },
    });
    const storeId = env.insert(buildPayload({ uuid: 'uuid-store' }, { destination_name: 'Bento Box' }));
    await env.processor.process(storeId);
    expect(env.db.linksForJournal('1234')).toHaveLength(2);
    const entryIds = env.db.linksForJournal('1234').map((l) => l.sparky_entry_id).sort();
    expect(entryIds).toEqual(['1', '2']);

    const id = env.insert(buildPayload({ uuid: 'uuid-destroy', trigger: 'DESTROY_TRANSACTION' }, { destination_name: 'Bento Box' }));
    await env.processor.process(id);

    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 deleted=2');
    expect(findCall(env.fake.calls, 'DELETE', '/api/food-entries/1')).toBeDefined();
    expect(findCall(env.fake.calls, 'DELETE', '/api/food-entries/2')).toBeDefined();
    expect(env.db.linksForJournal('1234')).toHaveLength(0);
  });

  it('keeps the link when the remote delete fails, and succeeds on retry', async () => {
    const env = makeEnv();
    await storeMeal(env);

    env.fake.failNext = 1; // the DELETE fails
    const id = env.insert(buildPayload({ uuid: 'uuid-destroy', trigger: 'DESTROY_TRANSACTION' }));
    await expect(env.processor.process(id)).rejects.toBeInstanceOf(RetryLater);
    expect(env.db.getEvent(id)!.status).toBe('failed');
    expect(env.db.linksForJournal('1234')).toHaveLength(1); // link kept for the retry

    await env.processor.process(id);
    expect(env.db.getEvent(id)!.status).toBe('succeeded');
    expect(env.db.getEvent(id)!.result_summary).toBe('splits=1 deleted=1');
    expect(env.db.linksForJournal('1234')).toHaveLength(0);
    expect(env.fake.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2); // failed + retry
  });
});

describe('processEvent: dry-run lifecycle', () => {
  it('never calls SparkyFitness and never touches the links', async () => {
    const live = makeEnv();
    await storeMeal(live);
    expect(live.db.linksForJournal('1234')).toHaveLength(1);

    const dry = makeEnv({ dryRun: true, db: live.db, fake: live.fake });

    const updId = dry.insert(buildPayload({ uuid: 'uuid-dry-upd', trigger: 'UPDATE_TRANSACTION' }, { date: '2026-10-25T13:05:00Z' }));
    await dry.processor.process(updId);
    expect(dry.db.getEvent(updId)!.result_summary).toContain('dry_run');
    expect(dry.db.getEvent(updId)!.result_summary).toContain('would change ×1');
    expect(live.db.linksForJournal('1234')[0]!.sparky_entry_id).toBe('1'); // untouched

    const delId = dry.insert(buildPayload({ uuid: 'uuid-dry-destroy', trigger: 'DESTROY_TRANSACTION' }));
    await dry.processor.process(delId);
    expect(dry.db.getEvent(delId)!.result_summary).toContain('would delete ×1');
    expect(live.db.linksForJournal('1234')).toHaveLength(1); // still there
    expect(live.fake.calls).toHaveLength(1); // only the original STORE

    const log = dry.db.logForEvent(delId).map((l) => l.message).join('\n');
    expect(log).toContain('would delete meal entry 1 (rule "Indian Garden")');
  });
});
