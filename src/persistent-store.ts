/**
 * SQLite-based persistent storage for work items and comments
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, Comment, DependencyEdge } from './types.js';
import { listPendingMigrations } from './migrations/index.js';

/**
 * Result from a full-text search query
 */
export interface FtsSearchResult {
  /** The work item ID */
  itemId: string;
  /** BM25 relevance score (lower = more relevant in SQLite FTS5) */
  rank: number;
  /** Snippet with highlighted matches */
  snippet: string;
  /** Which column the snippet was extracted from */
  matchedColumn: string;
}

interface DbMetadata {
  lastJsonlImportMtime?: number;
  lastJsonlImportAt?: string;
  schemaVersion: number;
}

const SCHEMA_VERSION = 6;

/**
 * Normalize a single value for use as a better-sqlite3 binding parameter.
 * better-sqlite3 only accepts: number, string, bigint, Buffer, or null.
 * This function converts unsupported types:
 *  - undefined  -> null
 *  - null       -> null (passthrough)
 *  - boolean    -> 1 or 0
 *  - Date       -> ISO 8601 string via toISOString()
 *  - object/array -> JSON string via JSON.stringify (fallback to String())
 *  - number, string, bigint, Buffer -> passthrough
 */
export function normalizeSqliteValue(v: unknown): number | string | bigint | Buffer | null {
  if (v === undefined) return null;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'bigint' || Buffer.isBuffer(v)) {
    return v as number | string | bigint | Buffer;
  }
  if (t === 'boolean') return (v as boolean) ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  // Fallback: stringify objects (arrays, plain objects, etc.)
  try {
    return JSON.stringify(v);
  } catch (_err) {
    return String(v);
  }
}

/**
 * Normalize an array of values for use as better-sqlite3 binding parameters.
 * Applies {@link normalizeSqliteValue} to each element.
 */
export function normalizeSqliteBindings(values: unknown[]): Array<number | string | bigint | Buffer | null> {
  return values.map(normalizeSqliteValue);
}

export class SqlitePersistentStore {
  private db: Database.Database;
  private dbPath: string;
  private verbose: boolean;
  private _ftsAvailable: boolean = false;

  constructor(dbPath: string, verbose: boolean = false) {
    this.dbPath = dbPath;
    this.verbose = verbose;
    
    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new Error(`Failed to create database directory ${dir}: ${(error as Error).message}`);
      }
    }

    // Open/create database
    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL'); // Better concurrency
      this.db.pragma('foreign_keys = ON');
    } catch (error) {
      throw new Error(`Failed to open database ${dbPath}: ${(error as Error).message}`);
    }
    
    // Initialize schema
    try {
      this.initializeSchema();
    } catch (error) {
      throw new Error(`Failed to initialize database schema: ${(error as Error).message}`);
    }

    // Initialize FTS5 index (best-effort; falls back to app-level search if unavailable)
    this._ftsAvailable = this.initializeFts();
  }

  /**
   * Whether FTS5 full-text search is available in this SQLite build
   */
  get ftsAvailable(): boolean {
    return this._ftsAvailable;
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    // Create metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Create work items table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workitems (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        sortIndex INTEGER NOT NULL DEFAULT 0,
        parentId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        tags TEXT NOT NULL,
        assignee TEXT NOT NULL,
        stage TEXT NOT NULL,
        issueType TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        deletedBy TEXT NOT NULL,
        deleteReason TEXT NOT NULL,
        risk TEXT NOT NULL,
        effort TEXT NOT NULL,
        githubIssueNumber INTEGER,
        githubIssueId INTEGER,
        githubIssueUpdatedAt TEXT
        ,needsProducerReview INTEGER NOT NULL DEFAULT 0
       )
    `);

    // NOTE: Historically this method performed non-destructive schema migrations
    // (ALTER TABLE ADD COLUMN ...) when opening an existing database. That caused
    // silent schema changes on first-run after upgrading the CLI with no backup
    // or audit trail. Migrations are now centralized in src/migrations and
    // surfaced via `wl doctor upgrade` so operators may review and back up the
    // database before applying changes. To preserve compatibility for new
    // databases we still create the necessary tables; however, we no longer
    // modify existing databases here.

    // If the database is newly created (no schemaVersion metadata present) set
    // the current schema version so the migration runner can detect pending
    // migrations on existing DBs. We avoid altering existing databases here.
    const schemaVersionRaw = this.getMetadata('schemaVersion');
    const isNewDb = !schemaVersionRaw;
    if (isNewDb) {
      this.setMetadata('schemaVersion', SCHEMA_VERSION.toString());
    }

    // Determine test environment early so we can suppress operator-facing
    // warnings during automated test runs. Tests MUST create the expected
    // schema via the migration runner (`src/migrations`) or test setup; the
    // persistent store will not modify existing databases in any environment.
    const runningInTest = process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

    // For all environments we avoid performing non-destructive ALTERs here.
    // If the DB is older than the current schema, emit a non-fatal warning for
    // interactive operators but do not change schema silently. In test runs we
    // suppress the warning so test output remains clean — tests should run the
    // migration runner or create schema as part of setup.
    if (!isNewDb) {
      const existingVersion = schemaVersionRaw ? parseInt(schemaVersionRaw, 10) : 1;
      if (existingVersion < SCHEMA_VERSION) {
        // Try to include the pending migration ids to help operators run the
        // appropriate `wl doctor upgrade` command. We deliberately do not
        // perform any schema changes here — migrations are centralized in
        // src/migrations and must be applied via `wl doctor upgrade` so that
        // operators can preview and back up their DB first.
        if (!runningInTest) {
          let pendingMsg = "see 'wl doctor upgrade' to list and apply pending migrations";
          try {
            const pending = listPendingMigrations(this.dbPath);
            if (pending && pending.length > 0) {
              const ids = pending.map(p => p.id).join(', ');
              pendingMsg = `pending migrations: ${ids}. Run 'wl doctor upgrade --dry-run' to preview and '--confirm' to apply`;
            }
          } catch (err) {
            // Best-effort: if listing migrations fails do not throw — emit the
            // warning without the migration list so opening the DB still works.
          }

          console.warn(
            `Worklog: database at ${this.dbPath} has schemaVersion=${existingVersion} but the application expects schemaVersion=${SCHEMA_VERSION}. ` +
            `No automatic schema changes were performed. ${pendingMsg} (migrations live in src/migrations)`
          );
        }
      }
    }

    // Create comments table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        workItemId TEXT NOT NULL,
        author TEXT NOT NULL,
        comment TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        refs TEXT NOT NULL,
        githubCommentId INTEGER,
        githubCommentUpdatedAt TEXT,
      FOREIGN KEY (workItemId) REFERENCES workitems(id) ON DELETE CASCADE
      )
    `);

    // Note: Do not perform ALTERs to existing databases here. The CREATE TABLE
    // above includes the latest comment columns for newly created DBs; upgrades
    // must be performed via the migration runner (`wl doctor upgrade`).

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dependency_edges (
        fromId TEXT NOT NULL,
        toId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (fromId, toId),
        FOREIGN KEY (fromId) REFERENCES workitems(id) ON DELETE CASCADE,
        FOREIGN KEY (toId) REFERENCES workitems(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_workitems_status ON workitems(status);
      CREATE INDEX IF NOT EXISTS idx_workitems_priority ON workitems(priority);
      CREATE INDEX IF NOT EXISTS idx_workitems_sortIndex ON workitems(sortIndex);
      CREATE INDEX IF NOT EXISTS idx_workitems_parent_sortIndex ON workitems(parentId, sortIndex);
      CREATE INDEX IF NOT EXISTS idx_workitems_parentId ON workitems(parentId);
      CREATE INDEX IF NOT EXISTS idx_comments_workItemId ON comments(workItemId);
      CREATE INDEX IF NOT EXISTS idx_dependency_edges_fromId ON dependency_edges(fromId);
      CREATE INDEX IF NOT EXISTS idx_dependency_edges_toId ON dependency_edges(toId);
    `);

    // Existing databases retain their schemaVersion metadata. If an older
    // schemaVersion is present we intentionally do not modify the DB here. The
    // `wl doctor upgrade` workflow should be used to review and apply any
    // required migrations (backups/pruning are handled there).
  }

  /**
   * Get metadata value
   */
  getMetadata(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM metadata WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Set metadata value
   */
  setMetadata(key: string, value: string): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)'
    );
    stmt.run(key, value);
  }

  /**
   * Get all metadata
   */
  getAllMetadata(): DbMetadata {
    const schemaVersion = parseInt(this.getMetadata('schemaVersion') || '1', 10);
    const lastJsonlImportAt = this.getMetadata('lastJsonlImportAt') || undefined;
    const lastJsonlImportMtimeStr = this.getMetadata('lastJsonlImportMtime');
    const lastJsonlImportMtime = lastJsonlImportMtimeStr 
      ? parseInt(lastJsonlImportMtimeStr, 10) 
      : undefined;

    return {
      schemaVersion,
      lastJsonlImportAt,
      lastJsonlImportMtime,
    };
  }

  /**
   * Save a work item
   */
  saveWorkItem(item: WorkItem): void {
    // Use INSERT ... ON CONFLICT DO UPDATE to avoid triggering DELETE (which would cascade and remove comments)
    const stmt = this.db.prepare(`
      INSERT INTO workitems
      (id, title, description, status, priority, sortIndex, parentId, createdAt, updatedAt, tags, assignee, stage, issueType, createdBy, deletedBy, deleteReason, risk, effort, githubIssueNumber, githubIssueId, githubIssueUpdatedAt, needsProducerReview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        sortIndex = excluded.sortIndex,
        parentId = excluded.parentId,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt,
        tags = excluded.tags,
        assignee = excluded.assignee,
        stage = excluded.stage,
        issueType = excluded.issueType,
        createdBy = excluded.createdBy,
        deletedBy = excluded.deletedBy,
        deleteReason = excluded.deleteReason,
        risk = excluded.risk,
        effort = excluded.effort,
        githubIssueNumber = excluded.githubIssueNumber,
        githubIssueId = excluded.githubIssueId,
        githubIssueUpdatedAt = excluded.githubIssueUpdatedAt,
        needsProducerReview = excluded.needsProducerReview
    `);

    // Ensure we never pass `undefined` into better-sqlite3 bindings (it only
    // accepts numbers, strings, bigints, buffers and null). Normalize tags to
    // a JSON string and convert any undefined to null before running.
    const tagsVal = Array.isArray(item.tags) ? JSON.stringify(item.tags) : JSON.stringify([]);
    const values: any[] = [
      item.id,
      item.title,
      item.description,
      item.status,
      item.priority,
      item.sortIndex,
      item.parentId ?? null,
      item.createdAt,
      item.updatedAt,
      tagsVal,
      item.assignee ?? '',
      item.stage ?? '',
      item.issueType ?? '',
      item.createdBy ?? '',
      item.deletedBy ?? '',
      item.deleteReason ?? '',
      item.risk ?? '',
      item.effort ?? '',
      item.githubIssueNumber ?? null,
      item.githubIssueId ?? null,
      item.githubIssueUpdatedAt ?? null,
      item.needsProducerReview ? 1 : 0,
    ];

    const normalized = normalizeSqliteBindings(values);

    // Diagnostic logging: when WL_DEBUG_SQL_BINDINGS is set print the type
    // and a safe representation of each binding before calling stmt.run.
    // This is temporary and intended to help identify unsupported binding
    // types during test runs (e.g. Date objects, functions, symbols).
    if (process.env.WL_DEBUG_SQL_BINDINGS) {
      try {
        // Log the incoming work item shape so we can see unexpected types on properties
        const itemRepr: any = {};
        for (const k of Object.keys(item)) {
          try {
            const v = (item as any)[k];
            itemRepr[k] = { type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null };
          } catch (_e) {
            itemRepr[k] = { type: 'unreadable' };
          }
        }
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem incoming item keys:', JSON.stringify(itemRepr, null, 2));
        const rawRows = values.map((v, i) => ({ index: i, type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null, value: (() => { try { return v; } catch (_) { return '<unreadable>'; } })() }));
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem raw values:', JSON.stringify(rawRows, null, 2));
      } catch (_err) {
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem: failed to prepare raw values log');
      }
    }

    if (process.env.WL_DEBUG_SQL_BINDINGS) {
      const safeRepr = (x: any) => {
        try {
          if (x === null) return 'null';
          if (Buffer.isBuffer(x)) return `<Buffer length=${x.length}>`;
          const t = typeof x;
          if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') return String(x);
          // JSON.stringify may throw for circular structures
          return JSON.stringify(x);
        } catch (err) {
          try {
            return String(x);
          } catch (_e) {
            return '<unserializable>';
          }
        }
      };

      try {
        const rows = normalized.map((v, i) => ({ index: i, type: v === null ? 'null' : typeof v, value: safeRepr(v) }));
        // Use console.error so test runners capture the output even on failures
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem bindings:', JSON.stringify(rows, null, 2));
      } catch (_err) {
        // best-effort logging; do not interfere with normal flow
        console.error('WL_DEBUG_SQL_BINDINGS saveWorkItem: failed to prepare bindings log');
      }
    }

    stmt.run(...normalized);
  }

  /**
   * Get a work item by ID
   */
  getWorkItem(id: string): WorkItem | null {
    const stmt = this.db.prepare('SELECT * FROM workitems WHERE id = ?');
    const row = stmt.get(id) as any;
    
    if (!row) {
      return null;
    }

    return this.rowToWorkItem(row);
  }

  /**
   * Count work items
   */
  countWorkItems(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM workitems');
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get all work items
   */
  getAllWorkItems(): WorkItem[] {
    const stmt = this.db.prepare('SELECT * FROM workitems');
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToWorkItem(row));
  }

  getAllWorkItemsOrderedByHierarchySortIndex(): WorkItem[] {
    const items = this.getAllWorkItems();
    const childrenByParent = new Map<string | null, WorkItem[]>();

    for (const item of items) {
      const parentKey = item.parentId ?? null;
      const list = childrenByParent.get(parentKey);
      if (list) {
        list.push(item);
      } else {
        childrenByParent.set(parentKey, [item]);
      }
    }

    const sortSiblings = (list: WorkItem[]): WorkItem[] => {
      return list.slice().sort((a, b) => {
        if (a.sortIndex !== b.sortIndex) {
          return a.sortIndex - b.sortIndex;
        }
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    };

    const ordered: WorkItem[] = [];
    const traverse = (parentId: string | null) => {
      const children = childrenByParent.get(parentId) || [];
      const sorted = sortSiblings(children);
      for (const child of sorted) {
        ordered.push(child);
        traverse(child.id);
      }
    };

    traverse(null);
    return ordered;
  }

  /**
   * Delete a work item
   */
  deleteWorkItem(id: string): boolean {
    const deleteTransaction = this.db.transaction(() => {
      const result = this.db.prepare('DELETE FROM workitems WHERE id = ?').run(id);
      if (result.changes === 0) {
        return false;
      }
      this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? OR toId = ?').run(id, id);
      this.db.prepare('DELETE FROM comments WHERE workItemId = ?').run(id);
      return true;
    });
    return deleteTransaction();
  }

  /**
   * Clear all work items
   */
  clearWorkItems(): void {
    this.db.prepare('DELETE FROM workitems').run();
  }

  /**
   * Save a comment
   */
  saveComment(comment: Comment): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO comments 
      (id, workItemId, author, comment, createdAt, refs, githubCommentId, githubCommentUpdatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Pre-construction: stringify references, coerce optional fields.
    // Preserve existing || behavior for githubCommentUpdatedAt so that
    // falsy values (including empty string) become null.
    const values: unknown[] = [
      comment.id,
      comment.workItemId,
      comment.author,
      comment.comment,
      comment.createdAt,
      JSON.stringify(comment.references),
      comment.githubCommentId ?? null,
      comment.githubCommentUpdatedAt || null,
    ];

    const normalized = normalizeSqliteBindings(values);
    stmt.run(...normalized);
  }

  /**
   * Get a comment by ID
   */
  getComment(id: string): Comment | null {
    const stmt = this.db.prepare('SELECT * FROM comments WHERE id = ?');
    const row = stmt.get(id) as any;
    
    if (!row) {
      return null;
    }

    return this.rowToComment(row);
  }

  /**
   * Get all comments
   */
  getAllComments(): Comment[] {
    const stmt = this.db.prepare('SELECT * FROM comments');
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToComment(row));
  }

  /**
   * Get comments for a work item
   */
  getCommentsForWorkItem(workItemId: string): Comment[] {
    // Return comments newest-first (reverse chronological order) so clients
    // and CLI can display the most recent discussion first.
    const stmt = this.db.prepare('SELECT * FROM comments WHERE workItemId = ? ORDER BY createdAt DESC');
    const rows = stmt.all(workItemId) as any[];
    return rows.map(row => this.rowToComment(row));
  }

  /**
   * Delete a comment
   */
  deleteComment(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM comments WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Clear all comments
   */
  clearComments(): void {
    this.db.prepare('DELETE FROM comments').run();
  }

  /**
   * Clear all dependency edges
   */
  clearDependencyEdges(): void {
    this.db.prepare('DELETE FROM dependency_edges').run();
  }

  /**
   * Import work items and comments (replaces existing data)
   */
  importData(items: WorkItem[], comments: Comment[]): void {
    // Use a transaction for atomic import
    const importTransaction = this.db.transaction(() => {
      this.clearWorkItems();
      this.clearComments();
      this.db.prepare('DELETE FROM dependency_edges').run();
      
      for (const item of items) {
        this.saveWorkItem(item);
      }
      
      for (const comment of comments) {
        this.saveComment(comment);
      }
    });

    importTransaction();
  }

  /**
   * Create or update a dependency edge
   */
  saveDependencyEdge(edge: DependencyEdge): void {
    const stmt = this.db.prepare(`
      INSERT INTO dependency_edges (fromId, toId, createdAt)
      VALUES (?, ?, ?)
      ON CONFLICT(fromId, toId) DO UPDATE SET
        createdAt = excluded.createdAt
    `);

    const normalized = normalizeSqliteBindings([edge.fromId, edge.toId, edge.createdAt]);
    stmt.run(...normalized);
  }

  /**
   * Remove a dependency edge
   */
  deleteDependencyEdge(fromId: string, toId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? AND toId = ?');
    const result = stmt.run(fromId, toId);
    return result.changes > 0;
  }

  /**
   * List all dependency edges
   */
  getAllDependencyEdges(): DependencyEdge[] {
    const stmt = this.db.prepare('SELECT * FROM dependency_edges');
    const rows = stmt.all() as any[];
    return rows.map(row => this.rowToDependencyEdge(row));
  }

  /**
   * List outbound dependency edges (fromId depends on toId)
   */
  getDependencyEdgesFrom(fromId: string): DependencyEdge[] {
    const stmt = this.db.prepare('SELECT * FROM dependency_edges WHERE fromId = ?');
    const rows = stmt.all(fromId) as any[];
    return rows.map(row => this.rowToDependencyEdge(row));
  }

  /**
   * List inbound dependency edges (items that depend on toId)
   */
  getDependencyEdgesTo(toId: string): DependencyEdge[] {
    const stmt = this.db.prepare('SELECT * FROM dependency_edges WHERE toId = ?');
    const rows = stmt.all(toId) as any[];
    return rows.map(row => this.rowToDependencyEdge(row));
  }

  /**
   * Remove all dependency edges for a work item
   */
  deleteDependencyEdgesForItem(itemId: string): number {
    const stmt = this.db.prepare('DELETE FROM dependency_edges WHERE fromId = ? OR toId = ?');
    const result = stmt.run(itemId, itemId);
    return result.changes;
  }

  // ── FTS5 Full-Text Search ──────────────────────────────────────────

  /**
   * Detect whether FTS5 is available and create the virtual table if so.
   * Returns true when FTS5 is usable, false otherwise (caller should fall
   * back to application-level search).
   */
  private initializeFts(): boolean {
    try {
      // Probe FTS5 availability by attempting to compile a no-op statement
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x)`);
      this.db.exec(`DROP TABLE IF EXISTS _fts5_probe`);
    } catch (_err) {
      // FTS5 extension is not compiled in
      return false;
    }

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS worklog_fts USING fts5(
          title,
          description,
          comments,
          tags,
          itemId UNINDEXED,
          status UNINDEXED,
          parentId UNINDEXED,
          tokenize = 'porter'
        )
      `);
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * Upsert a single work item into the FTS index.
   * Collects all comments for the item and concatenates them into a single
   * text blob so comment content is searchable.
   */
  upsertFtsEntry(item: WorkItem): void {
    if (!this._ftsAvailable) return;

    // Gather comment bodies for this item
    const comments = this.getCommentsForWorkItem(item.id);
    const commentText = comments.map(c => c.comment).join('\n');
    const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';

    // Delete any existing row then insert fresh (FTS5 content tables
    // don't support UPDATE in the same way as regular tables).
    const deleteFts = this.db.prepare(
      `DELETE FROM worklog_fts WHERE itemId = ?`
    );
    const insertFts = this.db.prepare(`
      INSERT INTO worklog_fts (title, description, comments, tags, itemId, status, parentId)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    deleteFts.run(item.id);
    insertFts.run(
      item.title,
      item.description,
      commentText,
      tagsText,
      item.id,
      item.status,
      item.parentId ?? ''
    );
  }

  /**
   * Remove a work item from the FTS index
   */
  deleteFtsEntry(itemId: string): void {
    if (!this._ftsAvailable) return;
    this.db.prepare(`DELETE FROM worklog_fts WHERE itemId = ?`).run(itemId);
  }

  /**
   * Rebuild the entire FTS index from the current workitems and comments tables.
   * This drops and recreates the FTS table then inserts all items.
   */
  rebuildFtsIndex(): { indexed: number } {
    if (!this._ftsAvailable) {
      throw new Error('FTS5 is not available in this SQLite build. Cannot rebuild index.');
    }

    const rebuildTx = this.db.transaction(() => {
      // Drop and recreate
      this.db.exec(`DROP TABLE IF EXISTS worklog_fts`);
      this.db.exec(`
        CREATE VIRTUAL TABLE worklog_fts USING fts5(
          title,
          description,
          comments,
          tags,
          itemId UNINDEXED,
          status UNINDEXED,
          parentId UNINDEXED,
          tokenize = 'porter'
        )
      `);

      const items = this.getAllWorkItems();
      const allComments = this.getAllComments();

      // Group comments by work item id
      const commentsByItem = new Map<string, string[]>();
      for (const c of allComments) {
        const list = commentsByItem.get(c.workItemId);
        if (list) {
          list.push(c.comment);
        } else {
          commentsByItem.set(c.workItemId, [c.comment]);
        }
      }

      const insertFts = this.db.prepare(`
        INSERT INTO worklog_fts (title, description, comments, tags, itemId, status, parentId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of items) {
        const commentText = (commentsByItem.get(item.id) || []).join('\n');
        const tagsText = Array.isArray(item.tags) ? item.tags.join(' ') : '';
        insertFts.run(
          item.title,
          item.description,
          commentText,
          tagsText,
          item.id,
          item.status,
          item.parentId ?? ''
        );
      }

      return items.length;
    });

    const indexed = rebuildTx();
    return { indexed };
  }

  /**
   * Search the FTS index using an FTS5 MATCH expression.
   * Returns results ranked by BM25 relevance (most relevant first).
   *
   * @param query - FTS5 query string (supports phrases, prefix*, OR, AND, NOT)
   * @param options - Optional filters and limits
   */
  searchFts(
    query: string,
    options?: {
      status?: string;
      parentId?: string;
      tags?: string[];
      limit?: number;
      priority?: string;
      assignee?: string;
      stage?: string;
      deleted?: boolean;
      needsProducerReview?: boolean;
      issueType?: string;
    }
  ): FtsSearchResult[] {
    if (!this._ftsAvailable) return [];

    // Sanitize and prepare the query
    const trimmed = query.trim();
    if (!trimmed) return [];

    const limit = options?.limit ?? 50;

    try {
      // Build the base query with BM25 ranking and snippets.
      // We extract snippets from each searchable column and pick the best one.
      // BM25 column weights: title=10, description=5, comments=2, tags=3
      // JOIN with workitems table to support filtering by priority, assignee,
      // stage, issueType, needsProducerReview, and deleted status.
      let sql = `
        SELECT
          worklog_fts.itemId,
          bm25(worklog_fts, 10.0, 5.0, 2.0, 3.0) AS rank,
          snippet(worklog_fts, 0, '<<', '>>', '...', 32) AS title_snippet,
          snippet(worklog_fts, 1, '<<', '>>', '...', 32) AS desc_snippet,
          snippet(worklog_fts, 2, '<<', '>>', '...', 32) AS comment_snippet,
          snippet(worklog_fts, 3, '<<', '>>', '...', 32) AS tags_snippet,
          worklog_fts.status,
          worklog_fts.parentId
        FROM worklog_fts
        JOIN workitems ON worklog_fts.itemId = workitems.id
        WHERE worklog_fts MATCH ?
      `;

      const params: (string | number)[] = [trimmed];

      if (options?.status) {
        sql += ` AND worklog_fts.status = ?`;
        params.push(options.status);
      }

      if (options?.parentId) {
        sql += ` AND worklog_fts.parentId = ?`;
        params.push(options.parentId);
      }

      if (options?.priority) {
        sql += ` AND workitems.priority = ?`;
        params.push(options.priority);
      }

      if (options?.assignee) {
        sql += ` AND workitems.assignee = ?`;
        params.push(options.assignee);
      }

      if (options?.stage) {
        sql += ` AND workitems.stage = ?`;
        params.push(options.stage);
      }

      if (options?.issueType) {
        sql += ` AND workitems.issueType = ?`;
        params.push(options.issueType);
      }

      if (options?.needsProducerReview !== undefined) {
        sql += ` AND workitems.needsProducerReview = ?`;
        params.push(options.needsProducerReview ? 1 : 0);
      }

      // By default exclude deleted items; include them when deleted: true
      if (!options?.deleted) {
        sql += ` AND workitems.status != 'deleted'`;
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as any[];

      const results: FtsSearchResult[] = [];

      for (const row of rows) {
        // Pick the best snippet (the one with highlight markers)
        let snippet = '';
        let matchedColumn = 'title';

        if (row.title_snippet && row.title_snippet.includes('<<')) {
          snippet = row.title_snippet;
          matchedColumn = 'title';
        } else if (row.desc_snippet && row.desc_snippet.includes('<<')) {
          snippet = row.desc_snippet;
          matchedColumn = 'description';
        } else if (row.comment_snippet && row.comment_snippet.includes('<<')) {
          snippet = row.comment_snippet;
          matchedColumn = 'comments';
        } else if (row.tags_snippet && row.tags_snippet.includes('<<')) {
          snippet = row.tags_snippet;
          matchedColumn = 'tags';
        } else {
          // Fallback: use title snippet even without highlights
          snippet = row.title_snippet || '';
          matchedColumn = 'title';
        }

        results.push({
          itemId: row.itemId,
          rank: row.rank,
          snippet,
          matchedColumn,
        });
      }

      // Post-filter by tags (FTS5 can't efficiently filter JSON arrays,
      // so we do this in application code)
      if (options?.tags && options.tags.length > 0) {
        const tagSet = new Set(options.tags.map(t => t.toLowerCase()));
        const filtered: FtsSearchResult[] = [];
        for (const result of results) {
          const item = this.getWorkItem(result.itemId);
          if (item && item.tags.some(t => tagSet.has(t.toLowerCase()))) {
            filtered.push(result);
          }
        }
        return filtered;
      }

      return results;
    } catch (_err) {
      // If the query syntax is invalid, return empty results
      return [];
    }
  }

  /**
   * Perform a simple application-level text search as a fallback when FTS5
   * is not available. Searches title, description, tags and comment bodies
   * using case-insensitive substring matching with basic relevance scoring.
   */
  searchFallback(
    query: string,
    options?: {
      status?: string;
      parentId?: string;
      tags?: string[];
      limit?: number;
      priority?: string;
      assignee?: string;
      stage?: string;
      deleted?: boolean;
      needsProducerReview?: boolean;
      issueType?: string;
    }
  ): FtsSearchResult[] {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];

    const limit = options?.limit ?? 50;
    const terms = trimmed.split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return [];

    let items = this.getAllWorkItems();

    // Apply filters
    if (options?.status) {
      items = items.filter(i => i.status === options.status);
    }
    if (options?.parentId) {
      items = items.filter(i => i.parentId === options.parentId);
    }
    if (options?.tags && options.tags.length > 0) {
      const tagSet = new Set(options.tags.map(t => t.toLowerCase()));
      items = items.filter(i => i.tags.some(t => tagSet.has(t.toLowerCase())));
    }
    if (options?.priority) {
      items = items.filter(i => i.priority === options.priority);
    }
    if (options?.assignee) {
      items = items.filter(i => i.assignee === options.assignee);
    }
    if (options?.stage) {
      items = items.filter(i => i.stage === options.stage);
    }
    if (options?.issueType) {
      items = items.filter(i => i.issueType === options.issueType);
    }
    if (options?.needsProducerReview !== undefined) {
      items = items.filter(i => i.needsProducerReview === options.needsProducerReview);
    }
    // By default exclude deleted items; include them when deleted: true
    if (!options?.deleted) {
      items = items.filter(i => i.status !== 'deleted');
    }

    const allComments = this.getAllComments();
    const commentsByItem = new Map<string, string>();
    for (const c of allComments) {
      const existing = commentsByItem.get(c.workItemId) || '';
      commentsByItem.set(c.workItemId, existing + '\n' + c.comment);
    }

    const results: FtsSearchResult[] = [];

    for (const item of items) {
      const titleLower = item.title.toLowerCase();
      const descLower = item.description.toLowerCase();
      const tagsLower = (item.tags || []).join(' ').toLowerCase();
      const commentLower = (commentsByItem.get(item.id) || '').toLowerCase();

      // Count matching terms across fields (simple TF-like scoring)
      let score = 0;
      let bestField = 'title';
      let bestFieldScore = 0;

      for (const term of terms) {
        const titleHits = this.countOccurrences(titleLower, term) * 10;
        const descHits = this.countOccurrences(descLower, term) * 5;
        const tagHits = this.countOccurrences(tagsLower, term) * 3;
        const commentHits = this.countOccurrences(commentLower, term) * 2;

        score += titleHits + descHits + tagHits + commentHits;

        if (titleHits > bestFieldScore) { bestFieldScore = titleHits; bestField = 'title'; }
        if (descHits > bestFieldScore) { bestFieldScore = descHits; bestField = 'description'; }
        if (commentHits > bestFieldScore) { bestFieldScore = commentHits; bestField = 'comments'; }
        if (tagHits > bestFieldScore) { bestFieldScore = tagHits; bestField = 'tags'; }
      }

      if (score > 0) {
        // Generate a simple snippet from the best matching field
        const fieldText = bestField === 'title' ? item.title
          : bestField === 'description' ? item.description
          : bestField === 'tags' ? (item.tags || []).join(' ')
          : commentsByItem.get(item.id) || '';

        const snippet = this.generateSnippet(fieldText, terms[0], 64);

        results.push({
          itemId: item.id,
          rank: -score, // Negate so higher scores sort first (matching FTS5 BM25 convention)
          snippet,
          matchedColumn: bestField,
        });
      }
    }

    // Sort by rank (most relevant first - lowest rank value for BM25-like convention)
    results.sort((a, b) => a.rank - b.rank);

    return results.slice(0, limit);
  }

  /**
   * Count occurrences of a substring in a string
   */
  private countOccurrences(text: string, sub: string): number {
    if (!sub || !text) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(sub, pos)) !== -1) {
      count++;
      pos += sub.length;
    }
    return count;
  }

  /**
   * Generate a snippet around the first occurrence of a term
   */
  private generateSnippet(text: string, term: string, maxLen: number): string {
    if (!text) return '';
    const lower = text.toLowerCase();
    const termLower = term.toLowerCase();
    const idx = lower.indexOf(termLower);

    if (idx === -1) {
      // Term not found directly, return start of text
      return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
    }

    const halfWindow = Math.floor(maxLen / 2);
    let start = Math.max(0, idx - halfWindow);
    let end = Math.min(text.length, idx + term.length + halfWindow);

    let snippet = '';
    if (start > 0) snippet += '...';
    const raw = text.slice(start, end);
    // Add highlight markers around the term occurrence
    const matchStart = idx - start;
    snippet += raw.slice(0, matchStart) + '<<' + raw.slice(matchStart, matchStart + term.length) + '>>' + raw.slice(matchStart + term.length);
    if (end < text.length) snippet += '...';

    return snippet;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Convert database row to WorkItem
   */
  private rowToWorkItem(row: any): WorkItem {
    try {
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        sortIndex: row.sortIndex ?? 0,
        parentId: row.parentId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        tags: JSON.parse(row.tags),
        assignee: row.assignee,
        stage: row.stage,

        issueType: row.issueType || '',
        createdBy: row.createdBy || '',
        deletedBy: row.deletedBy || '',
        deleteReason: row.deleteReason || '',
        risk: row.risk || '',
        effort: row.effort || '',
        githubIssueNumber: row.githubIssueNumber ?? undefined,
        githubIssueId: row.githubIssueId ?? undefined,
        githubIssueUpdatedAt: row.githubIssueUpdatedAt || undefined,
        needsProducerReview: Boolean(row.needsProducerReview)
      };
    } catch (error) {
      console.error(`Error parsing work item ${row.id}:`, error);
      // Return item with empty tags if parsing fails
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        sortIndex: row.sortIndex ?? 0,
        parentId: row.parentId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        tags: [],
        assignee: row.assignee,
        stage: row.stage,

        issueType: row.issueType || '',
        createdBy: row.createdBy || '',
        deletedBy: row.deletedBy || '',
        deleteReason: row.deleteReason || '',
        risk: row.risk || '',
        effort: row.effort || '',
        githubIssueNumber: row.githubIssueNumber ?? undefined,
        githubIssueId: row.githubIssueId ?? undefined,
        githubIssueUpdatedAt: row.githubIssueUpdatedAt || undefined,
        needsProducerReview: Boolean(row.needsProducerReview),
      };
    }
  }

  /**
   * Convert database row to Comment
   */
  private rowToComment(row: any): Comment {
    try {
      return {
        id: row.id,
        workItemId: row.workItemId,
        author: row.author,
        comment: row.comment,
        createdAt: row.createdAt,
        references: JSON.parse(row.refs),
        githubCommentId: row.githubCommentId ?? undefined,
        githubCommentUpdatedAt: row.githubCommentUpdatedAt || undefined,
      };
    } catch (error) {
      console.error(`Error parsing comment ${row.id}:`, error);
      // Return comment with empty references if parsing fails
      return {
        id: row.id,
        workItemId: row.workItemId,
        author: row.author,
        comment: row.comment,
        createdAt: row.createdAt,
        references: [],
      };
    }
  }

  /**
   * Convert database row to DependencyEdge
   */
  private rowToDependencyEdge(row: any): DependencyEdge {
    return {
      fromId: row.fromId,
      toId: row.toId,
      createdAt: row.createdAt,
    };
  }
}
