import { afterAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { EventQueue } from '../src/core/queue.js';
import { EventProcessor } from '../src/core/processEvent.js';
import { Notifier } from '../src/core/notify.js';
import { checkRange } from '../src/core/backfill.js';
import { FireflyClient, groupFromApi, webhookFromApi } from '../src/firefly/client.js';
import { saveFilters } from '../src/rules/webhookFilters.js';
import { buildApp, SETTING_WEBHOOK_SECRET } from '../src/web/server.js';
import {
  RULES_FILE,
  buildPayload,
  fakeSparky,
  makeDb,
  makeRegistry,
  makeSparky,
  signedHeaders,
  testConfig,
  waitFor,
} from './helpers.js';

const silent = pino({ level: 'silent' });

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Records every request; `respond` decides the answer. */
function recorder(respond: (c: Call) => Response = () => new Response('{}', { status: 200 })) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchImpl };
}

const split = (id: number, destination: string, extra: Record<string, unknown> = {}) => ({
  transaction_journal_id: String(id),
  type: 'withdrawal',
  date: '2026-09-10T12:30:00+00:00',
  amount: '14.50',
  currency_code: 'EUR',
  description: destination,
  source_name: 'Checking',
  destination_name: destination,
  category_name: null,
  budget_name: 'Food',
  tags: [],
  notes: null,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json' } });

/** A fake Firefly API: two pages of transactions and a webhook list. */
function fakeFirefly() {
  const webhooks: unknown[] = [];
  const rec = recorder((c) => {
    const u = new URL(c.url);
    if (u.pathname === '/api/v1/transactions') {
      const page = Number(u.searchParams.get('page'));
      const data =
        page === 1
          ? [
              { type: 'transactions', id: '501', attributes: { group_title: null, transactions: [split(9001, 'Indian Garden')] } },
              { type: 'transactions', id: '502', attributes: { group_title: null, transactions: [split(9002, 'Landlord')] } },
            ]
          : [
              { type: 'transactions', id: '503', attributes: { group_title: null, transactions: [split(9003, 'Costa')] } },
              { type: 'transactions', id: '504', attributes: { group_title: null, transactions: [{ broken: true }] } },
            ];
      return json({ data, meta: { pagination: { total: 4, current_page: page, total_pages: 2 } } });
    }
    if (u.pathname === '/api/v1/webhooks' && c.method === 'GET') return json({ data: webhooks });
    if (u.pathname === '/api/v1/webhooks' && c.method === 'POST') {
      const body = JSON.parse(c.body) as Record<string, unknown>;
      const item = { type: 'webhooks', id: '7', attributes: { ...body, secret: 'firefly-generated-secret' } };
      webhooks.push(item);
      return json({ data: item });
    }
    return json({ message: 'not found' }, 404);
  });
  const client = new FireflyClient({ baseUrl: 'http://firefly.test', pat: 'pat-123', timeoutMs: 1000, logger: silent }, rec.fetchImpl);
  return { ...rec, client, webhooks };
}

interface Stack {
  app: ReturnType<typeof buildApp>;
  db: ReturnType<typeof makeDb>;
  sparky: ReturnType<typeof fakeSparky>;
  firefly: ReturnType<typeof fakeFirefly>;
  notes: ReturnType<typeof recorder>;
  dispose(): Promise<void>;
}

const stacks: Stack[] = [];

function startStack(overrides: Parameters<typeof testConfig>[0] = {}, opts: { firefly?: boolean } = {}): Stack {
  const cfg = testConfig({
    notify: { url: 'http://notify.test/hook', format: 'json', on: new Set(['dead', 'needs-rule']) },
    publicUrl: 'https://sparkfly.example',
    ...overrides,
  });
  const db = makeDb();
  const sparky = fakeSparky();
  const registry = makeRegistry(db, RULES_FILE);
  const notes = recorder();
  const notifier = new Notifier({ cfg, logger: silent }, notes.fetchImpl);
  const client = cfg.dryRun ? null : makeSparky(cfg, sparky);
  const processor = new EventProcessor({ db, cfg, sparky: client, registry, notifier, logger: silent });
  const queue = new EventQueue({ logger: silent, maxDelayMs: cfg.retry.maxDelayMs, process: (id) => processor.process(id) });
  const firefly = fakeFirefly();
  const app = buildApp({
    cfg,
    db,
    queue,
    processor,
    registry,
    sparky: client,
    importedFrom: null,
    firefly: opts.firefly === false ? null : firefly.client,
    notifier,
  });
  const stack: Stack = {
    app,
    db,
    sparky,
    firefly,
    notes,
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

const form = (fields: Record<string, string>) => ({
  payload: new URLSearchParams(fields).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

describe('Firefly API client', () => {
  it('parses transaction groups and skips invalid splits', () => {
    const g = groupFromApi({ id: '5', attributes: { group_title: 'Trip', transactions: [split(1, 'A'), { nope: 1 }] } });
    expect(g).toMatchObject({ id: '5', groupTitle: 'Trip', invalid: 1 });
    expect(g.splits).toHaveLength(1);
    expect(g.splits[0]?.destination_name).toBe('A');
  });

  it('reads both the array and the legacy single-trigger webhook formats', () => {
    expect(webhookFromApi({ id: 1, attributes: { title: 'a', url: 'u', triggers: ['STORE_TRANSACTION', 'UPDATE_TRANSACTION'] } }).triggers)
      .toEqual(['STORE_TRANSACTION', 'UPDATE_TRANSACTION']);
    expect(webhookFromApi({ id: 2, attributes: { title: 'b', url: 'u', trigger: 'STORE_TRANSACTION', active: false } }))
      .toMatchObject({ id: '2', triggers: ['STORE_TRANSACTION'], active: false });
  });

  it('sends the PAT and asks for all three triggers on registration', async () => {
    const ff = fakeFirefly();
    const res = await ff.client.registerWebhook({ title: 'Sparkfly', url: 'http://sparkfly:8080/hooks/firefly' });
    expect(res.secret).toBe('firefly-generated-secret');
    const call = ff.calls.at(-1)!;
    expect(call.headers.authorization).toBe('Bearer pat-123');
    const body = JSON.parse(call.body);
    expect(body.triggers).toEqual(['STORE_TRANSACTION', 'UPDATE_TRANSACTION', 'DESTROY_TRANSACTION']);
    expect(body).toMatchObject({ responses: ['TRANSACTIONS'], deliveries: ['JSON'], url: 'http://sparkfly:8080/hooks/firefly' });
  });

  it('turns API errors into FireflyError with the status', async () => {
    const rec = recorder(() => new Response('{"message":"Unauthenticated."}', { status: 401 }));
    const c = new FireflyClient({ baseUrl: 'http://ff', pat: 'x', timeoutMs: 1000, logger: silent }, rec.fetchImpl);
    await expect(c.listWebhooks()).rejects.toThrow(/Firefly API 401/);
  });
});

describe('setup page', () => {
  it('explains the env vars when the Firefly API is not configured', async () => {
    const s = startStack({}, { firefly: false });
    const res = await s.app.inject({ method: 'GET', url: '/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('FIREFLY_PAT');
    expect(res.body).toContain('send a test notification');
    // The notification URL path may contain a token: it is not shown.
    expect(res.body).not.toContain('notify.test/hook');
  });

  it('registers the webhook and then verifies deliveries with the returned secret', async () => {
    const s = startStack({ fireflyWebhookSecret: undefined });
    const before = await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(before.statusCode).toBe(503);

    const res = await s.app.inject({ method: 'POST', url: '/setup/webhook', ...form({ url: 'http://sparkfly:8080/hooks/firefly' }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Registered webhook #7');
    expect(s.db.getSetting(SETTING_WEBHOOK_SECRET)).toBe('firefly-generated-secret');
    expect(res.body).toContain('this Sparkfly');

    const body = JSON.stringify(buildPayload({ uuid: 'after-register' }));
    const hook = await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders('firefly-generated-secret', body) });
    expect(hook.statusCode).toBe(202);
  });

  it('accepts both the env secret and a registered one', async () => {
    const s = startStack();
    s.db.setSetting(SETTING_WEBHOOK_SECRET, 'registered-secret');
    for (const [secret, uuid] of [['test-secret', 'env-1'], ['registered-secret', 'reg-1']] as const) {
      const body = JSON.stringify(buildPayload({ uuid }));
      const res = await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders(secret, body) });
      expect(res.statusCode).toBe(202);
    }
    const body = JSON.stringify(buildPayload({ uuid: 'bad' }));
    const res = await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders('wrong', body) });
    expect(res.statusCode).toBe(401);
  });

  it('defaults the webhook URL to SPARKFLY_PUBLIC_URL', async () => {
    const s = startStack();
    const res = await s.app.inject({ method: 'GET', url: '/setup' });
    expect(res.body).toContain('https://sparkfly.example/hooks/firefly');
  });

  it('rejects a non-http webhook URL', async () => {
    const s = startStack();
    const res = await s.app.inject({ method: 'POST', url: '/setup/webhook', ...form({ url: 'ftp://nope' }) });
    expect(res.statusCode).toBe(422);
    expect(s.firefly.webhooks).toHaveLength(0);
  });
});

describe('backfill', () => {
  it('validates the date range', () => {
    expect(checkRange('2026-01-01', '2026-01-31')).toBeNull();
    expect(checkRange('2026-02-01', '2026-01-31')).toMatch(/after/);
    expect(checkRange('yesterday', '2026-01-31')).toMatch(/start/);
  });

  it('previews without writing anything, across all pages', async () => {
    const s = startStack();
    const res = await s.app.inject({ method: 'POST', url: '/setup/backfill', ...form({ start: '2026-09-01', end: '2026-09-30', mode: 'preview' }) });
    expect(res.statusCode).toBe(200);
    expect(s.firefly.calls.filter((c) => c.url.includes('/transactions'))).toHaveLength(2);
    expect(res.body).toContain('log 2 transactions in SparkyFitness');
    expect(res.body).toContain('1 split(s) could not be read');
    expect(s.db.recentEvents(10)).toHaveLength(0);
    expect(s.sparky.calls).toHaveLength(0);
  });

  it('queues matching transactions once and logs them through the normal pipeline', async () => {
    const s = startStack();
    const res = await s.app.inject({ method: 'POST', url: '/setup/backfill', ...form({ start: '2026-09-01', end: '2026-09-30', mode: 'run' }) });
    expect(res.body).toContain('Queued 2 transactions');
    await waitFor(() => s.db.recentEvents(10).every((e) => e.status === 'succeeded'), 'backfilled events processed');
    const events = s.db.recentEvents(10);
    expect(events.map((e) => e.uuid).sort()).toEqual(['backfill-501', 'backfill-503']);
    expect(s.db.linksForJournal('9001')[0]).toMatchObject({ kind: 'meal', rule_id: 'Indian Garden' });
    expect(s.db.linksForJournal('9003')[0]).toMatchObject({ kind: 'food', rule_id: 'Coffee' });
    const posts = s.sparky.calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);

    // Running it again finds everything already logged.
    const again = await s.app.inject({ method: 'POST', url: '/setup/backfill', ...form({ start: '2026-09-01', end: '2026-09-30', mode: 'run' }) });
    expect(again.body).toContain('Queued 0 transactions');
    expect(again.body).toContain('already logged');
    expect(s.db.recentEvents(10)).toHaveLength(2);
    // Backfill events never trigger needs-rule notifications.
    expect(s.notes.calls).toHaveLength(0);
  });

  it('skips transactions already logged from a webhook', async () => {
    const s = startStack();
    s.db.upsertLink({ journalId: '9001', ruleId: 'Indian Garden', kind: 'meal', sparkyEntryId: 'm-1', eventId: null });
    const res = await s.app.inject({ method: 'POST', url: '/setup/backfill', ...form({ start: '2026-09-01', end: '2026-09-30', mode: 'run' }) });
    expect(res.body).toContain('Queued 1 transaction.');
    await waitFor(() => s.db.recentEvents(10).every((e) => e.status === 'succeeded'), 'processed');
    expect(s.db.recentEvents(10).map((e) => e.uuid)).toEqual(['backfill-503']);
  });

  it('reports a bad range and a missing API', async () => {
    const s = startStack();
    const bad = await s.app.inject({ method: 'POST', url: '/setup/backfill', ...form({ start: '2026-10-01', end: '2026-09-01' }) });
    expect(bad.statusCode).toBe(422);
    const none = startStack({}, { firefly: false });
    const res = await none.app.inject({ method: 'POST', url: '/setup/backfill', ...form({ start: '2026-09-01', end: '2026-09-30' }) });
    expect(res.statusCode).toBe(503);
  });
});

describe('failure notifications', () => {
  it('sends a JSON notification with a link when an event goes dead', async () => {
    const s = startStack();
    s.sparky.failNext = 100;
    const body = JSON.stringify(buildPayload({ uuid: 'dies' }));
    await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders('test-secret', body) });
    await waitFor(() => s.notes.calls.length > 0, 'dead notification');
    const sent = JSON.parse(s.notes.calls[0]!.body);
    expect(sent).toMatchObject({ app: 'sparkfly', kind: 'dead', event_id: 1, url: 'https://sparkfly.example/events/1' });
    expect(sent.text).toContain('gave up after 3 attempts');
    expect(sent.content).toBe(sent.text);
  });

  it('notifies about visible transactions that need a rule, honouring filters', async () => {
    const s = startStack();
    saveFilters(s.db, [{ id: 1, name: 'landlord', mode: 'exclude', enabled: true, match: { destination: 'Landlord' } }]);
    for (const [uuid, dest] of [['rent', 'Landlord'], ['bakery', 'Bakery']] as const) {
      const body = JSON.stringify(buildPayload({ uuid }, { destination_name: dest, description: dest }));
      await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders('test-secret', body) });
    }
    await waitFor(() => s.db.recentEvents(10).every((e) => e.status === 'succeeded'), 'processed');
    await waitFor(() => s.notes.calls.length > 0, 'needs-rule notification');
    expect(s.notes.calls).toHaveLength(1);
    const sent = JSON.parse(s.notes.calls[0]!.body);
    expect(sent.kind).toBe('needs-rule');
    expect(sent.message).toContain('Bakery');
  });

  it('only notifies on the kinds listed in NOTIFY_ON', async () => {
    const s = startStack({ notify: { url: 'http://notify.test/hook', format: 'json', on: new Set(['dead']) } });
    const body = JSON.stringify(buildPayload({ uuid: 'nomatch' }, { destination_name: 'Bakery', description: 'Bakery' }));
    await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders('test-secret', body) });
    await waitFor(() => s.db.recentEvents(10).every((e) => e.status === 'succeeded'), 'processed');
    expect(s.notes.calls).toHaveLength(0);
  });

  it('speaks ntfy: plain-text body with title, priority and click headers', async () => {
    const rec = recorder();
    const n = new Notifier(
      { cfg: { notify: { url: 'https://ntfy.sh/topic', format: 'ntfy', on: new Set(['dead']) }, publicUrl: 'https://sf.example' }, logger: silent },
      rec.fetchImpl,
    );
    expect(await n.send({ kind: 'dead', title: 'Sparkfly: event #4 failed — €', message: 'boom', eventId: 4 })).toEqual({ ok: true });
    const call = rec.calls[0]!;
    expect(call.body).toBe('boom');
    expect(call.headers.priority).toBe('high');
    expect(call.headers.click).toBe('https://sf.example/events/4');
    expect(call.headers.title).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('never throws when the target fails, and the test button reports it', async () => {
    const rec = recorder(() => new Response('nope', { status: 500 }));
    const n = new Notifier({ cfg: { notify: { url: 'http://x', format: 'json', on: new Set(['dead']) }, publicUrl: undefined }, logger: silent }, rec.fetchImpl);
    expect(await n.send({ kind: 'dead', title: 't', message: 'm' })).toEqual({ ok: false, error: 'HTTP 500: nope' });

    const s = startStack();
    const res = await s.app.inject({ method: 'POST', url: '/setup/notify-test' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Test notification sent.');
    expect(JSON.parse(s.notes.calls[0]!.body).kind).toBe('test');
  });
});

describe('amount-based quantity in the rule editor', () => {
  it('saves, shows and clears quantity_from_amount', async () => {
    const s = startStack();
    const fields = { name: 'Pizza', destination: 'Pizza Place', log: 'food', food_id: 'food-pizza', meal_type: 'dinner', quantity: '1', unit: 'slice' };
    const created = await s.app.inject({ method: 'POST', url: '/rules', ...form({ ...fields, quantity_from_amount_per_unit: '3.5' }) });
    expect(created.statusCode).toBe(302);
    const row = s.db.findRuleByName('Pizza')!;
    expect(JSON.parse(row.action_json).quantity_from_amount).toEqual({ per_unit: 3.5 });

    const list = await s.app.inject({ method: 'GET', url: '/rules' });
    expect(list.body).toContain('qty = amount ÷ 3.5');
    const edit = await s.app.inject({ method: 'GET', url: `/rules/${row.id}/edit` });
    expect(edit.body).toMatch(/id="qty-from-amount" checked/);
    expect(edit.body).toContain('Price of one slice');

    // Unchecking the box disables the field, so the browser omits it.
    await s.app.inject({ method: 'POST', url: `/rules/${row.id}`, ...form(fields) });
    expect(JSON.parse(s.db.findRuleByName('Pizza')!.action_json).quantity_from_amount).toBeUndefined();
  });

  it('pre-fills the sample amount from the transaction', async () => {
    const s = startStack();
    const body = JSON.stringify(buildPayload({ uuid: 'sample' }, { amount: '29.00' }));
    await s.app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers: signedHeaders('test-secret', body) });
    const res = await s.app.inject({ method: 'GET', url: '/rules/new?event=1' });
    expect(res.body).toContain('id="qty-sample" value="29"');
  });
});

describe('milestone 4 config', () => {
  it('parses NOTIFY_* and SPARKFLY_PUBLIC_URL', async () => {
    const { loadConfig } = await import('../src/config.js');
    const cfg = loadConfig({ DRY_RUN: 'true', NOTIFY_URL: 'https://ntfy.sh/x', NOTIFY_FORMAT: 'NTFY', NOTIFY_ON: 'dead, needs-rule', SPARKFLY_PUBLIC_URL: 'https://sf.example/' });
    expect(cfg.notify).toEqual({ url: 'https://ntfy.sh/x', format: 'ntfy', on: new Set(['dead', 'needs-rule']) });
    expect(cfg.publicUrl).toBe('https://sf.example');
    expect(loadConfig({ DRY_RUN: 'true' }).notify.on).toEqual(new Set(['dead']));
    expect(() => loadConfig({ DRY_RUN: 'true', NOTIFY_ON: 'always' })).toThrow(/NOTIFY_ON/);
    expect(() => loadConfig({ DRY_RUN: 'true', NOTIFY_FORMAT: 'xml' })).toThrow(/NOTIFY_FORMAT/);
  });
});
