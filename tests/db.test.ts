import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';
import { makeDb } from './helpers.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('openDb', () => {
  it('opens a fresh database in a new directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkfly-db-'));
    const db = openDb(path.join(dir, 'sparkfly.db'));
    expect(db.recentEvents(10)).toEqual([]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(isRoot)('throws an actionable error when the data dir is not writable', () => {
    // Root can write anywhere, so the read-only-dir scenario only reproduces
    // for unprivileged users (which is also the case in the container image).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkfly-ro-'));
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => openDb(path.join(dir, 'sparkfly.db'))).toThrowError(/writable by the user/);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('links', () => {
  it('upserts, lists and deletes links', () => {
    const db = makeDb();
    db.upsertLink({ journalId: '1', ruleId: 'r1', kind: 'meal', sparkyEntryId: 'a', eventId: 1 });
    db.upsertLink({ journalId: '1', ruleId: 'r2', kind: 'food', sparkyEntryId: 'b', eventId: 1 });
    db.upsertLink({ journalId: '2', ruleId: 'r1', kind: 'food', sparkyEntryId: 'c', eventId: 2 });

    expect(db.linksForJournal('1')).toHaveLength(2);
    expect(db.allLinks(10)).toHaveLength(3);
    expect(db.allLinks(2)).toHaveLength(2);

    expect(db.deleteLink('1', 'r1')).toBe(true);
    expect(db.deleteLink('1', 'r1')).toBe(false); // already gone
    expect(db.deleteLinksForJournal('2')).toBe(1);
    expect(db.linksForJournal('1')).toHaveLength(1);
    expect(db.linksForJournal('2')).toHaveLength(0);
    db.close();
  });
});

describe('resetEventForRetry', () => {
  it('resets a dead event to pending with a fresh retry budget', () => {
    const db = makeDb();
    const { id } = db.insertEvent({ uuid: 'u1', trigger: 'STORE_TRANSACTION', rawJson: '{}' });
    db.setEventStatus(id, 'dead', { attempts: 3, lastError: 'boom', resultSummary: 'splits=1' });

    db.resetEventForRetry(id);
    const ev = db.getEvent(id)!;
    expect(ev.status).toBe('pending');
    expect(ev.attempts).toBe(0);
    expect(ev.last_error).toBeNull();
    expect(ev.result_summary).toBeNull();
    db.close();
  });
});
