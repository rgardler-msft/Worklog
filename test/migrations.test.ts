import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { listPendingMigrations, runMigrations } from '../src/migrations/index.js';

const tmpDir = path.join(__dirname, 'tmp_mig');
const dbPath = path.join(tmpDir, 'worklog.db');

function ensureTmp() {
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
}

describe('migrations runner', () => {
  beforeEach(() => {
    // Ensure test temp directory is fresh for each test
    if (fs.existsSync(tmpDir)) {
      // Remove previous contents
      for (const f of fs.readdirSync(tmpDir)) {
        const p = path.join(tmpDir, f);
        if (fs.lstatSync(p).isDirectory()) {
          // remove backups dir recursively
          for (const bf of fs.readdirSync(p)) fs.unlinkSync(path.join(p, bf));
          fs.rmdirSync(p);
        } else {
          fs.unlinkSync(p);
        }
      }
    }
    ensureTmp();
  });

  it('lists pending migration when column missing', () => {
    // create minimal DB without needsProducerReview
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS workitems (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    db.close();

    const pending = listPendingMigrations(dbPath);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending.some(p => p.id.includes('needsProducerReview'))).toBeTruthy();
  });

  it('applies migration and creates backup', () => {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS workitems (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    db.close();

    const resultDry = runMigrations({ dryRun: true, confirm: false }, dbPath);
    expect(resultDry.applied.length).toBeGreaterThanOrEqual(1);

    const result = runMigrations({ dryRun: false, confirm: true, logger: { info: () => {}, error: () => {} } }, dbPath);
    expect(result.applied.length).toBeGreaterThanOrEqual(1);
    expect(result.backups.length).toBeGreaterThanOrEqual(1);

    // Verify column exists
    const db2 = new Database(dbPath, { readonly: true });
    const cols = db2.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    const existingCols = new Set(cols.map(c => c.name));
    expect(existingCols.has('needsProducerReview')).toBe(true);
    db2.close();
  });
});
