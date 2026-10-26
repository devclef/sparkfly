import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

/**
 * SQLite storage (better-sqlite3, WAL mode):
 *  - events: one row per webhook delivery (deduped on Firefly's uuid)
 *  - links:  journal_id + rule → SparkyFitness entry (drives UPDATE/DESTROY
 *            handling; food-entry-meals has no source_id of its own, so the
 *            link is the only way back to a logged meal)
 *  - rules:  the rule set, managed in the web UI (the YAML file is only a
 *            first-start import source)
 *  - log:    the human-readable activity log behind the event rows
 *  - settings: key/value store (rule defaults, import bookkeeping)
 */

export type EventStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped' | 'dead';

export interface EventRow {
  id: number;
  uuid: string;
  trigger: string;
  status: EventStatus;
  attempts: number;
  last_error: string | null;
  result_summary: string | null;
  raw_json: string;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  journal_id: string;
  rule_id: string;
  kind: 'meal' | 'food';
  sparky_entry_id: string | null;
  event_id: number | null;
  created_at: string;
}

export interface RuleRow {
  id: number;
  name: string;
  match_json: string;
  action_json: string;
  /** 0/1 — keep evaluating later rules after this one matches. */
  cont: number;
  /** 0/1 — disabled rules are skipped by the compiler. */
  enabled: number;
  position: number;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  result_summary TEXT,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);

CREATE TABLE IF NOT EXISTS links (
  journal_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sparky_entry_id TEXT,
  event_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (journal_id, rule_id)
);

CREATE TABLE IF NOT EXISTS log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_event ON log (event_id);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  match_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  cont INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_position ON rules (position);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Bumped for v2: the rules and settings tables (rules moved from the YAML
 * file into the database, managed in the web UI). The schema is additive and
 * idempotent, so upgrading a v1 database is just running the same DDL.
 */
const SCHEMA_VERSION = '2';

export interface Db {
  insertEvent(evt: { uuid: string; trigger: string; rawJson: string }): { id: number; duplicate: boolean };
  getEvent(id: number): EventRow | null;
  setEventStatus(
    id: number,
    status: EventStatus,
    patch?: { attempts?: number; lastError?: string | null; resultSummary?: string | null },
  ): void;
  upsertLink(link: {
    journalId: string;
    ruleId: string;
    kind: 'meal' | 'food';
    sparkyEntryId: string | null;
    eventId: number | null;
  }): void;
  linksForJournal(journalId: string): LinkRow[];
  /** Remove one link. Returns true when a row was actually deleted. */
  deleteLink(journalId: string, ruleId: string): boolean;
  /** Remove every link for a journal. Returns how many rows were deleted. */
  deleteLinksForJournal(journalId: string): number;
  /** All links, most recently touched first (for the status page). */
  allLinks(limit: number): LinkRow[];
  /** Reset a dead/failed event for a fresh processing round (manual retry). */
  resetEventForRetry(id: number): void;
  /** All rules in evaluation order. */
  listRules(): RuleRow[];
  getRule(id: number): RuleRow | null;
  findRuleByName(name: string): RuleRow | null;
  countRules(): number;
  insertRule(rule: {
    name: string;
    match: unknown;
    action: unknown;
    cont: boolean;
    position: number;
    enabled?: boolean;
  }): number;
  updateRule(
    id: number,
    patch: {
      name?: string;
      match?: unknown;
      action?: unknown;
      cont?: boolean;
      enabled?: boolean;
      position?: number;
    },
  ): boolean;
  /** Swap a rule with its neighbour. Returns false at the list edges. */
  moveRule(id: number, dir: -1 | 1): boolean;
  /** Delete a rule. Returns true when a row was deleted. */
  deleteRule(id: number): boolean;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  /** Run a function inside a SQLite transaction (all-or-nothing). */
  withTransaction(fn: () => void): void;
  addLog(eventId: number | null, level: string, message: string): void;
  logForEvent(eventId: number): { level: string; message: string; created_at: string }[];
  recentEvents(limit: number): EventRow[];
  /** Events that should be picked up again after a restart. */
  requeueableEventIds(): number[];
  close(): void;
}

const now = (): string => new Date().toISOString();

/** Diagnostics for the directory holding the database, for error messages. */
function describeDataDir(dbPath: string): string {
  const dir = path.dirname(dbPath);
  try {
    const st = fs.statSync(dir);
    let writable = true;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'n/a';
    const gid = typeof process.getgid === 'function' ? process.getgid() : 'n/a';
    return [
      `dir=${dir}`,
      `owner=${st.uid}:${st.gid}`,
      `mode=${(st.mode & 0o7777).toString(8)}`,
      `process uid=${uid} gid=${gid}`,
      `writable=${writable}`,
    ].join(' ');
  } catch (err) {
    return `dir=${dir} (stat failed: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function openDb(dbPath: string, logger?: Logger): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let raw: InstanceType<typeof Database>;
  try {
    raw = new Database(dbPath);
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CANTOPEN') {
      throw new Error(
        `cannot open database file at ${dbPath} — ${describeDataDir(dbPath)}. ` +
          `The directory must be writable by the user the app runs as. ` +
          `In Kubernetes this usually means the volume at the data dir is owned by root: ` +
          `set securityContext.fsGroup to the container user's gid (999 for the sparkfly image), ` +
          `or add an initContainer that chowns it, and check that readOnlyRootFilesystem is not blocking it.`,
        { cause: err },
      );
    }
    throw err;
  }
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);

  const version = raw.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined;
  if (!version) {
    raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  } else if (version.value !== SCHEMA_VERSION) {
    logger?.warn({ found: version.value, expected: SCHEMA_VERSION }, 'schema version differs; migrations not implemented yet');
  }

  const insertEventStmt = raw.prepare(
    `INSERT INTO events (uuid, trigger, status, attempts, raw_json, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, ?, ?, ?)
     ON CONFLICT (uuid) DO NOTHING`,
  );
  const findEventByUuidStmt = raw.prepare('SELECT id FROM events WHERE uuid = ?');
  const getEventStmt = raw.prepare('SELECT * FROM events WHERE id = ?');
  const setEventStmt = raw.prepare(
    `UPDATE events SET
       status = @status,
       updated_at = @updated_at,
       attempts = COALESCE(@attempts, attempts),
       last_error = COALESCE(@last_error, last_error),
       result_summary = COALESCE(@result_summary, result_summary)
     WHERE id = @id`,
  );
  const upsertLinkStmt = raw.prepare(
    `INSERT INTO links (journal_id, rule_id, kind, sparky_entry_id, event_id, created_at)
     VALUES (@journal_id, @rule_id, @kind, @sparky_entry_id, @event_id, @created_at)
     ON CONFLICT (journal_id, rule_id) DO UPDATE SET
       kind = excluded.kind,
       sparky_entry_id = excluded.sparky_entry_id,
       event_id = excluded.event_id`,
  );
  const linksStmt = raw.prepare('SELECT * FROM links WHERE journal_id = ? ORDER BY rule_id');
  const deleteLinkStmt = raw.prepare('DELETE FROM links WHERE journal_id = ? AND rule_id = ?');
  const deleteLinksStmt = raw.prepare('DELETE FROM links WHERE journal_id = ?');
  const allLinksStmt = raw.prepare('SELECT * FROM links ORDER BY created_at DESC, journal_id, rule_id LIMIT ?');
  const resetEventStmt = raw.prepare(
    `UPDATE events SET status = 'pending', attempts = 0, last_error = NULL,
       result_summary = NULL, updated_at = ? WHERE id = ?`,
  );
  const listRulesStmt = raw.prepare('SELECT * FROM rules ORDER BY position, id');
  const getRuleStmt = raw.prepare('SELECT * FROM rules WHERE id = ?');
  const findRuleStmt = raw.prepare('SELECT * FROM rules WHERE name = ?');
  const countRulesStmt = raw.prepare('SELECT COUNT(*) AS n FROM rules');
  const insertRuleStmt = raw.prepare(
    `INSERT INTO rules (name, match_json, action_json, cont, enabled, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRuleStmt = raw.prepare(
    `UPDATE rules SET
       name = COALESCE(@name, name),
       match_json = COALESCE(@match_json, match_json),
       action_json = COALESCE(@action_json, action_json),
       cont = COALESCE(@cont, cont),
       enabled = COALESCE(@enabled, enabled),
       position = COALESCE(@position, position),
       updated_at = @updated_at
     WHERE id = @id`,
  );
  const deleteRuleStmt = raw.prepare('DELETE FROM rules WHERE id = ?');
  const setRulePositionStmt = raw.prepare(
    'UPDATE rules SET position = @position, updated_at = @updated_at WHERE id = @id',
  );
  const getSettingStmt = raw.prepare('SELECT value FROM settings WHERE key = ?');
  const setSettingStmt = raw.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  );
  const addLogStmt = raw.prepare('INSERT INTO log (event_id, level, message, created_at) VALUES (?, ?, ?, ?)');
  const logStmt = raw.prepare('SELECT level, message, created_at FROM log WHERE event_id = ? ORDER BY id DESC LIMIT 100');
  const recentEventsStmt = raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?');
  const requeueStmt = raw.prepare(`SELECT id FROM events WHERE status IN ('pending', 'processing', 'failed') ORDER BY id`);

  return {
    insertEvent({ uuid, trigger, rawJson }) {
      const info = insertEventStmt.run(uuid, trigger, rawJson, now(), now());
      if (info.changes === 0) {
        // UNIQUE(uuid) hit: Firefly redelivered an event we already saw.
        const existing = findEventByUuidStmt.get(uuid) as { id: number };
        return { id: existing.id, duplicate: true };
      }
      return { id: Number(info.lastInsertRowid), duplicate: false };
    },

    getEvent(id) {
      return (getEventStmt.get(id) as EventRow | undefined) ?? null;
    },

    setEventStatus(id, status, patch) {
      setEventStmt.run({
        id,
        status,
        updated_at: now(),
        attempts: patch?.attempts,
        last_error: patch?.lastError,
        result_summary: patch?.resultSummary,
      });
    },

    upsertLink(link) {
      upsertLinkStmt.run({
        journal_id: link.journalId,
        rule_id: link.ruleId,
        kind: link.kind,
        sparky_entry_id: link.sparkyEntryId,
        event_id: link.eventId,
        created_at: now(),
      });
    },

    linksForJournal(journalId) {
      return linksStmt.all(journalId) as LinkRow[];
    },

    deleteLink(journalId, ruleId) {
      return deleteLinkStmt.run(journalId, ruleId).changes > 0;
    },

    deleteLinksForJournal(journalId) {
      return deleteLinksStmt.run(journalId).changes;
    },

    allLinks(limit) {
      return allLinksStmt.all(limit) as LinkRow[];
    },

    resetEventForRetry(id) {
      resetEventStmt.run(now(), id);
    },

    listRules() {
      return listRulesStmt.all() as RuleRow[];
    },

    getRule(id) {
      return (getRuleStmt.get(id) as RuleRow | undefined) ?? null;
    },

    findRuleByName(name) {
      return (findRuleStmt.get(name) as RuleRow | undefined) ?? null;
    },

    countRules() {
      return Number((countRulesStmt.get() as { n: number }).n);
    },

    insertRule({ name, match, action, cont, position, enabled = true }) {
      const info = insertRuleStmt.run(
        name,
        JSON.stringify(match),
        JSON.stringify(action),
        cont ? 1 : 0,
        enabled ? 1 : 0,
        position,
        now(),
        now(),
      );
      return Number(info.lastInsertRowid);
    },

    updateRule(id, patch) {
      const info = updateRuleStmt.run({
        id,
        updated_at: now(),
        name: patch.name,
        match_json: patch.match === undefined ? undefined : JSON.stringify(patch.match),
        action_json: patch.action === undefined ? undefined : JSON.stringify(patch.action),
        cont: patch.cont === undefined ? undefined : patch.cont ? 1 : 0,
        enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
        position: patch.position,
      });
      return info.changes > 0;
    },

    moveRule(id, dir) {
      const cur = getRuleStmt.get(id) as RuleRow | undefined;
      if (!cur) return false;
      const neighbor =
        dir === -1
          ? (raw.prepare('SELECT id, position FROM rules WHERE position < ? ORDER BY position DESC, id DESC LIMIT 1').get(cur.position) as { id: number; position: number } | undefined)
          : (raw.prepare('SELECT id, position FROM rules WHERE position > ? ORDER BY position ASC, id ASC LIMIT 1').get(cur.position) as { id: number; position: number } | undefined);
      if (!neighbor) return false;
      const swap = raw.transaction(() => {
        setRulePositionStmt.run({ id: cur.id, position: neighbor.position, updated_at: now() });
        setRulePositionStmt.run({ id: neighbor.id, position: cur.position, updated_at: now() });
      });
      swap();
      return true;
    },

    deleteRule(id) {
      return deleteRuleStmt.run(id).changes > 0;
    },

    getSetting(key) {
      return ((getSettingStmt.get(key) as { value: string } | undefined)?.value) ?? null;
    },

    setSetting(key, value) {
      setSettingStmt.run(key, value);
    },

    withTransaction(fn) {
      try {
        raw.transaction(fn)();
      } catch (err) {
        // better-sqlite3 already rolled back; the table is unchanged.
        logger?.warn({ err: (err as Error).message }, 'transaction rolled back');
      }
    },

    addLog(eventId, level, message) {
      addLogStmt.run(eventId, level, message, now());
    },

    logForEvent(eventId) {
      return logStmt.all(eventId) as { level: string; message: string; created_at: string }[];
    },

    recentEvents(limit) {
      return recentEventsStmt.all(limit) as EventRow[];
    },

    requeueableEventIds() {
      return (requeueStmt.all() as { id: number }[]).map((r) => r.id);
    },

    close() {
      raw.close();
    },
  };
}
