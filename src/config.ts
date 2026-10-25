import path from 'node:path';
import { APP_NAME } from './constants.js';

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  /** Directory for the SQLite database (created if missing). */
  dataDir: string;
  dbPath: string;
  /** Path to the rules YAML file. Missing file = no rules (not an error). */
  rulesFile: string;
  /** Webhook route Firefly should POST to. */
  webhookPath: string;
  fireflyWebhookSecret: string | undefined;
  /** How far off (seconds) the webhook `t=` timestamp may be. */
  signatureTtlSeconds: number;
  sparkyUrl: string;
  sparkyApiKey: string | undefined;
  /** Optional: auto-register webhook / backfill / recent-tx tests. */
  fireflyUrl: string | undefined;
  fireflyPat: string | undefined;
  /** IANA time zone used for `meal_type: auto` and entry_date/entry_time. */
  tz: string;
  dryRun: boolean;
  adminPassword: string | undefined;
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  sparkyTimeoutMs: number;
}

function bool(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function int(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`env ${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

/**
 * Validate process.env into an AppConfig. Throws a descriptive error on the
 * first problem so operators see why the app refused to start.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tz = env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23' });
  } catch {
    throw new Error(`TZ "${tz}" is not a valid IANA time zone (e.g. Europe/Berlin)`);
  }

  const dryRun = bool(env.DRY_RUN);
  const sparkyUrl = env.SPARKY_URL?.replace(/\/+$/, '') ?? '';
  const sparkyApiKey = env.SPARKY_API_KEY?.trim() || undefined;
  if (!dryRun && (!sparkyUrl || !sparkyApiKey)) {
    const missing = [!sparkyUrl && 'SPARKY_URL', !sparkyApiKey && 'SPARKY_API_KEY'].filter(Boolean).join(', ');
    throw new Error(`missing required env: ${missing} (or set DRY_RUN=true to start without SparkyFitness)`);
  }

  const dataDir = path.resolve(env.SPARKFLY_DATA_DIR ?? 'data');
  return {
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', env.PORT, 8080),
    logLevel: env.LOG_LEVEL ?? 'info',
    dataDir,
    dbPath: path.join(dataDir, 'sparkfly.db'),
    rulesFile: path.resolve(env.RULES_FILE ?? path.join('config', 'rules.yaml')),
    webhookPath: env.SPARKFLY_WEBHOOK_PATH ?? '/hooks/firefly',
    fireflyWebhookSecret: env.FIREFLY_WEBHOOK_SECRET?.trim() || undefined,
    signatureTtlSeconds: int('FIREFLY_SIGNATURE_TTL', env.FIREFLY_SIGNATURE_TTL, 300),
    sparkyUrl,
    sparkyApiKey,
    fireflyUrl: env.FIREFLY_URL?.replace(/\/+$/, '') || undefined,
    fireflyPat: env.FIREFLY_PAT?.trim() || undefined,
    tz,
    dryRun,
    adminPassword: env.ADMIN_PASSWORD || undefined,
    retry: {
      maxAttempts: Math.max(1, int('SPARKFLY_MAX_ATTEMPTS', env.SPARKFLY_MAX_ATTEMPTS, 10)),
      baseDelayMs: int('SPARKFLY_RETRY_BASE_MS', env.SPARKFLY_RETRY_BASE_MS, 5_000),
      maxDelayMs: int('SPARKFLY_RETRY_MAX_MS', env.SPARKFLY_RETRY_MAX_MS, 10 * 60_000),
    },
    sparkyTimeoutMs: int('SPARKY_TIMEOUT_MS', env.SPARKY_TIMEOUT_MS, 15_000),
  };
}

export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    app: APP_NAME,
    port: cfg.port,
    host: cfg.host,
    tz: cfg.tz,
    dryRun: cfg.dryRun,
    sparkyUrl: cfg.sparkyUrl || '(dry run)',
    webhookPath: cfg.webhookPath,
    rulesFile: cfg.rulesFile,
    dbPath: cfg.dbPath,
    logLevel: cfg.logLevel,
    webhookSecretSet: Boolean(cfg.fireflyWebhookSecret),
    fireflyApiConfigured: Boolean(cfg.fireflyUrl && cfg.fireflyPat),
    adminPasswordSet: Boolean(cfg.adminPassword),
  };
}
