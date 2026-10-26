import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventQueue } from '../src/core/queue.js';
import { EventProcessor } from '../src/core/processEvent.js';
import { buildApp } from '../src/web/server.js';
import { importRulesFileIfFirstTime } from '../src/rules/importFile.js';
import { makeRegistry, makeDb, makeSparky, fakeSparky, testConfig, waitFor, type SparkyCall } from './helpers.js';

interface Stack {
  dispose(): Promise<void>;
  app: ReturnType<typeof buildApp>;
  db: ReturnType<typeof makeDb>;
  fake: ReturnType<typeof fakeSparky>;
  registry: ReturnType<typeof makeRegistry>;
}

const stacks: Stack[] = [];

function startStack(overrides: Parameters<typeof testConfig>[0] = {}, rules: unknown = {}): Stack {
  const cfg = testConfig(overrides);
  const db = makeDb();
  const fake = fakeSparky();
  const registry = makeRegistry(db, rules);
  const sparky = cfg.dryRun ? null : makeSparky(cfg, fake);
  const processor = new EventProcessor({
    db,
    cfg,
    sparky,
    registry,
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const queue = new EventQueue({
    logger: { info() {}, warn() {}, error() {} } as never,
    maxDelayMs: cfg.retry.maxDelayMs,
    process: (id) => processor.process(id),
  });
  const app = buildApp({ cfg, db, queue, processor, registry, sparky, importedFrom: null });
  const stack: Stack = {
    app,
    db,
    fake,
    registry,
    async dispose() {
      await queue.stop();
      await app.close();
      db.close();
    },
  };
  stacks.push(stack);
  return stack;
}

afterAll(async () => {
  for (const s of stacks) await s.dispose();
});

const AUTH = undefined; // no ADMIN_PASSWORD in these tests

async function postRuleForm(app: Stack['app'], fields: Record<string, string>): Promise<any> {
  const payload = new URLSearchParams(fields).toString();
  return app.inject({
    method: 'POST',
    url: '/rules',
    payload,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

describe('rule editor pages', () => {
  it('GET /rules lists rules with edit/delete/reorder actions', async () => {
    const stack = startStack();
    const res = await stack.app.inject({ method: 'GET', url: '/rules' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('No rules yet');

    stack.db.insertRule({
      name: 'Cafe',
      match: { destination: 'cafe' },
      action: { log: 'food', food_id: 'f1', meal_type: 'snacks', quantity: 1, unit: 'serving' },
      cont: false,
      position: 1,
    });
    stack.registry.reload();
    const res2 = await stack.app.inject({ method: 'GET', url: '/rules' });
    expect(res2.payload).toContain('Cafe');
    expect(res2.payload).toContain('/rules/1/edit');
    expect(res2.payload).toContain('/rules/1/delete');
    expect(res2.payload).toContain('/rules/1/move');
  });

  it('GET /rules/new?event= pre-fills the match from the stored transaction', async () => {
    const stack = startStack();
    const { id } = stack.db.insertEvent({
      uuid: 'prefill-1',
      trigger: 'STORE_TRANSACTION',
      rawJson: JSON.stringify({
        uuid: 'prefill-1',
        trigger: 'STORE_TRANSACTION',
        content: {
          id: 1,
          group_title: null,
          transactions: [
            {
              transaction_journal_id: 77,
              type: 'withdrawal',
              date: '2026-10-25T12:41:00Z',
              amount: '14.50',
              currency_code: 'EUR',
              description: 'Indian Garden',
              source_name: 'Checking',
              destination_name: 'Indian Garden',
              category_name: 'Eating out',
              budget_name: 'Food',
              tags: [],
              notes: null,
            },
          ],
        },
      }),
    });
    const res = await stack.app.inject({ method: 'GET', url: `/rules/new?event=${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('name="destination" value="Indian Garden"');
    expect(res.payload).toContain('value="withdrawal"');
    // Narrower fields are offered as suggestions, not pre-filled, so the
    // rule keeps matching the place rather than this one transaction.
    expect(res.payload).toContain('name="currency" value=""');
    expect(res.payload).toContain('name="category" value=""');
    expect(res.payload).toContain('data-fill="category" data-value="Eating out"');
    expect(res.payload).toContain('data-fill="currency" data-value="EUR"');
    expect(res.payload).toContain('new rule from this transaction' === 'x' ? 'x' : 'from transaction');

    const missing = await stack.app.inject({ method: 'GET', url: '/rules/new?event=999' });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /rules creates a rule from the form and redirects', async () => {
    const stack = startStack();
    const res = await postRuleForm(stack.app, {
      name: 'Indian Garden',
      type: 'withdrawal',
      destination: 'Indian Garden',
      currency: 'EUR',
      log: 'meal',
      meal_template_id: 'meal-tikka',
      meal_type: 'auto',
      quantity: '1',
      unit: 'serving',
      note: '{{description}} – {{amount}} {{currency}}',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/rules');
    const rows = stack.db.listRules();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.action_json)).toMatchObject({ log: 'meal', meal_template_id: 'meal-tikka' });
    expect(JSON.parse(rows[0]!.match_json)).toEqual({ type: 'withdrawal', destination: 'Indian Garden', currency: 'EUR' });
  });

  it('rejects a broken form with 422 and the field errors', async () => {
    const stack = startStack();
    const res = await postRuleForm(stack.app, {
      name: 'Broken',
      log: 'meal', // no meal_template_id
      meal_type: 'auto',
      quantity: '1',
      unit: 'serving',
    });
    expect(res.statusCode).toBe(422);
    expect(res.payload).toContain('Could not save the rule');
    expect(res.payload).toContain('meal_template_id is missing');
    expect(stack.db.countRules()).toBe(0);

    const badTime = await postRuleForm(stack.app, {
      name: 'BadTime',
      time_from: '11:00',
      log: 'food',
      food_id: 'f',
      meal_type: 'lunch',
      quantity: '1',
      unit: 'serving',
    });
    expect(badTime.statusCode).toBe(422);
    expect(badTime.payload).toContain('needs both a "from" and a "to"');
  });

  it('POST /rules/:id updates and POST /rules/:id/delete removes', async () => {
    const stack = startStack();
    stack.db.insertRule({
      name: 'Old',
      match: { destination: 'old' },
      action: { log: 'food', food_id: 'f', meal_type: 'lunch', quantity: 1, unit: 'serving' },
      cont: false,
      position: 1,
    });
    stack.registry.reload();

    const upd = await stack.app.inject({
      method: 'POST',
      url: '/rules/1',
      payload: new URLSearchParams({
        name: 'New Name',
        destination: 'new',
        log: 'food',
        food_id: 'f2',
        meal_type: 'lunch',
        quantity: '2',
        unit: 'serving',
      }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(upd.statusCode).toBe(302);
    expect(stack.db.getRule(1)!.name).toBe('New Name');
    expect(JSON.parse(stack.db.getRule(1)!.match_json)).toEqual({ destination: 'new' });
    expect(stack.registry.compiled.rules[0]!.name).toBe('New Name'); // registry reloaded

    const del = await stack.app.inject({ method: 'POST', url: '/rules/1/delete' });
    expect(del.statusCode).toBe(302);
    expect(stack.db.countRules()).toBe(0);

    const delMissing = await stack.app.inject({ method: 'POST', url: '/rules/9/delete' });
    expect(delMissing.statusCode).toBe(404);
  });

  it('POST /rules/:id/move reorders', async () => {
    const stack = startStack();
    for (const [i, name] of ['A', 'B', 'C'].entries()) {
      stack.db.insertRule({ name, match: {}, action: { log: 'food', food_id: `f${i}`, meal_type: 'lunch', quantity: 1, unit: 'serving' }, cont: false, position: i + 1 });
    }
    stack.registry.reload();
    const res = await stack.app.inject({
      method: 'POST',
      url: '/rules/3/move',
      payload: new URLSearchParams({ dir: 'up' }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(302);
    expect(stack.registry.compiled.rules.map((r) => r.name)).toEqual(['A', 'C', 'B']);
  });
});

describe('programmatic rule API', () => {
  it('creates, updates and deletes rules as JSON', async () => {
    const stack = startStack();
    const created = await stack.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        name: 'API rule',
        match: { destination: 'api' },
        action: { log: 'food', food_id: 'fx', meal_type: 'lunch', quantity: 1, unit: 'serving' },
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(created.statusCode).toBe(201);

    const bad = await stack.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { name: 'Bad', match: {}, action: { log: 'meal', meal_type: 'lunch', quantity: 1, unit: 'serving' } },
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details[0]).toContain('meal_template_id');

    const dup = await stack.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: { name: 'API rule', match: {}, action: { log: 'food', food_id: 'fx', meal_type: 'lunch', quantity: 1, unit: 'serving' } },
      headers: { 'content-type': 'application/json' },
    });
    expect(dup.statusCode).toBe(409);

    const id = created.json().id as number;
    const list = await stack.app.inject({ method: 'GET', url: '/api/rules' });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].name).toBe('API rule');

    const updated = await stack.app.inject({
      method: 'PUT',
      url: `/api/rules/${id}`,
      payload: { name: 'API rule v2', match: { destination: 'api2' }, action: { log: 'food', food_id: 'fx', meal_type: 'dinner', quantity: 2, unit: 'serving' } },
      headers: { 'content-type': 'application/json' },
    });
    expect(updated.statusCode).toBe(200);
    expect(stack.registry.compiled.rules[0]!.name).toBe('API rule v2');

    const del = await stack.app.inject({ method: 'DELETE', url: `/api/rules/${id}` });
    expect(del.statusCode).toBe(204);
    expect(stack.db.countRules()).toBe(0);
  });

  it('end-to-end: a rule created via the API immediately drives the webhook', async () => {
    const stack = startStack();
    await stack.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: {
        name: 'Live rule',
        match: { destination: 'Live Kitchen' },
        action: { log: 'meal', meal_template_id: 'meal-live', meal_type: 'auto', quantity: 1, unit: 'serving' },
      },
      headers: { 'content-type': 'application/json' },
    });

    const { signHeader } = await import('../src/firefly/signature.js');
    const body = JSON.stringify({
      uuid: 'e2e-1',
      trigger: 'STORE_TRANSACTION',
      content: {
        id: 1,
        group_title: null,
        transactions: [
          {
            transaction_journal_id: 42,
            type: 'withdrawal',
            date: '2026-10-25T12:41:00Z',
            amount: '10.00',
            currency_code: 'EUR',
            description: 'Live Kitchen',
            source_name: 'Checking',
            destination_name: 'Live Kitchen',
            category_name: null,
            budget_name: null,
            tags: [],
            notes: null,
          },
        ],
      },
    });
    const res = await stack.app.inject({
      method: 'POST',
      url: '/hooks/firefly',
      payload: body,
      headers: { 'content-type': 'application/json', signature: signHeader('test-secret', body) },
    });
    expect(res.statusCode).toBe(202);
    const eventId = res.json().event_id as number;
    await waitFor(() => stack.db.getEvent(eventId)!.status === 'succeeded', 'event to succeed');
    expect(stack.fake.calls[0]!.path).toBe('/api/food-entry-meals');
    expect(stack.db.linksForJournal('42')[0]!.rule_id).toBe('Live rule');
  });
});

describe('event page (dry-run tester + activity log)', () => {
  it('shows the live dry-run plan and the log without side effects', async () => {
    const stack = startStack(undefined, {
      rules: [
        {
          name: 'IG',
          match: { destination: 'Indian Garden' },
          action: { log: 'meal', meal_template_id: 'meal-tikka', meal_type: 'lunch', quantity: 1, unit: 'serving' },
        },
      ],
    });
    const { id } = stack.db.insertEvent({
      uuid: 'dry-1',
      trigger: 'STORE_TRANSACTION',
      rawJson: JSON.stringify({
        uuid: 'dry-1',
        trigger: 'STORE_TRANSACTION',
        content: {
          id: 1,
          group_title: null,
          transactions: [
            {
              transaction_journal_id: 55,
              type: 'withdrawal',
              date: '2026-10-25T12:41:00Z',
              amount: '14.50',
              currency_code: 'EUR',
              description: 'Indian Garden',
              source_name: 'Checking',
              destination_name: 'Indian Garden',
              category_name: null,
              budget_name: null,
              tags: [],
              notes: null,
            },
          ],
        },
      }),
    });
    stack.db.addLog(id, 'info', 'some log line');

    const res = await stack.app.inject({ method: 'GET', url: `/events/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('would log');
    expect(res.payload).toContain('meal meal-tikka');
    expect(res.payload).toContain('some log line');
    expect(res.payload).toContain('new rule from this transaction');
    // No side effects from the dry run:
    expect(stack.fake.calls).toHaveLength(0);
    expect(stack.db.linksForJournal('55')).toHaveLength(0);
    expect(stack.db.getEvent(id)!.status).toBe('pending');
  });
});

describe('SparkyFitness lookups', () => {
  it('proxies meals/foods search through the API key', async () => {
    const stack = startStack();
    stack.fake.intercept = (call: SparkyCall) => {
      if (call.path.startsWith('/api/meals/search')) {
        return new Response(JSON.stringify([{ id: 'm-1', name: 'Tikka Masala' }]), { status: 200 });
      }
      if (call.path.startsWith('/api/foods/search')) {
        return new Response(JSON.stringify([{ id: 'f-1', name: 'Latte', variants: [{ id: 'v-1', name: 'flat white' }] }]), { status: 200 });
      }
      if (call.path === '/api/meal-types') {
        return new Response(JSON.stringify([{ id: '1', name: 'lunch' }]), { status: 200 });
      }
      return undefined;
    };

    const meals = await stack.app.inject({ method: 'GET', url: '/api/sparky/meals?q=tikka' });
    expect(meals.statusCode).toBe(200);
    expect(meals.json()).toEqual([{ id: 'm-1', name: 'Tikka Masala' }]);
    expect(stack.fake.calls.find((c) => c.path.startsWith('/api/meals/search'))!.path).toContain('searchTerm=tikka');

    const foods = await stack.app.inject({ method: 'GET', url: '/api/sparky/foods?q=latte' });
    expect(foods.json()[0].variants).toEqual([{ id: 'v-1', name: 'flat white' }]);

    const types = await stack.app.inject({ method: 'GET', url: '/api/sparky/meal-types' });
    expect(types.json()).toEqual([{ id: '1', name: 'lunch' }]);

    const unknown = await stack.app.inject({ method: 'GET', url: '/api/sparky/bogus' });
    expect(unknown.statusCode).toBe(400);
  });

  it('returns 503 when SparkyFitness is not configured (dry run)', async () => {
    const stack = startStack({ dryRun: true });
    const res = await stack.app.inject({ method: 'GET', url: '/api/sparky/meals?q=x' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('not configured');
  });

  it('surfaces SparkyFitness failures as 502', async () => {
    const stack = startStack();
    stack.fake.failNext = 1;
    const res = await stack.app.inject({ method: 'GET', url: '/api/sparky/foods?q=x' });
    expect(res.statusCode).toBe(502);
  });
});

describe('YAML first-start import', () => {
  it('imports once, never re-imports (not even after the rules are deleted)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkfly-import-'));
    const file = path.join(dir, 'rules.yaml');
    fs.writeFileSync(
      file,
      [
        'rules:',
        '  - name: From File',
        '    match: { destination: "file place" }',
        '    action: { log: food, food_id: ff, meal_type: lunch, quantity: 1, unit: serving }',
        '  - name: Second',
        '    match: { destination: "else" }',
        '    action: { log: meal, meal_template_id: mm, meal_type: auto, quantity: 1, unit: serving }',
      ].join('\n'),
    );
    const db = makeDb();
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;

    const first = importRulesFileIfFirstTime(db, file, logger);
    expect(first.imported).toBe(2);
    expect(db.countRules()).toBe(2);
    expect(db.listRules().map((r) => r.name)).toEqual(['From File', 'Second']);

    const second = importRulesFileIfFirstTime(db, file, logger);
    expect(second.imported).toBe(0);

    // User deletes all rules in the UI — a restart must not re-import.
    for (const row of db.listRules()) db.deleteRule(row.id);
    expect(db.countRules()).toBe(0);
    const third = importRulesFileIfFirstTime(db, file, logger);
    expect(third.imported).toBe(0);
    expect(db.countRules()).toBe(0);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when the file does not exist and rules are empty', () => {
    const db = makeDb();
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
    const res = importRulesFileIfFirstTime(db, '/nonexistent/rules.yaml', logger);
    expect(res.imported).toBe(0);
    expect(db.countRules()).toBe(0);
    db.close();
  });

  void AUTH;
});
