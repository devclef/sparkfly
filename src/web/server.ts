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
import type { EventQueue } from '../core/queue.js';
import type { EventProcessor } from '../core/processEvent.js';
import { fireflyPayloadSchema } from '../firefly/types.js';
import { verifyWebhookSignature } from '../firefly/signature.js';
import type { CompiledRules } from '../rules/compile.js';
import { renderStatusPage } from './statusPage.js';

export type SparkflyApp = FastifyInstance<Server, IncomingMessage, ServerResponse<IncomingMessage>, FastifyBaseLogger>;

interface AppDeps {
  cfg: AppConfig;
  db: Db;
  queue: EventQueue;
  processor: EventProcessor;
  compiled: CompiledRules;
  rulesLoadedFrom: string | null;
}

interface RawBodyRequest {
  rawBody?: Buffer;
}

const BODY_LIMIT = 1024 * 1024;
const startedAt = Date.now();

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Shared Basic-auth gate for the status page and the manual-retry route.
 * Open when no ADMIN_PASSWORD is set (the operator is expected to put the
 * port behind a reverse proxy then).
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

export function buildApp(deps: AppDeps): SparkflyApp {
  const { cfg, db, queue, compiled, rulesLoadedFrom } = deps;
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

  app.get('/health', async () => ({
    ok: true,
    app: 'sparkfly',
    version: VERSION,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    dry_run: cfg.dryRun,
    rules: compiled.rules.length,
    queue_depth: queue.size,
  }));

  app.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!checkAuth(request, reply, cfg.adminPassword)) return;
    const host = request.headers.host ?? `localhost:${cfg.port}`;
    const webhookUrl = `http://${host}${cfg.webhookPath}`;
    const events = db.recentEvents(25).map((e) => ({
      id: e.id,
      trigger: e.trigger,
      status: e.status,
      attempts: e.attempts,
      summary: e.result_summary ?? e.last_error,
      createdAt: e.created_at,
    }));
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
          rulesLoadedFrom,
          rules: compiled.rules,
          webhookUrl,
          webhookSecret: cfg.fireflyWebhookSecret ?? null,
          adminPasswordSet: Boolean(cfg.adminPassword),
          events,
          links,
          queueDepth: queue.size,
        }),
      );
  });

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
      app.log.warn({ reason: verification.reason }, 'webhook rejected: signature verification failed');
      return reply.code(401).send({ error: 'signature verification failed', reason: verification.reason });
    }

    const body = request.body;
    const parsed = fireflyPayloadSchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      app.log.warn({ details }, 'webhook rejected: payload validation failed');
      return reply.code(400).send({ error: 'invalid payload', details });
    }

    const rawJson = rawBody.toString('utf8');
    const { id, duplicate } = db.insertEvent({
      uuid: parsed.data.uuid,
      trigger: parsed.data.trigger,
      rawJson,
    });
    if (duplicate) {
      app.log.info({ eventId: id, uuid: parsed.data.uuid }, 'duplicate webhook delivery (same uuid); not re-queueing');
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
