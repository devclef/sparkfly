import pino from 'pino';
import { loadConfig, describeConfig } from './config.js';
import { VERSION } from './constants.js';
import { openDb } from './db/index.js';
import { EventQueue } from './core/queue.js';
import { EventProcessor } from './core/processEvent.js';
import { compileRules } from './rules/compile.js';
import { loadRulesFile } from './rules/load.js';
import { SparkyClient } from './sparky/client.js';
import { buildApp } from './web/server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = pino({ level: cfg.logLevel });
  logger.info({ ...describeConfig(cfg), version: VERSION }, 'starting sparkfly');

  const db = openDb(cfg.dbPath, logger.child({ module: 'db' }));
  const { file: rulesFile, loadedFrom } = loadRulesFile(cfg.rulesFile);
  const compiled = compileRules(rulesFile);
  logger.info(
    { rules: compiled.rules.length, rulesFile: loadedFrom ?? '(no file — running with no rules)' },
    'rules loaded',
  );

  if (!cfg.fireflyWebhookSecret) {
    logger.warn('FIREFLY_WEBHOOK_SECRET is not set — every webhook delivery will be rejected with 503');
  }
  if (!cfg.adminPassword) {
    logger.warn('ADMIN_PASSWORD is not set — the status page is open; protect it with your reverse proxy');
  }
  if (cfg.dryRun) {
    logger.warn('DRY_RUN=true — rules are evaluated and logged, but nothing is written to SparkyFitness');
  }

  const sparky =
    cfg.sparkyUrl && cfg.sparkyApiKey
      ? new SparkyClient(
          { baseUrl: cfg.sparkyUrl, apiKey: cfg.sparkyApiKey, timeoutMs: cfg.sparkyTimeoutMs, logger: logger.child({ module: 'sparky' }) },
        )
      : null;

  const processor = new EventProcessor({
    db,
    cfg,
    sparky,
    compiled,
    logger: logger.child({ module: 'processor' }),
  });
  const queue = new EventQueue({
    logger: logger.child({ module: 'queue' }),
    maxDelayMs: cfg.retry.maxDelayMs,
    process: (id) => processor.process(id),
  });

  // Crash recovery: pick up anything the previous run left pending/failed.
  const requeued = db.requeueableEventIds();
  for (const id of requeued) queue.enqueue(id);
  if (requeued.length > 0) {
    logger.info({ requeued: requeued.length }, 're-queued events from a previous run');
  }

  const app = buildApp({ cfg, db, queue, processor, compiled, rulesLoadedFrom: loadedFrom });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await queue.stop();
    try {
      await app.close();
    } catch {
      /* already closed */
    }
    db.close();
    logger.info('bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: cfg.host, port: cfg.port });
  logger.info(
    `sparkfly v${VERSION} ready — webhook ${cfg.webhookPath} · status page http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}/`,
  );
}

main().catch((err: unknown) => {
  console.error('fatal: sparkfly failed to start', err);
  process.exit(1);
});
