import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { AppConfig } from '../config.js';
import { VERSION } from '../constants.js';
import type { Db } from '../db/index.js';
import { EventQueue } from '../core/queue.js';
import type { EventProcessor } from '../core/processEvent.js';
import { fireflyPayloadSchema } from '../firefly/types.js';
import { verifyWebhookSignature } from '../firefly/signature.js';
import { specFromForm, specFromJson } from '../rules/form.js';
import type { RulesRegistry } from '../rules/registry.js';
import { validateRuleSpec } from '../rules/load.js';
import type { RuleSpec } from '../rules/types.js';
import type { SparkyClient } from '../sparky/client.js';
import { esc, page } from './layout.js';
import { renderEventPage, renderRuleForm, renderRulesList, ruleViewFromRow } from './rulesUi.js';
import { renderFiltersPage, renderStatusPage, type WebhookRow, type WebhookView } from './statusPage.js';
import { FILTER_FIELDS, filterFromForm, loadFilters, saveFilters, visibilityPredicate } from '../rules/webhookFilters.js';
import { formatDateFromParts, formatTimeFromParts, toLocalParts } from '../rules/mealType.js';

export type SparkflyApp = FastifyInstance<Server, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger>;

interface AppDeps {
  cfg: AppConfig;
  db: Db;
  queue: EventQueue;
  /** Used for the event pages' live dry-run plans. */
  processor: EventProcessor;
  registry: RulesRegistry;
  /** null in dry-run mode (and when SPARKY_URL/KEY are absent). */
  sparky: SparkyClient | null;
  /** File the rules were imported from on first start, if any. */
  importedFrom: string | null;
}

interface RawBodyRequest {
  rawBody?: Buffer;
}

const BODY_LIMIT = 1024 * 1024;
/** How many recent deliveries the dashboard scans, and how many rows it shows. */
const WEBHOOK_SCAN = 500;
const WEBHOOK_ROWS = 50;
const startedAt = Date.now();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Shared Basic-auth gate for the status page, the rule editor, the event
 * pages and the /api routes. Open when no ADMIN_PASSWORD is set (the
 * operator is expected to put the port behind a reverse proxy then).
 */
function checkAuth(request: FastifyRequest, reply: FastifyReply, adminPassword: string | undefined): boolean {
  if (!adminPassword) return true;
  const auth = request.headers.authorization;
  const expected = `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`;
  if (!auth || !safeEqual(auth, expected)) {
    reply.code(401).header('www-authenticate', 'Basic realm="sparkfly"').send({ error: 'authentication required' });
    return false;
  }
  return true;
}

/**
 * Persist a rule spec after validation. Returns a Fastify error response or
 * null on success (the registry is reloaded in either successful case).
 */
function saveRule(
  deps: AppDeps,
  reply: FastifyReply,
  spec: RuleSpec,
  id: number | null,
): FastifyReply | null {
  const { db, registry } = deps;
  const existing = id === null ? db.findRuleByName(spec.name) : db.getRule(id);
  if (existing && existing.id !== id) {
    return reply.code(409).send({ error: `a rule named "${spec.name}" already exists (id ${existing.id})` });
  }
  const patch = { name: spec.name, match: spec.match, action: spec.action, cont: spec['continue'] };
  if (id === null) {
    const rows = db.listRules();
    const position = rows.length === 0 ? 1 : (rows.at(-1)?.position ?? 0) + 1;
    db.insertRule({ ...patch, position });
  } else {
    db.updateRule(id, patch);
  }
  registry.reload();
  return null;
}

/** Normalise a SparkyFitness lookup response into an array for the typeaheads. */
function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    for (const key of ['data', 'items', 'results', 'meals', 'foods']) {
      const inner = (v as Record<string, unknown>)[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

export function buildApp(deps: AppDeps): SparkflyApp {
  const { cfg, db, queue, processor, registry, sparky } = deps;
  const app = Fastify<Server, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger>({
    logger: { level: cfg.logLevel },
    bodyLimit: BODY_LIMIT,
  });

  // Firefly signs the *exact* bytes it sends, so we parse the JSON body from
  // a raw buffer and keep that buffer on the request for signature checks.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (req, buf, done) => {
    try {
      const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      (req as unknown as RawBodyRequest).rawBody = raw;
      done(null, JSON.parse(raw.toString('utf8')));
    } catch (err) {
      const e = err instanceof Error ? err : new Error('invalid JSON body');
      (e as Error & { statusCode?: number }).statusCode = 400;
      done(e, undefined);
    }
  });

  // The rule editor submits classic HTML forms. Fastify has no default
  // parser for this content type, so add one.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (req, buf, done) => {
    done(null, Object.fromEntries(new URLSearchParams(buf.toString('utf8')).entries()));
  });

  app.get('/health', async () => ({
    ok: true,
    app: 'sparkfly',
    version: VERSION,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    dry_run: cfg.dryRun,
    rules: registry.compiled.rules.length,
    queue_depth: queue.size,
  }));

  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const host = request.headers.host ?? `localhost:${cfg.port}`;
    const webhookUrl = `http://${host}${cfg.webhookPath}`;
    const rawView = (request.query as { view?: string }).view;
    const view: WebhookView = rawView === 'all' || rawView === 'needs-rule' ? rawView : 'shown';
    const filters = loadFilters(db);
    const isVisible = visibilityPredicate(filters);
    // Look further back than we display, so filters that hide most
    // transactions still leave a useful list.
    const allRows = db.recentEvents(WEBHOOK_SCAN).flatMap((e): WebhookRow[] => {
      const base = {
        eventId: e.id,
        trigger: e.trigger,
        status: e.status,
        attempts: e.attempts,
        summary: e.result_summary ?? e.last_error,
        receivedAt: e.created_at,
      };
      let splits: import('../firefly/types.js').FireflySplit[];
      try {
        splits = fireflyPayloadSchema.parse(JSON.parse(e.raw_json)).content.transactions;
      } catch {
        splits = [];
      }
      if (splits.length === 0) return [{ ...base, tx: null, outcome: 'n/a', rules: [], hidden: false }];
      const evaluates = e.trigger === 'STORE_TRANSACTION' || e.trigger === 'UPDATE_TRANSACTION';
      return splits.map((s) => {
        const local = toLocalParts(new Date(s.date), cfg.tz);
        const res = evaluates ? processor.ruleOutcome(s) : null;
        return {
          ...base,
          tx: {
            journal: String(s.transaction_journal_id),
            date: `${formatDateFromParts(local)} ${formatTimeFromParts(local)}`,
            type: s.type,
            description: s.description ?? null,
            amount: s.amount,
            currency: s.currency_code,
            source: s.source_name ?? null,
            destination: s.destination_name ?? null,
            budget: s.budget_name ?? null,
            category: s.category_name ?? null,
            tags: s.tags,
          },
          outcome: !res ? 'n/a' : res.skipped ? 'skip-tag' : res.rules.length > 0 ? 'matched' : 'needs-rule',
          rules: res?.rules ?? [],
          hidden: !isVisible(s),
        };
      });
    });
    const shownRows = allRows.filter((r) => !r.hidden);
    const counts = {
      shown: shownRows.length,
      hidden: allRows.length - shownRows.length,
      needsRule: shownRows.filter((r) => r.outcome === 'needs-rule').length,
    };
    const webhooks = (
      view === 'all' ? allRows : view === 'needs-rule' ? shownRows.filter((r) => r.outcome === 'needs-rule') : shownRows
    ).slice(0, WEBHOOK_ROWS);
    const links = db.allLinks(25).map((l) => ({
      journal_id: l.journal_id,
      rule_id: l.rule_id,
      kind: l.kind,
      sparky_entry_id: l.sparky_entry_id,
      createdAt: l.created_at,
    }));
    return reply
      .type('text/html; charset=utf-8')
      .send(
        renderStatusPage({
          version: VERSION,
          dryRun: cfg.dryRun,
          sparkyUrl: cfg.sparkyUrl,
          tz: cfg.tz,
          rulesSource: registry.importedFrom
            ? `imported from ${registry.importedFrom}`
            : 'managed in the UI',
          rules: registry.compiled.rules,
          webhookUrl,
          webhookSecret: cfg.fireflyWebhookSecret ?? null,
          adminPasswordSet: Boolean(cfg.adminPassword),
          webhooks,
          view,
          counts,
          filters,
          links,
          queueDepth: queue.size,
        }),
      );
  });

  // ------------------------------------------------------------------ //
  // Webhook filters (which transactions the dashboard shows)
  // ------------------------------------------------------------------ //
  app.get('/filters', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const q = request.query as Record<string, string | undefined>;
    const prefill: Record<string, string> = {};
    for (const k of ['mode', 'type', 'name', ...FILTER_FIELDS]) {
      const v = q[k];
      if (typeof v === 'string') prefill[k] = v;
    }
    return reply
      .type('text/html; charset=utf-8')
      .send(renderFiltersPage({ filters: loadFilters(db), errors: [], prefill }));
  });

  app.post('/filters', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const res = filterFromForm(body);
    const filters = loadFilters(db);
    if (!res.ok) {
      const prefill = Object.fromEntries(
        Object.entries(body).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
      return reply
        .code(422)
        .type('text/html; charset=utf-8')
        .send(renderFiltersPage({ filters, errors: res.errors, prefill }));
    }
    const id = filters.reduce((max, f) => Math.max(max, f.id), 0) + 1;
    saveFilters(db, [...filters, { id, ...res.filter }]);
    app.log.info({ id, mode: res.filter.mode }, 'webhook filter added');
    return reply.redirect('/filters');
  });

  app.post('/filters/:id/toggle', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    const filters = loadFilters(db);
    const f = filters.find((x) => x.id === id);
    if (!f) return reply.code(404).send({ error: 'filter not found' });
    f.enabled = !f.enabled;
    saveFilters(db, filters);
    return reply.redirect('/filters');
  });

  app.post('/filters/:id/delete', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    const filters = loadFilters(db);
    if (!filters.some((x) => x.id === id)) return reply.code(404).send({ error: 'filter not found' });
    saveFilters(db, filters.filter((x) => x.id !== id));
    return reply.redirect('/filters');
  });

  // ------------------------------------------------------------------ //
  // Rule management (UI forms)
  // ------------------------------------------------------------------ //
  app.get('/rules', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const rules = db.listRules().map(ruleViewFromRow);
    return reply.type('text/html; charset=utf-8').send(
      renderRulesList({
        rules,
        sparkyConfigured: sparky !== null,
        importedFrom: registry.importedFrom,
        rulesSourceFile: cfg.rulesFile,
      }),
    );
  });

  app.get('/rules/new', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const q = request.query as { event?: string; split?: string };
    let fromTransaction: { eventId: number; split: import('../firefly/types.js').FireflySplit } | null = null;
    if (q.event) {
      const eventId = Number(q.event);
      const event = Number.isInteger(eventId) ? db.getEvent(eventId) : null;
      if (event) {
        try {
          const payload = fireflyPayloadSchema.parse(JSON.parse(event.raw_json));
          const splits = payload.content.transactions;
          const split = q.split ? splits.find((s) => String(s.transaction_journal_id) === q.split) : splits[0];
          if (split) fromTransaction = { eventId, split };
        } catch {
          fromTransaction = null;
        }
      }
      if (!fromTransaction) return reply.code(404).send('event not found or has no transactions');
    }
    return reply.type('text/html; charset=utf-8').send(
      renderRuleForm({
        view: null,
        errors: [],
        fromTransaction,
        sparkyConfigured: sparky !== null,
      }),
    );
  });

  const saveFromForm = async (request: FastifyRequest, reply: FastifyReply, id: number | null) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const res = specFromForm(body);
    if (!res.ok) {
      // Re-render the form with the submitted values and the errors.
      const view = id === null ? null : (() => {
        const row = db.getRule(id);
        return row ? ruleViewFromRow(row) : null;
      })();
      return reply
        .code(422)
        .type('text/html; charset=utf-8')
        .send(renderRuleForm({ view, errors: res.errors, fromTransaction: null, sparkyConfigured: sparky !== null }));
    }
    const saved = saveRule(deps, reply, res.spec, id);
    if (saved) return saved;
    app.log.info({ rule: res.spec.name, id: id ?? db.findRuleByName(res.spec.name)?.id }, 'rule saved via UI');
    const fromEvent = body.from_event ? Number(body.from_event) : null;
    if (id === null && fromEvent && Number.isInteger(fromEvent) && db.getEvent(fromEvent)) {
      // Created from a transaction: take the user straight to its test page.
      return reply.redirect(`/events/${fromEvent}`);
    }
    return reply.redirect('/rules');
  };

  app.post('/rules', (request, reply) => saveFromForm(request, reply, null));
  app.post('/rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.getRule(id)) return reply.code(404).send({ error: 'rule not found' });
    return saveFromForm(request, reply, id);
  });

  app.get('/rules/:id/edit', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    const row = Number.isInteger(id) ? db.getRule(id) : null;
    if (!row) return reply.code(404).type('text/html; charset=utf-8').send('<h1>rule not found</h1>');
    return reply.type('text/html; charset=utf-8').send(
      renderRuleForm({ view: ruleViewFromRow(row), errors: [], fromTransaction: null, sparkyConfigured: sparky !== null }),
    );
  });

  app.post('/rules/:id/delete', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.getRule(id)) return reply.code(404).send({ error: 'rule not found' });
    db.deleteRule(id);
    registry.reload();
    app.log.info({ id }, 'rule deleted via UI');
    return reply.redirect('/rules');
  });

  app.post('/rules/:id/move', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.getRule(id)) return reply.code(404).send({ error: 'rule not found' });
    const body = (request.body ?? {}) as { dir?: string };
    const dir: -1 | 1 = body.dir === 'up' ? -1 : 1;
    if (db.moveRule(id, dir)) registry.reload();
    return reply.redirect('/rules');
  });

  // ------------------------------------------------------------------ //
  // Event pages: dry-run tester + activity log
  // ------------------------------------------------------------------ //
  app.get('/events/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    const event = Number.isInteger(id) ? db.getEvent(id) : null;
    if (!event) return reply.code(404).type('text/html; charset=utf-8').send('<h1>event not found</h1>');
    let plan: { trigger: string; lines: import('../core/processEvent.js').PlanLine[] };
    let hasTransactions = false;
    const journals: string[] = [];
    try {
      const payload = fireflyPayloadSchema.parse(JSON.parse(event.raw_json));
      hasTransactions = payload.content.transactions.length > 0;
      for (const s of payload.content.transactions) journals.push(String(s.transaction_journal_id));
      plan = processor.plan(payload);
    } catch {
      plan = { trigger: event.trigger, lines: [{ kind: 'info', journal: '—', text: 'payload no longer parses' }] };
    }
    const links = journals.flatMap((j) => db.linksForJournal(j));
    return reply.type('text/html; charset=utf-8').send(
      renderEventPage({
        event,
        log: db.logForEvent(event.id),
        plan: plan.lines,
        hasTransactions,
        links,
      }),
    );
  });

  // ------------------------------------------------------------------ //
  // Programmatic rule API (JSON) — same validation as the UI
  // ------------------------------------------------------------------ //
  app.get('/api/rules', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    return db.listRules().map(ruleViewFromRow);
  });

  app.post('/api/rules', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const res = specFromJson(request.body);
    if (!res.ok) return reply.code(400).send({ error: 'invalid rule', details: res.errors });
    const saved = saveRule(deps, reply, res.spec, null);
    if (saved) return saved;
    return reply.code(201).send({ id: db.findRuleByName(res.spec.name)?.id, name: res.spec.name });
  });

  app.put('/api/rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.getRule(id)) return reply.code(404).send({ error: 'rule not found' });
    const res = specFromJson(request.body);
    if (!res.ok) return reply.code(400).send({ error: 'invalid rule', details: res.errors });
    const saved = saveRule(deps, reply, res.spec, id);
    if (saved) return saved;
    return reply.send({ id, name: res.spec.name });
  });

  app.delete('/api/rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || !db.getRule(id)) return reply.code(404).send({ error: 'rule not found' });
    db.deleteRule(id);
    registry.reload();
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------ //
  // SparkyFitness lookups for the rule editor's typeaheads
  // ------------------------------------------------------------------ //
  const sparkyLookup = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    if (!sparky) {
      return reply.code(503).send({ error: 'SparkyFitness is not configured (SPARKY_URL / SPARKY_API_KEY, and DRY_RUN off)' });
    }
    const q = ((request.query as { q?: string }).q ?? '').trim();
    try {
      const kind = (request.params as { kind: string }).kind;
      if (kind !== 'meal-types' && kind !== 'meals' && kind !== 'foods') {
        return reply.code(400).send({ error: 'unknown lookup kind' });
      }
      const result =
        kind === 'meal-types' ? await sparky.mealTypes() :
        kind === 'meals' ? (q ? await sparky.searchMeals(q) : await sparky.listMeals()) :
        await sparky.searchFoods(q);
      return asList(result);
    } catch (err) {
      app.log.warn({ err: (err as Error).message }, 'sparky lookup failed');
      return reply.code(502).send({ error: `SparkyFitness lookup failed: ${(err as Error).message}` });
    }
  };
  app.get('/api/sparky/:kind', sparkyLookup);

  // ------------------------------------------------------------------ //
  // Firefly webhook: verify → store → 202. Processing happens on the
  // in-process queue so Firefly (which sets no request timeout) never
  // blocks on us; our own retries cover SparkyFitness being down.
  // ------------------------------------------------------------------ //
  app.post(cfg.webhookPath, async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request as unknown as RawBodyRequest).rawBody;
    if (!rawBody || rawBody.length === 0) {
      return reply.code(400).send({ error: 'empty request body' });
    }

    if (!cfg.fireflyWebhookSecret) {
      app.log.error('rejecting webhook: FIREFLY_WEBHOOK_SECRET is not configured');
      return reply.code(503).send({ error: 'webhook secret not configured on this server' });
    }

    const verification = verifyWebhookSignature({
      rawBody,
      signatureHeader: request.headers.signature as string | undefined,
      secret: cfg.fireflyWebhookSecret,
      ttlSeconds: cfg.signatureTtlSeconds,
    });
    if (!verification.ok) {
      app.log.warn({ reason: verification.reason }, 'rejecting webhook: bad signature');
      return reply.code(401).send({ error: 'invalid signature', reason: verification.reason });
    }

    const parsed = fireflyPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      app.log.warn({ issues: parsed.error.issues }, 'rejecting webhook: invalid payload');
      return reply.code(400).send({ error: 'invalid payload' });
    }

    const { id, duplicate } = db.insertEvent({
      uuid: parsed.data.uuid,
      trigger: parsed.data.trigger,
      rawJson: rawBody.toString('utf8'),
    });
    if (duplicate) {
      db.addLog(id, 'info', `duplicate delivery of uuid ${parsed.data.uuid} ignored`);
      app.log.info({ eventId: id, uuid: parsed.data.uuid }, 'duplicate webhook ignored');
      return reply.code(202).send({ status: 'duplicate', event_id: id });
    }
    queue.enqueue(id);
    app.log.info(
      { eventId: id, uuid: parsed.data.uuid, trigger: parsed.data.trigger, splits: parsed.data.content.transactions.length },
      'webhook accepted',
    );
    return reply.code(202).send({ status: 'queued', event_id: id });
  });

  // ------------------------------------------------------------------ //
  // Manual retry for dead events (the status page's retry button).
  // A fresh retry budget (attempts = 0) and a re-queue on the in-process
  // queue; the normal backoff machinery picks up from there.
  // ------------------------------------------------------------------ //
  app.post('/events/:id/retry', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid event id' });
    }
    const event = db.getEvent(id);
    if (!event) return reply.code(404).send({ error: 'event not found' });
    if (event.status !== 'dead') {
      return reply.code(409).send({
        error: `only "dead" events can be retried (current status: ${event.status})`,
      });
    }
    db.resetEventForRetry(id);
    db.addLog(id, 'info', 'retried manually from the status page');
    app.log.info({ eventId: id }, 'event retried manually');
    queue.enqueue(id);
    return reply.redirect('/');
  });

  return app;
}
