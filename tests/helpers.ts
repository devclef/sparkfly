import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { AppConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/index.js';
import { compileRules, type CompiledRules } from '../src/rules/compile.js';
import { RulesRegistry } from '../src/rules/registry.js';
import { rulesFileSchema } from '../src/rules/types.js';
import { signHeader } from '../src/firefly/signature.js';
import { SparkyClient } from '../src/sparky/client.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    dataDir: path.join(os.tmpdir(), 'sparkfly-unused'),
    dbPath: path.join(os.tmpdir(), 'sparkfly-unused', 'sparkfly.db'),
    rulesFile: '/nonexistent/rules.yaml',
    webhookPath: '/hooks/firefly',
    fireflyWebhookSecret: 'test-secret',
    signatureTtlSeconds: 300,
    sparkyUrl: 'http://sparky.test:3010',
    sparkyApiKey: 'test-key',
    fireflyUrl: undefined,
    fireflyPat: undefined,
    tz: 'UTC',
    dryRun: false,
    adminPassword: undefined,
    retry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 100 },
    sparkyTimeoutMs: 1000,
    ...overrides,
  };
}

export function makeDb(name = 'test.db'): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkfly-test-'));
  return openDb(path.join(dir, name), pino({ level: 'silent' }));
}

export interface SparkyCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

/**
 * In-memory stand-in for the SparkyFitness API.
 *
 * `intercept` lets a test short-circuit specific calls (e.g. answer a PUT
 * with 404) — return a Response to override the default behaviour, or
 * undefined to fall through to the normal fake.
 */
export function fakeSparky(): {
  calls: SparkyCall[];
  failNext: number;
  intercept: ((call: SparkyCall) => Response | undefined) | null;
  fetchImpl: typeof fetch;
} {
  const calls: SparkyCall[] = [];
  const state = {
    failNext: 0,
    intercept: null as null | ((call: SparkyCall) => Response | undefined),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const u = new URL(url);
    const p = u.pathname + u.search;
    const body: Record<string, unknown> | undefined = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: SparkyCall = { method: init?.method ?? 'GET', path: p, body: body ?? {} };
    calls.push(call);
    const hook = state.intercept?.(call);
    if (hook) return hook;
    if (state.failNext > 0) {
      state.failNext -= 1;
      return new Response('boom', { status: 500 });
    }
    return new Response(JSON.stringify({ id: String(calls.length), ...(body ?? {}) }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    get failNext(): number {
      return state.failNext;
    },
    set failNext(n: number) {
      state.failNext = n;
    },
    get intercept(): null | ((call: SparkyCall) => Response | undefined) {
      return state.intercept;
    },
    set intercept(fn: null | ((call: SparkyCall) => Response | undefined)) {
      state.intercept = fn;
    },
    fetchImpl,
  };
}

export function makeSparky(cfg: AppConfig, fake: ReturnType<typeof fakeSparky>): SparkyClient {
  return new SparkyClient(
    { baseUrl: cfg.sparkyUrl, apiKey: cfg.sparkyApiKey, timeoutMs: cfg.sparkyTimeoutMs, logger: pino({ level: 'silent' }) },
    fake.fetchImpl,
  );
}

export function compileFile(file: unknown): CompiledRules {
  return compileRules(rulesFileSchema.parse(file));
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/**
 * Seed a database's rules table from a RulesFile-shaped object (or start
 * empty) and return a registry over it — the same path production uses
 * after the UI saves rules.
 */
export function makeRegistry(db: Db, file: unknown = {}): RulesRegistry {
  const parsed = rulesFileSchema.parse(file);
  db.withTransaction(() => {
    // Replace whatever the table currently holds (tests model "the rules
    // table now contains exactly this file").
    for (const row of db.listRules()) db.deleteRule(row.id);
    parsed.rules.forEach((r, i) =>
      db.insertRule({ name: r.name, match: r.match, action: r.action, cont: r['continue'], position: i + 1 }),
    );
    db.setSetting('defaults.meal_type_auto', JSON.stringify(parsed.defaults.meal_type_auto));
    db.setSetting('defaults.global_skip_tag', parsed.defaults.global_skip_tag);
  });
  return new RulesRegistry(db, silentLogger);
}

/** The ruleset most tests use: one saved-meal rule + one single-food rule. */
export const RULES_FILE = {
  defaults: {
    meal_type_auto: {
      breakfast: '04:00-10:59',
      lunch: '11:00-15:59',
      snacks: '16:00-17:29',
      dinner: '17:30-03:59',
    },
    global_skip_tag: 'no-sparky',
  },
  rules: [
    {
      name: 'Indian Garden',
      match: { type: 'withdrawal', destination: 'Indian Garden' },
      action: {
        log: 'meal',
        meal_template_id: 'meal-tikka',
        meal_type: 'auto',
        quantity: 1,
        unit: 'serving',
        note: '{{description}} – {{amount}} {{currency}}',
      },
    },
    {
      name: 'Coffee',
      match: { destination: '/starbucks|costa/i' },
      action: { log: 'food', food_id: 'food-latte', quantity: 1, unit: 'serving', meal_type: 'snacks' },
    },
  ],
};

export function buildPayload(
  overrides: Record<string, unknown> = {},
  splitOverrides: Record<string, unknown> = {},
): unknown {
  return {
    uuid: 'uuid-1',
    user_id: 1,
    user_group_id: 1,
    trigger: 'STORE_TRANSACTION',
    response: 'TRANSACTIONS',
    url: 'http://sparkfly:8080/hooks/firefly',
    version: 'v1',
    content: {
      id: 10,
      group_title: null,
      transactions: [
        {
          transaction_journal_id: 1234,
          type: 'withdrawal',
          date: '2026-10-25T12:41:00Z',
          amount: '14.50',
          currency_code: 'EUR',
          description: 'Indian Garden',
          source_name: 'Checking',
          destination_name: 'Indian Garden',
          category_name: 'Eating out',
          budget_name: 'Food',
          tags: ['lunch'],
          notes: null,
          ...splitOverrides,
        },
      ],
    },
    ...overrides,
  };
}

export function signedHeaders(secret: string, body: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    signature: signHeader(secret, body),
  };
}

export async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
