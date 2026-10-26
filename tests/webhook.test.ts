import { afterAll, describe, expect, it } from 'vitest';
import { EventQueue } from '../src/core/queue.js';
import { EventProcessor } from '../src/core/processEvent.js';
import { signBody } from '../src/firefly/signature.js';
import { buildApp } from '../src/web/server.js';
import {
  RULES_FILE,
  buildPayload,
  compileFile,
  fakeSparky,
  makeDb,
  makeSparky,
  signedHeaders,
  testConfig,
  waitFor,
} from './helpers.js';

interface Stack {
  dispose(): Promise<void>;
  app: ReturnType<typeof buildApp>;
  db: ReturnType<typeof makeDb>;
  fake: ReturnType<typeof fakeSparky>;
}

const stacks: Stack[] = [];

function startStack(overrides: Parameters<typeof testConfig>[0] = {}): Stack {
  const cfg = testConfig(overrides);
  const db = makeDb();
  const fake = fakeSparky();
  const processor = new EventProcessor({
    db,
    cfg,
    sparky: cfg.dryRun ? null : makeSparky(cfg, fake),
    compiled: compileFile(RULES_FILE),
    logger: { info() {}, warn() {}, error() {} } as never,
  });
  const queue = new EventQueue({
    logger: { info() {}, warn() {}, error() {} } as never,
    maxDelayMs: cfg.retry.maxDelayMs,
    process: (id) => processor.process(id),
  });
  const app = buildApp({ cfg, db, queue, processor, compiled: compileFile(RULES_FILE), rulesLoadedFrom: '/config/rules.yaml' });
  const stack: Stack = {
    app,
    db,
    fake,
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

const SECRET = 'test-secret';

async function postHook(app: Stack['app'], payload: unknown, opts: { secret?: string; signature?: string; header?: Record<string, string> } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.signature !== undefined) headers.signature = opts.signature;
  else if (opts.secret !== undefined) headers.signature = signedHeaders(opts.secret, body).signature;
  if (opts.header) Object.assign(headers, opts.header);
  return app.inject({ method: 'POST', url: '/hooks/firefly', payload: body, headers });
}

describe('POST /hooks/firefly', () => {
  it('accepts a signed delivery, replies 202, and logs the meal asynchronously', async () => {
    const stack = startStack();
    const payload = buildPayload();

    const res = await postHook(stack.app, payload, { secret: SECRET });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'queued' });
    const eventId = res.json().event_id as number;

    await waitFor(() => stack.db.getEvent(eventId)!.status === 'succeeded', 'event to succeed');
    const event = stack.db.getEvent(eventId)!;
    expect(event.result_summary).toBe('splits=1 logged=1');
    expect(stack.fake.calls).toHaveLength(1);
    expect(stack.fake.calls[0]!.path).toBe('/api/food-entry-meals');
  });

  it('is idempotent on the webhook uuid (Firefly redeliveries)', async () => {
    const stack = startStack();
    const payload = buildPayload();

    const first = await postHook(stack.app, payload, { secret: SECRET });
    expect(first.statusCode).toBe(202);
    const second = await postHook(stack.app, payload, { secret: SECRET });
    expect(second.statusCode).toBe(202);
    expect(second.json()).toMatchObject({ status: 'duplicate', event_id: first.json().event_id });

    await waitFor(() => stack.db.getEvent(first.json().event_id)!.status === 'succeeded', 'event to succeed');
    expect(stack.fake.calls).toHaveLength(1);
  });

  it('retries internally when SparkyFitness is down', async () => {
    const stack = startStack();
    stack.fake.failNext = 1;
    const payload = buildPayload();

    const res = await postHook(stack.app, payload, { secret: SECRET });
    expect(res.statusCode).toBe(202);
    const eventId = res.json().event_id as number;

    await waitFor(() => stack.db.getEvent(eventId)!.status === 'succeeded', 'event to succeed after retry');
    expect(stack.fake.calls).toHaveLength(2);
    expect(stack.db.getEvent(eventId)!.attempts).toBe(1);
  });

  it('rejects a bad signature with 401', async () => {
    const stack = startStack();
    const res = await postHook(stack.app, buildPayload(), { secret: 'wrong-secret' });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('signature mismatch');
    expect(stack.db.recentEvents(10)).toHaveLength(0);
  });

  it('rejects a stale timestamp with 401', async () => {
    const stack = startStack();
    const body = JSON.stringify(buildPayload());
    const stale = signBody(SECRET, body, Math.floor(Date.now() / 1000) - 9999);
    const res = await postHook(stack.app, JSON.parse(body), { signature: `t=${Math.floor(Date.now() / 1000) - 9999},v1=${stale}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toContain('timestamp');
  });

  it('rejects a missing signature with 401', async () => {
    const stack = startStack();
    const res = await postHook(stack.app, buildPayload(), { signature: undefined, header: { signature: '' } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 503 when no webhook secret is configured', async () => {
    const stack = startStack({ fireflyWebhookSecret: undefined });
    const res = await postHook(stack.app, buildPayload(), { secret: SECRET });
    expect(res.statusCode).toBe(503);
  });

  it('rejects an invalid payload with 400 (after signature is fine)', async () => {
    const stack = startStack();
    const res = await postHook(stack.app, { uuid: 'x', trigger: 'STORE_TRANSACTION' }, { secret: SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid payload');
  });

  it('rejects invalid JSON with 400', async () => {
    const stack = startStack();
    const res = await stack.app.inject({
      method: 'POST',
      url: '/hooks/firefly',
      payload: '{not json',
      headers: { ...signedHeaders(SECRET, '{not json') },
    });
    expect(res.statusCode).toBe(400);
  });

  it('processes UPDATE_TRANSACTION end-to-end (same rule → in-place update)', async () => {
    const stack = startStack();
    const store = await postHook(stack.app, buildPayload({ uuid: 'u-store' }), { secret: SECRET });
    const storeId = store.json().event_id as number;
    await waitFor(() => stack.db.getEvent(storeId)!.status === 'succeeded', 'store to succeed');

    const upd = await postHook(
      stack.app,
      buildPayload({ uuid: 'u-upd', trigger: 'UPDATE_TRANSACTION' }, { date: '2026-10-25T13:05:00Z', amount: '20.00' }),
      { secret: SECRET },
    );
    expect(upd.statusCode).toBe(202);
    const updId = upd.json().event_id as number;
    await waitFor(() => stack.db.getEvent(updId)!.status === 'succeeded', 'update to succeed');

    const event = stack.db.getEvent(updId)!;
    expect(event.result_summary).toBe('splits=1 updated=1 created=0 deleted=0');
    const put = stack.fake.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/food-entry-meals/1');
    expect(put?.body).toMatchObject({ entry_time: '13:05', quantity: 1 });
  });

  it('processes DESTROY_TRANSACTION end-to-end (deletes the linked entry)', async () => {
    const stack = startStack();
    const store = await postHook(stack.app, buildPayload({ uuid: 'u-store' }), { secret: SECRET });
    await waitFor(() => stack.db.getEvent(store.json().event_id as number)!.status === 'succeeded', 'store to succeed');
    expect(stack.fake.calls).toHaveLength(1);

    const del = await postHook(stack.app, buildPayload({ uuid: 'u-del', trigger: 'DESTROY_TRANSACTION' }), { secret: SECRET });
    expect(del.statusCode).toBe(202);
    const delId = del.json().event_id as number;
    await waitFor(() => stack.db.getEvent(delId)!.status === 'succeeded', 'destroy to succeed');

    expect(stack.db.getEvent(delId)!.result_summary).toBe('splits=1 deleted=1');
    const delCall = stack.fake.calls.find((c) => c.method === 'DELETE');
    expect(delCall?.path).toBe('/api/food-entry-meals/1');
    expect(stack.db.linksForJournal('1234')).toHaveLength(0);
  });

  it('re-queues a dead event via POST /events/:id/retry', async () => {
    const stack = startStack();
    stack.fake.failNext = 3; // exhaust the retry budget (maxAttempts = 3)
    const res = await postHook(stack.app, buildPayload({ uuid: 'u-dead' }), { secret: SECRET });
    const eventId = res.json().event_id as number;
    await waitFor(() => stack.db.getEvent(eventId)!.status === 'dead', 'event to go dead');

    const retry = await stack.app.inject({ method: 'POST', url: `/events/${eventId}/retry` });
    expect(retry.statusCode).toBe(302);
    expect(retry.headers.location).toBe('/');

    await waitFor(() => stack.db.getEvent(eventId)!.status === 'succeeded', 'event to succeed after manual retry');
    expect(stack.db.getEvent(eventId)!.attempts).toBe(0);
    expect(stack.fake.calls).toHaveLength(4); // 3 failed + 1 after the manual retry
  });

  it('guards the retry route with basic auth and rejects non-dead events', async () => {
    const stack = startStack({ adminPassword: 'hunter2' });
    const res = await postHook(stack.app, buildPayload({ uuid: 'u-auth' }), { secret: SECRET });
    const eventId = res.json().event_id as number;
    await waitFor(() => stack.db.getEvent(eventId)!.status === 'succeeded', 'event to succeed');

    const anon = await stack.app.inject({ method: 'POST', url: `/events/${eventId}/retry` });
    expect(anon.statusCode).toBe(401);

    const creds = 'Basic ' + Buffer.from('admin:hunter2').toString('base64');
    const notDead = await stack.app.inject({ method: 'POST', url: `/events/${eventId}/retry`, headers: { authorization: creds } });
    expect(notDead.statusCode).toBe(409);
    expect(notDead.json().error).toContain('only "dead" events');

    const missing = await stack.app.inject({ method: 'POST', url: '/events/999/retry', headers: { authorization: creds } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('status endpoints', () => {
  it('GET /health returns ok', async () => {
    const stack = startStack();
    const res = await stack.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, app: 'sparkfly', dry_run: false });
  });

  it('GET / renders the status page with setup + rules + events', async () => {
    const stack = startStack();
    const res0 = await postHook(stack.app, buildPayload(), { secret: SECRET });
    const eventId = res0.json().event_id as number;
    await waitFor(() => stack.db.getEvent(eventId)!.status === 'succeeded', 'event to succeed');

    const res = await stack.app.inject({ method: 'GET', url: '/', headers: { host: 'sparkfly:8080' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.payload;
    expect(html).toContain('Sparkfly');
    expect(html).toContain('http://sparkfly:8080/hooks/firefly');
    expect(html).toContain('Indian Garden');
    expect(html).toContain('succeeded');
  });

  it('GET / enforces basic auth when ADMIN_PASSWORD is set', async () => {
    const stack = startStack({ adminPassword: 'hunter2' });
    const anon = await stack.app.inject({ method: 'GET', url: '/' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['www-authenticate']).toContain('Basic');

    const creds = 'Basic ' + Buffer.from('admin:hunter2').toString('base64');
    const ok = await stack.app.inject({ method: 'GET', url: '/', headers: { authorization: creds } });
    expect(ok.statusCode).toBe(200);

    const bad = await stack.app.inject({
      method: 'GET',
      url: '/',
      headers: { authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') },
    });
    expect(bad.statusCode).toBe(401);
  });
});
