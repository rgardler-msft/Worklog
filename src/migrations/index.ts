/**
 * Migration runner for Worklog
 * Exposes listPendingMigrations and runMigrations used by `wl doctor upgrade`
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getDefaultDataPath } from '../jsonl.js';

export interface MigrationInfo {
  id: string;
  description: string;
  safe: boolean; // non-destructive
}

interface RunOptions {
  dryRun?: boolean;
  confirm?: boolean;
  logger?: { info: (s: string) => void; error: (s: string) => void };
}

const MIGRATIONS: Array<{ id: string; description: string; safe: boolean; apply: (db: Database.Database) => void }> = [
  {
    id: '20260210-add-needsProducerReview',
    description: 'Add needsProducerReview INTEGER column to workitems (default 0)',
    safe: true,
    apply: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
      const existingCols = new Set(cols.map(c => String(c.name)));
      if (!existingCols.has('needsProducerReview')) {
        // Idempotent add column
        db.exec(`ALTER TABLE workitems ADD COLUMN needsProducerReview INTEGER NOT NULL DEFAULT 0`);
      }
    }
  }
];

function resolveDbPath(dbPath?: string): string {
  if (dbPath) return dbPath;
  const dataPath = getDefaultDataPath();
  return path.join(path.dirname(dataPath), 'worklog.db');
}

export function listPendingMigrations(dbPath?: string): MigrationInfo[] {
  const file = resolveDbPath(dbPath);
  if (!fs.existsSync(file)) {
    // Nothing to migrate if DB doesn't exist
    return [];
  }

  const db = new Database(file, { readonly: true });
  try {
    const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
    const existingCols = new Set(cols.map(c => String(c.name)));
    const pending = MIGRATIONS.filter(m => !existingCols.has(m.id === '20260210-add-needsProducerReview' ? 'needsProducerReview' : ''))
      .filter(m => {
        // Only migration we currently know is needsProducerReview
        if (m.id === '20260210-add-needsProducerReview') {
          return !existingCols.has('needsProducerReview');
        }
        return false;
      })
      .map(m => ({ id: m.id, description: m.description, safe: m.safe }));
    return pending;
  } finally {
    db.close();
  }
}

function makeBackup(dbPath: string, logger?: { info: (s: string) => void; error: (s: string) => void }): string {
  const dir = path.dirname(dbPath);
  const backupsDir = path.join(dir, 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:]/g, '').replace(/\..+/, '');
  const base = path.basename(dbPath);
  const out = path.join(backupsDir, `${base}.${ts}`);

  fs.copyFileSync(dbPath, out);
  // Prune to last 5 backups
  const files = fs.readdirSync(backupsDir)
    .map(f => ({ f, full: path.join(backupsDir, f), mtime: fs.statSync(path.join(backupsDir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  const keep = 5;
  for (let i = keep; i < files.length; i += 1) {
    try {
      fs.unlinkSync(files[i].full);
    } catch (err) {
      // ignore errors while pruning
      logger?.error?.(`Failed to prune old backup ${files[i].full}: ${(err as Error).message}`);
    }
  }

  logger?.info?.(`Created backup: ${out}`);
  return out;
}

export function runMigrations(opts: RunOptions = {}, dbPath?: string, filter?: { safeOnly?: boolean }): { applied: MigrationInfo[]; backups: string[] } {
  const file = resolveDbPath(dbPath);
  const logger = opts.logger || { info: () => {}, error: () => {} };
  if (!fs.existsSync(file)) {
    return { applied: [], backups: [] };
  }

  const pending = listPendingMigrations(file);
  if (pending.length === 0) {
    return { applied: [], backups: [] };
  }

  if (opts.dryRun) {
    return { applied: pending, backups: [] };
  }

  // If any migrations are present and not confirmed, error.
  if (!opts.confirm) {
    throw new Error('Migrations present but not confirmed. Rerun with --confirm to apply.');
  }

  // Create backup before applying
  let backupPath = '';
  try {
    backupPath = makeBackup(file, logger);
  } catch (err) {
    throw new Error(`Failed to create backup before applying migrations: ${(err as Error).message}`);
  }

  const db = new Database(file);
  const applied: MigrationInfo[] = [];
  try {
    const tx = db.transaction(() => {
      for (const m of MIGRATIONS) {
        if (filter?.safeOnly && !m.safe) continue;
        if (m.id === '20260210-add-needsProducerReview') {
          const cols = db.prepare(`PRAGMA table_info('workitems')`).all() as any[];
          const existingCols = new Set(cols.map(c => String(c.name)));
          if (!existingCols.has('needsProducerReview')) {
            m.apply(db);
            applied.push({ id: m.id, description: m.description, safe: m.safe });
          }
        }
      }

      // Update metadata schemaVersion (increment by 1 from existing if present)
      try {
        const versionRow = db.prepare('SELECT value FROM metadata WHERE key = ?').get('schemaVersion') as { value: string } | undefined;
        const current = versionRow ? parseInt(versionRow.value, 10) : 6;
        const next = Math.max(current, 6) + (applied.length > 0 ? 1 : 0);
        db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run('schemaVersion', String(next));
      } catch (err) {
        // Best-effort: don't fail migration if metadata update fails, but log
        logger.error?.(`Failed to update metadata.schemaVersion: ${(err as Error).message}`);
      }
    });

    tx();
  } finally {
    db.close();
  }

  return { applied, backups: backupPath ? [backupPath] : [] };
}
