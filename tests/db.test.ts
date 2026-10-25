import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/index.js';

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
