import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

/**
 * SQLite storage (better-sqlite3, WAL mode):
 *  - events: one row per webhook delivery (deduped on Firefly's uuid)
 *  - links:  journal_id + rule → SparkyFitness entry (needed for
 *            UPDATE/DESTROY handling in milestone 2, since
 *            food-entry-meals has no source_id of its own)
 *  - log:    the human-readable activity log behind the event rows
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
`;

const SCHEMA_VERSION = '1';

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
  addLog(eventId: number | null, level: string, message: string): void;
  logForEvent(eventId: number): { level: string; message: string; created_at: string }[];
  recentEvents(limit: number): EventRow[];
  /** Events that should be picked up again after a restart. */
  requeueableEventIds(): number[];
  close(): void;
}

const now = (): string => new Date().toISOString();

export function openDb(dbPath: string, logger?: Logger): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new Database(dbPath);
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
