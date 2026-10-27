import pino from 'pino';
import { loadConfig, describeConfig } from './config.js';
import { VERSION } from './constants.js';
import { openDb } from './db/index.js';
import { EventQueue } from './core/queue.js';
import { EventProcessor } from './core/processEvent.js';
import { importRulesFileIfFirstTime } from './rules/importFile.js';
import { RulesRegistry } from './rules/registry.js';
import { SparkyClient } from './sparky/client.js';
import { FireflyClient } from './firefly/client.js';
import { Notifier } from './core/notify.js';
import { buildApp, webhookSecrets } from './web/server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = pino({ level: cfg.logLevel });
  logger.info({ ...describeConfig(cfg), version: VERSION }, 'starting sparkfly');

  const db = openDb(cfg.dbPath, logger.child({ module: 'db' }));
  // Rules live in the database (managed in the web UI). A YAML file, if
  // present, is imported exactly once on first start.
  const imported = importRulesFileIfFirstTime(db, cfg.rulesFile, logger.child({ module: 'rules' }));
  const registry = new RulesRegistry(db, logger.child({ module: 'rules' }));
  logger.info(
    {
      rules: registry.compiled.rules.length,
      source: registry.importedFrom ? `imported from ${registry.importedFrom}` : 'database (managed in the UI)',
    },
    'rules ready',
  );
  void imported;

  if (webhookSecrets(cfg, db).length === 0) {
    logger.warn('no webhook secret (FIREFLY_WEBHOOK_SECRET, or register the webhook on /setup) — every delivery will be rejected with 503');
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

  const firefly =
    cfg.fireflyUrl && cfg.fireflyPat
      ? new FireflyClient({ baseUrl: cfg.fireflyUrl, pat: cfg.fireflyPat, timeoutMs: cfg.fireflyTimeoutMs, logger: logger.child({ module: 'firefly' }) })
      : null;
  const notifier = new Notifier({ cfg, logger: logger.child({ module: 'notify' }) });

  const processor = new EventProcessor({
    db,
    cfg,
    sparky,
    registry,
    notifier,
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

  const app = buildApp({ cfg, db, queue, processor, registry, sparky, importedFrom: registry.importedFrom, firefly, notifier });

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
