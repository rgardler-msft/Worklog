/**
 * Persistent database for work items with SQLite backend
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery, Comment, CreateCommentInput, UpdateCommentInput, NextWorkItemResult, DependencyEdge } from './types.js';
import { SqlitePersistentStore, FtsSearchResult } from './persistent-store.js';
import { importFromJsonl, exportToJsonl, getDefaultDataPath } from './jsonl.js';
import { mergeWorkItems, mergeComments } from './sync.js';
import { withFileLock, getLockPathForJsonl } from './file-lock.js';
import * as searchMetrics from './search-metrics.js';
import { normalizeStatusValue } from './status-stage-rules.js';

const UNIQUE_TIME_LENGTH = 9;
const UNIQUE_RANDOM_BYTES = 4;
const UNIQUE_RANDOM_LENGTH = 7;
const UNIQUE_ID_LENGTH = UNIQUE_TIME_LENGTH + UNIQUE_RANDOM_LENGTH;
const MAX_ID_GENERATION_ATTEMPTS = 10;

export class WorklogDatabase {
  private store: SqlitePersistentStore;
  private prefix: string;
  private jsonlPath: string;
  private autoExport: boolean;
  private silent: boolean;
  private autoSync: boolean;
  private syncProvider?: () => Promise<void>;
  private lockPath: string;

  constructor(
    prefix: string = 'WI',
    dbPath?: string,
    jsonlPath?: string,
    autoExport: boolean = true,
    silent: boolean = false,
    autoSync: boolean = false,
    syncProvider?: () => Promise<void>
  ) {
    this.prefix = prefix;
    this.jsonlPath = jsonlPath || getDefaultDataPath();
    this.autoExport = autoExport;
    this.silent = silent;
    this.autoSync = autoSync;
    this.syncProvider = syncProvider;
    this.lockPath = getLockPathForJsonl(this.jsonlPath);
    
    // Use default DB path if not provided
    const defaultDbPath = path.join(path.dirname(this.jsonlPath), 'worklog.db');
    const actualDbPath = dbPath || defaultDbPath;
    
    this.store = new SqlitePersistentStore(actualDbPath, !silent);
    
    // Refresh from JSONL if needed
    this.refreshFromJsonlIfNewer();
  }

  setAutoSync(enabled: boolean, provider?: () => Promise<void>): void {
    this.autoSync = enabled;
    if (provider) {
      this.syncProvider = provider;
    }
  }

  triggerAutoSync(): void {
    if (!this.autoSync || !this.syncProvider) {
      return;
    }
    void this.syncProvider();
  }

  /**
   * Refresh database from JSONL file if JSONL is newer.
   *
   * This method is intentionally **lockless** — it does not acquire the
   * exclusive file lock.  Because `exportToJsonl()` (in jsonl.ts) already
   * uses atomic write (temp-file + `renameSync`), readers will always see
   * either the old complete file or the new complete file, never a partial
   * write.  Removing the lock from this read path eliminates the contention
   * that previously caused lock timeout errors during concurrent
   * usage by agents and developers.
   *
   * If the JSONL file is transiently unavailable or corrupted (e.g. during
   * an atomic rename race on some filesystems), the method falls back to
   * the existing SQLite cache — see the try-catch around `importFromJsonl`.
   */
  private refreshFromJsonlIfNewer(): void {
    if (!fs.existsSync(this.jsonlPath)) {
      return; // No JSONL file, nothing to refresh from
    }

    try {
      const jsonlStats = fs.statSync(this.jsonlPath);
      const jsonlMtime = jsonlStats.mtimeMs;

      const metadata = this.store.getAllMetadata();
      const lastImportMtime = metadata.lastJsonlImportMtime;
      const lastExportMtimeStr = this.store.getMetadata('lastJsonlExportMtime');
      const lastExportMtime = lastExportMtimeStr ? Number(lastExportMtimeStr) : undefined;

      // If DB is empty or JSONL is newer, refresh from JSONL
      const itemCount = this.store.countWorkItems();
      // Avoid re-importing a file we just exported ourselves. If the JSONL mtime equals the
      // last export mtime recorded in the DB, skip the refresh. Otherwise fall back to the
      // previous logic (DB empty or JSONL newer than last import).
      const isOurExport = lastExportMtime !== undefined && Math.abs(jsonlMtime - lastExportMtime) < 1;
      const shouldRefresh = !isOurExport && (itemCount === 0 || !lastImportMtime || jsonlMtime > lastImportMtime);

      if (shouldRefresh) {
        if (!this.silent) {
          // Debug: send to stderr so JSON stdout is preserved for --json mode
          this.debug(`Refreshing database from ${this.jsonlPath}...`);
        }
        const { items: jsonlItems, comments: jsonlComments, dependencyEdges } = importFromJsonl(this.jsonlPath);
        this.store.importData(jsonlItems, jsonlComments);
        for (const edge of dependencyEdges) {
          if (this.store.getWorkItem(edge.fromId) && this.store.getWorkItem(edge.toId)) {
            this.store.saveDependencyEdge(edge);
          }
        }

        // Update metadata
        this.store.setMetadata('lastJsonlImportMtime', jsonlMtime.toString());
        this.store.setMetadata('lastJsonlImportAt', new Date().toISOString());

        if (!this.silent) {
          this.debug(`Loaded ${jsonlItems.length} work items and ${jsonlComments.length} comments from JSONL`);
        }
      }
    } catch (error) {
      // Graceful fallback: if the JSONL file is transiently unavailable,
      // corrupted, or deleted between our existsSync check and the read,
      // silently fall back to the existing SQLite cache.  This is safe
      // because stale reads are acceptable for all read-only commands.
      if (process.env.WL_DEBUG) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[wl:db] JSONL parse failed, using cached data: ${message}\n`);
      }
    }
  }

  /**
   * Export current database state to JSONL
   */
  private exportToJsonl(): void {
    if (!this.autoExport) {
      return;
    }
    
    const items = this.store.getAllWorkItems();
    const comments = this.store.getAllComments();
    const dependencyEdges = this.store.getAllDependencyEdges();

    // Hold the file lock for the entire read-merge-write cycle to prevent
    // another process from reading a partially-written file or interleaving
    // its own merge while we are writing.
    withFileLock(this.lockPath, () => {
      let itemsToExport = items;
      let commentsToExport = comments;
      if (fs.existsSync(this.jsonlPath)) {
        try {
          const { items: diskItems, comments: diskComments } = importFromJsonl(this.jsonlPath);
          const itemMergeResult = mergeWorkItems(items, diskItems);
          const commentMergeResult = mergeComments(comments, diskComments);
          itemsToExport = itemMergeResult.merged;
          commentsToExport = commentMergeResult.merged;
        } catch (error) {
          if (!this.silent) {
            const message = error instanceof Error ? error.message : String(error);
            this.debug(`WorklogDatabase.exportToJsonl: merge failed, exporting local snapshot. ${message}`);
          }
        }
      }
      if (!this.silent) {
        // Debug: use stderr for diagnostic logs
        this.debug(`WorklogDatabase.exportToJsonl: exporting ${itemsToExport.length} items and ${commentsToExport.length} comments to ${this.jsonlPath}`);
      }
      try {
        const mtime = exportToJsonl(itemsToExport, commentsToExport, this.jsonlPath, dependencyEdges);
        // Record export mtime so other processes can avoid re-importing our own export
        this.store.setMetadata('lastJsonlExportMtime', String(Math.floor(mtime)));
        this.store.setMetadata('lastJsonlExportAt', new Date().toISOString());
      } catch (error) {
        if (!this.silent) {
          const message = error instanceof Error ? error.message : String(error);
          this.debug(`WorklogDatabase.exportToJsonl: failed to write JSONL: ${message}`);
        }
      }
    });
  }

  private debug(message: string): void {
    if (this.silent) return;
    console.error(message);
  }

  private sortItemsByScore(items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem[] {
    const now = Date.now();
    return items.slice().sort((a, b) => {
      const scoreA = this.computeScore(a, now, recencyPolicy);
      const scoreB = this.computeScore(b, now, recencyPolicy);
      if (scoreB !== scoreA) return scoreB - scoreA;
      const createdA = new Date(a.createdAt).getTime();
      const createdB = new Date(b.createdAt).getTime();
      if (createdA !== createdB) return createdA - createdB;
      return a.id.localeCompare(b.id);
    });
  }

  private computeSortIndexOrder(): WorkItem[] {
    const items = this.store.getAllWorkItems();
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

    const order: WorkItem[] = [];
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

    const traverse = (parentId: string | null) => {
      const children = childrenByParent.get(parentId) || [];
      const sorted = sortSiblings(children);
      for (const child of sorted) {
        order.push(child);
        traverse(child.id);
      }
    };

    traverse(null);
    return order;
  }

  assignSortIndexValues(gap: number): { updated: number } {
    const ordered = this.computeSortIndexOrder();
    let updated = 0;
    for (let index = 0; index < ordered.length; index += 1) {
      const item = ordered[index];
      const nextSortIndex = (index + 1) * gap;
      if (item.sortIndex !== nextSortIndex) {
        const updatedItem = {
          ...item,
          sortIndex: nextSortIndex,
          updatedAt: new Date().toISOString(),
        };
        this.store.saveWorkItem(updatedItem);
        updated += 1;
      }
    }
    this.exportToJsonl();
    this.triggerAutoSync();
    return { updated };
  }

  assignSortIndexValuesForItems(orderedItems: WorkItem[], gap: number): { updated: number } {
    let updated = 0;
    for (let index = 0; index < orderedItems.length; index += 1) {
      const item = orderedItems[index];
      const nextSortIndex = (index + 1) * gap;
      if (item.sortIndex !== nextSortIndex) {
        const updatedItem = {
          ...item,
          sortIndex: nextSortIndex,
          updatedAt: new Date().toISOString(),
        };
        this.store.saveWorkItem(updatedItem);
        updated += 1;
      }
    }
    this.exportToJsonl();
    this.triggerAutoSync();
    return { updated };
  }

  previewSortIndexOrder(gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    const ordered = this.computeSortIndexOrder();
    return ordered.map((item, index) => ({
      ...item,
      sortIndex: (index + 1) * gap,
    }));
  }

  previewSortIndexOrderForItems(items: WorkItem[], gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    return items.map((item, index) => ({
      ...item,
      sortIndex: (index + 1) * gap,
    }));
  }

  // ── Full-Text Search ──────────────────────────────────────────────

  /**
   * Whether FTS5 full-text search is available in the underlying SQLite build
   */
  get ftsAvailable(): boolean {
    return this.store.ftsAvailable;
  }

  /**
   * Search work items using full-text search (FTS5) with automatic fallback
   * to application-level search when FTS5 is unavailable.
   *
   * ID-aware behaviour:
   *  1. Exact-ID short-circuit: if a token matches a work item ID exactly
   *     (case-insensitive, with or without the project prefix), the matching
   *     item is returned first with rank = -Infinity.
   *  2. Prefix resolution: bare tokens that look like IDs (alphanumeric,
   *     length >= 8) are tried with the repository's configured prefix.
   *  3. Partial-ID substring: tokens of length >= 8 that are not an exact
   *     match are used for substring matching against all work item IDs.
   *  4. Multi-token queries: each token is checked for ID-likeness; exact
   *     matches come first, then regular FTS/fallback results on the full
   *     original query (duplicates removed).
   */
  search(
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
  ): { results: FtsSearchResult[]; ftsUsed: boolean } {
    searchMetrics.increment('search.total');
    const idResults: FtsSearchResult[] = [];
    const seenIds = new Set<string>();

    const tokens = query.trim().split(/\s+/).filter(t => t.length > 0);
    const prefix = this.getPrefix();

    for (const token of tokens) {
      const upper = token.toUpperCase();

      // --- Exact-ID check (with prefix already present) ---
      if (upper.includes('-')) {
        const item = this.store.getWorkItem(upper);
        if (item && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          idResults.push({
            itemId: item.id,
            rank: -Infinity,
            snippet: item.title,
            matchedColumn: 'id',
          });
          searchMetrics.increment('search.exact_id');
          continue;
        }
      }

      // --- Prefix resolution: bare token → PREFIX-TOKEN ---
      if (!upper.includes('-') && /^[A-Z0-9]+$/.test(upper) && upper.length >= 8) {
        const prefixed = `${prefix}-${upper}`;
        const item = this.store.getWorkItem(prefixed);
        if (item && !seenIds.has(item.id)) {
          seenIds.add(item.id);
          idResults.push({
            itemId: item.id,
            rank: -Infinity,
            snippet: item.title,
            matchedColumn: 'id',
          });
          searchMetrics.increment('search.prefix_resolved');
          continue;
        }
      }

      // --- Partial-ID substring match (>= 8 chars) ---
      // Use the original token (with dashes) for substring search so that
      // prefixed partial IDs like "WL-0MLZVROU" match "WL-0MLZVROU315KLUQX".
      // Also try the cleaned (dash-free) form for bare alphanumeric tokens.
      const cleaned = upper.replace(/[^A-Z0-9]/g, '');
      if (cleaned.length >= 8) {
        const candidates = upper.includes('-') ? [upper, cleaned] : [cleaned];
        for (const substr of candidates) {
          const partials = this.store.findByIdSubstring(substr);
          for (const p of partials) {
            if (!seenIds.has(p.id)) {
              seenIds.add(p.id);
              idResults.push({
                itemId: p.id,
                rank: -1000,
                snippet: p.title,
                matchedColumn: 'id',
              });
              searchMetrics.increment('search.partial_id');
            }
          }
        }
      }
    }

    // --- Regular FTS / fallback search ---
    let ftsUsed = false;
    let ftsResults: FtsSearchResult[] = [];

    if (this.store.ftsAvailable) {
      ftsResults = this.store.searchFts(query, options);
      ftsUsed = true;
      searchMetrics.increment('search.fts');
    } else {
      if (!this.silent) {
        this.debug('FTS5 is not available; falling back to application-level search');
      }
      ftsResults = this.store.searchFallback(query, options);
      searchMetrics.increment('search.fallback');
    }

    // --- Merge: ID results first, then FTS results (deduped) ---
    const merged: FtsSearchResult[] = [...idResults];
    for (const r of ftsResults) {
      if (!seenIds.has(r.itemId)) {
        seenIds.add(r.itemId);
        merged.push(r);
      }
    }

    return { results: merged, ftsUsed };
  }

  /**
   * Rebuild the FTS index from scratch. Useful for backfill or recovery.
   */
  rebuildFtsIndex(): { indexed: number } {
    return this.store.rebuildFtsIndex();
  }

  /**
   * Close the underlying database connection.
   * Must be called before removing temp directories on Windows
   * to release file locks.
   */
  close(): void {
    this.store.close();
  }

  /**
   * Set the prefix for this database
   */
  setPrefix(prefix: string): void {
    this.prefix = prefix;
  }

  /**
   * Get the current prefix
   */
  getPrefix(): string {
    return this.prefix;
  }

  /**
   * Generate a unique ID for a work item
   */
  private generateId(): string {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const id = `${this.prefix}-${this.generateUniqueId()}`;
      if (!this.store.getWorkItem(id)) {
        return id;
      }
    }
    throw new Error('Unable to generate a unique work item ID');
  }

  generateWorkItemId(): string {
    return this.generateId();
  }

  /**
   * Generate a unique ID for a comment (public wrapper)
   */
  generatePublicCommentId(): string {
    return this.generateCommentId();
  }

  /**
   * Generate a unique ID for a comment
   */
  private generateCommentId(): string {
    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const id = `${this.prefix}-C${this.generateUniqueId()}`;
      if (!this.store.getComment(id)) {
        return id;
      }
    }
    throw new Error('Unable to generate a unique comment ID');
  }

  /**
   * Generate a globally unique, human-readable identifier
   */
  private generateUniqueId(): string {
    const timeRaw = Date.now().toString(36).toUpperCase();
    if (timeRaw.length > UNIQUE_TIME_LENGTH) {
      throw new Error('Timestamp overflow while generating unique ID');
    }
    const timePart = timeRaw.padStart(UNIQUE_TIME_LENGTH, '0');
    const randomBytesValue = randomBytes(UNIQUE_RANDOM_BYTES);
    const randomNumber = randomBytesValue.readUInt32BE(0);
    const randomPart = randomNumber.toString(36).toUpperCase().padStart(UNIQUE_RANDOM_LENGTH, '0');
    const id = `${timePart}${randomPart}`;
    if (id.length !== UNIQUE_ID_LENGTH) {
      throw new Error('Generated unique ID has unexpected length');
    }
    return id;
  }

  /**
   * Create a new work item
   */
  create(input: CreateWorkItemInput): WorkItem {
    const id = this.generateId();
    const now = new Date().toISOString();
    
      const item: WorkItem = {
      id,
      title: input.title,
      description: input.description || '',
      status: (normalizeStatusValue(input.status) ?? input.status ?? 'open') as WorkItem['status'],
      priority: input.priority || 'medium',
      sortIndex: input.sortIndex ?? 0,
      parentId: input.parentId || null,
      createdAt: now,
      updatedAt: now,
      tags: input.tags || [],
      assignee: input.assignee || '',
      stage: input.stage || '',

      issueType: input.issueType || '',
      createdBy: input.createdBy || '',
      deletedBy: input.deletedBy || '',
      deleteReason: input.deleteReason || '',
      risk: input.risk || '',
      effort: input.effort || '',
      githubIssueNumber: undefined,
      githubIssueId: undefined,
      githubIssueUpdatedAt: undefined,
      // default for the new flag
      needsProducerReview: input.needsProducerReview ?? false,
    };

    this.store.saveWorkItem(item);
    this.store.upsertFtsEntry(item);
    this.exportToJsonl();
    this.triggerAutoSync();
    return item;
  }

  createWithNextSortIndex(input: CreateWorkItemInput, gap: number = 100): WorkItem {
    const siblings = this.store
      .getAllWorkItems()
      .filter(item => item.parentId === (input.parentId ?? null));
      const ordered = this.orderBySortIndex(siblings);
      const maxSortIndex = ordered.reduce((max, item) => Math.max(max, item.sortIndex ?? 0), 0);
    const sortIndex = maxSortIndex + gap;
    return this.create({ ...input, sortIndex });
  }

  /**
   * Get a work item by ID
   */
  get(id: string): WorkItem | null {
    return this.store.getWorkItem(id);
  }

  /**
   * Update a work item
   */
  update(id: string, input: UpdateWorkItemInput): WorkItem | null {
    this.refreshFromJsonlIfNewer();
    const item = this.store.getWorkItem(id);
    if (!item) {
      return null;
    }

    const previousStatus = item.status;
    const previousStage = item.stage;

    const updated: WorkItem = {
      ...item,
      ...input,
      id: item.id, // Prevent ID changes
      // Normalize status to canonical hyphenated form (e.g. in_progress -> in-progress)
      status: (normalizeStatusValue(input.status ?? item.status) ?? item.status) as WorkItem['status'],
      createdAt: item.createdAt, // Prevent createdAt changes
      updatedAt: new Date().toISOString(),
      githubIssueNumber: item.githubIssueNumber,
      githubIssueId: item.githubIssueId,
      githubIssueUpdatedAt: item.githubIssueUpdatedAt,
    };

    if (process.env.WL_DEBUG_SQL_BINDINGS) {
      try {
        const repr: any = {};
        for (const k of Object.keys(updated)) {
          try {
            const v = (updated as any)[k];
            repr[k] = { type: v === null ? 'null' : typeof v, constructor: v && v.constructor ? v.constructor.name : null };
          } catch (_e) {
            repr[k] = { type: 'unreadable' };
          }
        }
        console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update prepared updated types:', JSON.stringify(repr, null, 2));
        // Also log description to capture non-string values
        try { console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update description value:', (updated as any).description); } catch (_e) { /* ignore */ }
      } catch (_e) {
        console.error('WL_DEBUG_SQL_BINDINGS WorklogDatabase.update: failed to prepare updated log');
      }
    }

    this.store.saveWorkItem(updated);
    this.store.upsertFtsEntry(updated);
    this.exportToJsonl();
    this.triggerAutoSync();

    if (previousStatus !== updated.status || previousStage !== updated.stage) {
      if (this.listDependencyEdgesTo(id).length > 0) {
        this.reconcileDependentsForTarget(id);
      }
    }
    return updated;
  }

  /**
   * Delete a work item
   */
  delete(id: string): boolean {
    this.refreshFromJsonlIfNewer();
    const item = this.store.getWorkItem(id);
    if (!item) {
      return false;
    }

    const updated: WorkItem = {
      ...item,
      status: 'deleted',
      // Preserve the existing stage so UI/clients can still show where the
      // item was in the workflow when it was deleted. Clearing the stage
      // caused unexpected regressions in clients/tests that expect the
      // original stage to be retained.
      stage: item.stage,
      updatedAt: new Date().toISOString(),
    };

    this.store.saveWorkItem(updated);
    this.store.deleteFtsEntry(id);
    this.exportToJsonl();
    this.triggerAutoSync();
    if (this.listDependencyEdgesTo(id).length > 0) {
      this.reconcileDependentsForTarget(id);
    }
    return true;
  }

  /**
   * List all work items
   */
  list(query?: WorkItemQuery): WorkItem[] {
    let items = this.store.getAllWorkItems();

      if (query) {
      if (query.status) {
        // Status values are normalized to hyphenated form on write/import,
        // so we only need to normalize the query parameter for user input.
        const normalizedQueryStatus = normalizeStatusValue(query.status) ?? query.status;
        items = items.filter(item => item.status === normalizedQueryStatus);
      }
      if (query.priority) {
        items = items.filter(item => item.priority === query.priority);
      }
      if (query.parentId !== undefined) {
        items = items.filter(item => item.parentId === query.parentId);
      }
      if (query.tags && query.tags.length > 0) {
        items = items.filter(item => 
          query.tags!.some(tag => item.tags.includes(tag))
        );
      }
      if (query.assignee) {
        items = items.filter(item => item.assignee === query.assignee);
      }
      if (query.stage) {
        items = items.filter(item => item.stage === query.stage);
      }
      if (query.issueType) {
        items = items.filter(item => item.issueType === query.issueType);
      }
      if (query.createdBy) {
        items = items.filter(item => item.createdBy === query.createdBy);
      }
      if (query.deletedBy) {
        items = items.filter(item => item.deletedBy === query.deletedBy);
      }
      if (query.deleteReason) {
        items = items.filter(item => item.deleteReason === query.deleteReason);
      }
      if (query.needsProducerReview !== undefined) {
        items = items.filter(item => Boolean(item.needsProducerReview) === Boolean(query.needsProducerReview));
      }
    }

    return items;
  }

  /**
   * Get children of a work item
   */
  getChildren(parentId: string): WorkItem[] {
    return this.store.getAllWorkItems().filter(
      item => item.parentId === parentId
    );
  }

  /**
   * Get children that are not closed or deleted
   */
  private getNonClosedChildren(parentId: string): WorkItem[] {
    return this.getChildren(parentId).filter(
      item => item.status !== 'completed' && item.status !== 'deleted'
    );
  }

  /**
   * Get all descendants (children, grandchildren, etc.) of a work item
   */
  getDescendants(parentId: string): WorkItem[] {
    const descendants: WorkItem[] = [];
    const children = this.getChildren(parentId);
    
    for (const child of children) {
      descendants.push(child);
      descendants.push(...this.getDescendants(child.id));
    }
    
    return descendants;
  }

  /**
   * Check if a work item is a leaf node (has no children)
   */
  isLeafNode(itemId: string): boolean {
    return this.getChildren(itemId).length === 0;
  }

  /**
   * Get all leaf nodes that are descendants of a parent item
   */
  getLeafDescendants(parentId: string): WorkItem[] {
    const descendants = this.getDescendants(parentId);
    return descendants.filter(item => this.isLeafNode(item.id));
  }

  /**
   * Get the depth of an item in the tree (root = 0)
   */
  private getDepth(itemId: string): number {
    let depth = 0;
    let current = this.get(itemId);

    while (current && current.parentId) {
      depth += 1;
      current = this.get(current.parentId);
    }

    return depth;
  }

  /**
   * Get numeric priority value for comparisons
   */
  private getPriorityValue(priority?: string): number {
    const priorityOrder: { [key: string]: number } = {
      'critical': 4,
      'high': 3,
      'medium': 2,
      'low': 1,
    };

    if (!priority) return 0;
    return priorityOrder[priority] ?? 0;
  }

  /**
   * Compute the effective priority of a candidate work item.
   *
   * Effective priority is the maximum of:
   *   - The item's own priority
   *   - The priority of any active (non-completed, non-deleted) item that
   *     depends on this item (i.e., this item is a prerequisite for)
   *
   * This implements transparent, deterministic priority inheritance:
   * an item that blocks a critical task is elevated to critical effective
   * priority for tie-breaking in sortIndex selection.
   *
   * Results are cached in the optional `cache` map to avoid redundant
   * dependency lookups across a candidate pool.
   *
   * @returns Object with numeric value, human-readable reason, and optional
   *          inheritedFrom item ID
   */
  computeEffectivePriority(
    item: WorkItem,
    cache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>
  ): { value: number; reason: string; inheritedFrom?: string } {
    // Check cache first
    if (cache) {
      const cached = cache.get(item.id);
      if (cached) return cached;
    }

    const ownValue = this.getPriorityValue(item.priority);
    let maxInheritedValue = 0;
    let inheritedFromId: string | undefined;
    let inheritedFromPriority: string | undefined;

    // Check inbound dependency edges: items that depend on this item
    const inboundEdges = this.listDependencyEdgesTo(item.id);
    for (const edge of inboundEdges) {
      const dependent = this.get(edge.fromId);
      if (!dependent) continue;
      // Only inherit from active items (not completed or deleted)
      if (dependent.status === 'completed' || dependent.status === 'deleted') continue;
      const depValue = this.getPriorityValue(dependent.priority);
      if (depValue > maxInheritedValue) {
        maxInheritedValue = depValue;
        inheritedFromId = dependent.id;
        inheritedFromPriority = dependent.priority;
      }
    }

    // Also check if this item is a child that implicitly blocks its parent
    if (item.parentId) {
      const parent = this.get(item.parentId);
      if (parent && parent.status !== 'completed' && parent.status !== 'deleted') {
        // A non-closed child blocks its parent — inherit parent's priority
        const parentValue = this.getPriorityValue(parent.priority);
        if (parentValue > maxInheritedValue) {
          maxInheritedValue = parentValue;
          inheritedFromId = parent.id;
          inheritedFromPriority = parent.priority;
        }
      }
    }

    const effectiveValue = Math.max(ownValue, maxInheritedValue);

    let result: { value: number; reason: string; inheritedFrom?: string };
    if (effectiveValue > ownValue && inheritedFromId) {
      result = {
        value: effectiveValue,
        reason: `effective priority: ${inheritedFromPriority}, inherited from ${inheritedFromId}`,
        inheritedFrom: inheritedFromId,
      };
    } else {
      result = {
        value: ownValue,
        reason: `own priority: ${item.priority || 'none'}`,
      };
    }

    // Cache the result
    if (cache) {
      cache.set(item.id, result);
    }

    return result;
  }

  /**
   * Compute a score for an item. Defaults: recencyPolicy='ignore'.
   * Higher score == more desirable.
   */
   private computeScore(item: WorkItem, now: number, recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): number {
    // Weights are intentionally fixed and not configurable per request
    //
    // Ranking precedence (highest to lowest):
    //   1. priority          — primary ranking (weight 1000 per level)
    //   2. blocksHighPriority — boost for items that unblock high/critical work
    //   3. blocked penalty   — heavy penalty for blocked items
    //   4. age / effort / recency — fine-grained tie-breakers
    const WEIGHTS = {
      priority: 1000,
      blocksHighPriority: 500,  // boost when this item unblocks high/critical items
      age: 10, // per day
      updated: 100, // recency boost/penalty
      blocked: -10000,
      effort: 20,
    };

    let score = 0;

    // Priority base
    score += this.getPriorityValue(item.priority) * WEIGHTS.priority;

    // Blocks-high-priority boost: if this item is a dependency prerequisite for
    // active items with high or critical priority, add a proportional boost.
    // This ensures that among equal-priority peers, unblockers rank higher.
    // Uses store-direct access to avoid per-item refreshFromJsonlIfNewer overhead
    // (consistent with the dependency filter in buildCandidateList).
    const inboundEdges = this.store.getDependencyEdgesTo(item.id);
    let maxBlockedPriorityValue = 0;
    for (const edge of inboundEdges) {
      const dependent = this.store.getWorkItem(edge.fromId);
      if (dependent && dependent.status !== 'completed' && dependent.status !== 'deleted') {
        const depPriority = this.getPriorityValue(dependent.priority);
        // Only boost for high (3) or critical (4) dependents
        if (depPriority >= 3 && depPriority > maxBlockedPriorityValue) {
          maxBlockedPriorityValue = depPriority;
        }
      }
    }
    if (maxBlockedPriorityValue > 0) {
      // Proportional: critical (4) gets a larger boost than high (3).
      // Scale: high=1.0x, critical=1.33x of the base weight.
      score += (maxBlockedPriorityValue / 3) * WEIGHTS.blocksHighPriority;
    }

    // Age (createdAt) - small boost per day to avoid starvation
    const ageDays = Math.max(0, (now - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    score += Math.min(ageDays, 365) * WEIGHTS.age;

    // Effort: prefer smaller numeric efforts if present
    if (item.effort) {
      const effortVal = parseFloat(String(item.effort)) || 0;
      if (effortVal > 0) score += (1 / (1 + effortVal)) * WEIGHTS.effort;
    }

    // UpdatedAt recency policy
    if (recencyPolicy !== 'ignore' && item.updatedAt) {
      const updatedHours = (now - new Date(item.updatedAt).getTime()) / (1000 * 60 * 60);
      if (recencyPolicy === 'avoid') {
        // Penalty stronger when updated very recently, decays to zero by 72 hours
        const penaltyFactor = Math.max(0, (72 - updatedHours) / 72);
        score -= penaltyFactor * WEIGHTS.updated;
      } else if (recencyPolicy === 'prefer') {
        // Boost for recent updates (peak within ~48 hours)
        const boostFactor = Math.max(0, (48 - updatedHours) / 48);
        score += boostFactor * WEIGHTS.updated;
      }
    }

    // Blocked status - heavy penalty
    if (item.status === 'blocked') score += WEIGHTS.blocked;

    return score;
  }

  private orderBySortIndex(items: WorkItem[]): WorkItem[] {
    const orderedAll = this.store.getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted();
    const positions = new Map(orderedAll.map((item, index) => [item.id, index]));
    return items.slice().sort((a, b) => {
      const aPos = positions.get(a.id);
      const bPos = positions.get(b.id);
      if (aPos === undefined && bPos === undefined) {
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      }
      if (aPos === undefined) return 1;
      if (bPos === undefined) return -1;
      if (aPos !== bPos) return aPos - bPos;
      return a.id.localeCompare(b.id);
    });
  }

  private selectBySortIndex(
    items: WorkItem[],
    effectivePriorityCache?: Map<string, { value: number; reason: string; inheritedFrom?: string }>
  ): WorkItem | null {
    if (!items || items.length === 0) return null;
    // When all sortIndex values are the same (including all-zero), fall back to
    // effective priority (descending) then createdAt (ascending / oldest first).
    // Effective priority accounts for priority inheritance from blocked dependents.
    const firstSortIndex = items[0].sortIndex ?? 0;
    const allSame = items.every(item => (item.sortIndex ?? 0) === firstSortIndex);
    if (allSame) {
      const cache = effectivePriorityCache ?? new Map();
      const sorted = items.slice().sort((a, b) => {
        const aEffective = this.computeEffectivePriority(a, cache);
        const bEffective = this.computeEffectivePriority(b, cache);
        const priDiff = bEffective.value - aEffective.value;
        if (priDiff !== 0) return priDiff;
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
      return sorted[0] ?? null;
    }
    return this.orderBySortIndex(items)[0] ?? null;
  }

  /**
   * Consolidated filter pipeline for wl next candidate selection.
   *
   * Removes non-actionable items in a single pass and returns two pools:
   *   - candidates: fully filtered items ready for selection
   *   - criticalPool: items filtered before dep-blocking, with assignee/search
   *     applied, so that critical-path escalation can still find blocked
   *     critical items and surface their blockers
   *
   * Filter stages (in order):
   *   1. Remove deleted items
   *   2. Remove completed items
   *   3. Remove in-progress items (wl next skips items already being worked on)
   *   4. Remove in_review+blocked items (unless includeInReview)
   *   5. Remove excluded items (batch mode)
   *   6. Apply assignee and search filters
   *   --- criticalPool snapshot taken here ---
   *   7. Remove dependency-blocked items (unless includeBlocked)
   */
  private filterCandidates(
    items: WorkItem[],
    options: {
      assignee?: string;
      searchTerm?: string;
      excluded?: Set<string>;
      includeInReview?: boolean;
      includeBlocked?: boolean;
      debugPrefix?: string;
    } = {}
  ): { candidates: WorkItem[]; criticalPool: WorkItem[] } {
    const {
      assignee,
      searchTerm,
      excluded,
      includeInReview = false,
      includeBlocked = false,
      debugPrefix = '[filter]',
    } = options;

    let pool = items;
    this.debug(`${debugPrefix} filter: total=${pool.length}`);

    // 1. Remove deleted items
    pool = pool.filter(item => item.status !== 'deleted');
    this.debug(`${debugPrefix} filter: after deleted=${pool.length}`);

    // 2. Remove completed items
    pool = pool.filter(item => item.status !== 'completed');
    this.debug(`${debugPrefix} filter: after completed=${pool.length}`);

    // 3. Remove in-progress items (wl next recommends what to work on next,
    //    not what's already being worked on)
    pool = pool.filter(item => item.status !== 'in-progress');
    this.debug(`${debugPrefix} filter: after in-progress=${pool.length}`);

    // 4. Remove in_review+blocked items unless opted in
    if (!includeInReview) {
      pool = pool.filter(
        item => !(item.stage === 'in_review' && item.status === 'blocked')
      );
      this.debug(`${debugPrefix} filter: after in_review+blocked=${pool.length}`);
    }

    // 5. Remove excluded items (batch mode)
    if (excluded && excluded.size > 0) {
      pool = pool.filter(item => !excluded.has(item.id));
      this.debug(`${debugPrefix} filter: after excluded=${pool.length}`);
    }

    // 6. Apply assignee and search filters
    pool = this.applyFilters(pool, assignee, searchTerm);
    this.debug(`${debugPrefix} filter: after assignee/search=${pool.length}`);

    // Snapshot for critical-path escalation (before dep-blocker removal)
    const criticalPool = pool;

    // 7. Remove dependency-blocked items unless opted in
    let candidates = pool;
    if (!includeBlocked) {
      candidates = pool.filter(item => {
        const edges = this.store.getDependencyEdgesFrom(item.id);
        for (const edge of edges) {
          const target = this.store.getWorkItem(edge.toId);
          if (this.isDependencyActive(target ?? null)) {
            return false;
          }
        }
        return true;
      });
      this.debug(`${debugPrefix} filter: after dep-blocked=${candidates.length}`);
    }

    return { candidates, criticalPool };
  }

  /**
   * Build a fully-ordered candidate list for `wl next` selection.
   *
   * The list is built once and can be sliced for both single-item and batch
   * mode, eliminating the O(N*M) per-iteration rebuild of the old batch loop.
   *
   * Ordering tiers (earlier tiers always precede later tiers):
   *   1. Critical escalation — unblocked criticals, then blockers of blocked
   *      criticals, then blocked criticals themselves as a last resort.
   *   2. Non-critical blocker surfacing — blockers of blocked items whose
   *      priority >= the best open competitor.
   *   3. Normal candidates — leaf items (no actionable children in the
   *      candidate set) ordered by hierarchical sortIndex position, with
   *      effective priority (descending) then createdAt (ascending) as
   *      tiebreakers when sortIndex values are equal.
   *
   * @returns Ordered array of NextWorkItemResult entries, longest possible
   *          for the given filters.  Callers take `.slice(0, n)` for batch.
   */
  buildCandidateList(
    items: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    includeInReview: boolean = false,
    includeBlocked: boolean = false,
    debugPrefix: string = '[next]'
  ): NextWorkItemResult[] {
    this.debug(`${debugPrefix} buildCandidateList assignee=${assignee || ''} search=${searchTerm || ''}`);

    const results: NextWorkItemResult[] = [];
    const seen = new Set<string>();

    // Shared effective-priority cache across all ordering operations
    const effectivePriorityCache = new Map<string, { value: number; reason: string; inheritedFrom?: string }>();

    // Pre-compute hierarchy positions once for the entire candidate list build
    const orderedAll = this.store.getAllWorkItemsOrderedByHierarchySortIndexSkipCompleted();
    const hierarchyPositions = new Map(orderedAll.map((item, index) => [item.id, index]));

    // ── Stage 1: Filter pipeline ──
    const { candidates: filteredItems, criticalPool } = this.filterCandidates(items, {
      assignee,
      searchTerm,
      includeInReview,
      includeBlocked,
      debugPrefix,
    });

    // ── Stage 2: Critical escalation ──
    // Collect ALL critical escalation results in priority order.
    // Operates on the full item set so cross-assignee blocker surfacing works.
    const criticalResults = this.collectCriticalEscalationResults(items, {
      assignee,
      searchTerm,
      includeInReview,
      debugPrefix: `${debugPrefix} [critical]`,
      hierarchyPositions,
      effectivePriorityCache,
    });
    for (const r of criticalResults) {
      if (r.workItem && !seen.has(r.workItem.id)) {
        results.push(r);
        seen.add(r.workItem.id);
      }
    }

    // ── Stage 3: Non-critical blocker surfacing ──
    const blockerResults = this.collectBlockerSurfacingResults(
      criticalPool,
      filteredItems,
      assignee,
      searchTerm,
      hierarchyPositions,
      debugPrefix,
    );
    for (const r of blockerResults) {
      if (r.workItem && !seen.has(r.workItem.id)) {
        results.push(r);
        seen.add(r.workItem.id);
      }
    }

    // ── Stage 4: In-progress parent descent ──
    // In-progress items are excluded from filteredItems, but if an in-progress
    // item has actionable children we should recommend those direct children.
    // This mirrors the old descent behavior: when a parent is in-progress,
    // recommend its direct children rather than descending to the deepest leaf.
    const inProgressItems = this.applyFilters(
      items.filter(item => item.status === 'in-progress'),
      assignee,
      searchTerm
    );
    this.debug(`${debugPrefix} in-progress parents=${inProgressItems.length}`);

    if (inProgressItems.length > 0) {
      // Sort in-progress items to determine which one to descend into first
      const sortedInProgress = this.sortByHierarchyWithEffectivePriority(
        inProgressItems,
        hierarchyPositions,
        effectivePriorityCache,
      );

      for (const ipItem of sortedInProgress) {
        // Find direct children of this in-progress item in the candidate pool
        const directChildren = filteredItems.filter(
          item => item.parentId === ipItem.id
        );
        if (directChildren.length === 0) continue;

        // Sort direct children and add them to results
        const sortedChildren = this.sortByHierarchyWithEffectivePriority(
          directChildren,
          hierarchyPositions,
          effectivePriorityCache,
        );

        for (const child of sortedChildren) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);

          const effectiveInfo = this.computeEffectivePriority(child, effectivePriorityCache);
          const priorityInfo = effectiveInfo.inheritedFrom
            ? effectiveInfo.reason
            : `priority ${child.priority}`;

          results.push({
            workItem: child,
            reason: `Next child by sort_index of in-progress item ${ipItem.id} (${priorityInfo})`
          });
        }
      }
    }

    // ── Stage 5: Normal candidate ordering (root-then-descend) ──
    // Identify root candidates: items whose parent is not in the candidate set.
    // Sort roots by hierarchy position with effective priority tiebreaker.
    // For each root, descend recursively to find the leaf, preserving the
    // semantic that root-level competition determines subtree ordering.
    const candidateIds = new Set(filteredItems.map(item => item.id));
    const rootCandidates = filteredItems.filter(item =>
      !item.parentId || !candidateIds.has(item.parentId)
    );

    this.debug(`${debugPrefix} root candidates=${rootCandidates.length} (from ${filteredItems.length} filtered)`);

    // Sort roots by hierarchy position with effective priority tiebreaker
    const sortedRoots = this.sortByHierarchyWithEffectivePriority(
      rootCandidates,
      hierarchyPositions,
      effectivePriorityCache,
    );

    // For each root, descend to find the leaf candidate, then add to results
    for (const root of sortedRoots) {
      // Descend recursively: at each level pick the best child
      let current = root;
      let depth = 0;
      const maxDepth = 15; // Guard against circular references
      while (depth < maxDepth) {
        const children = filteredItems.filter(item =>
          item.parentId === current.id
        );
        if (children.length === 0) break;

        const bestChild = this.sortByHierarchyWithEffectivePriority(
          children,
          hierarchyPositions,
          effectivePriorityCache,
        )[0];
        if (!bestChild) break;

        current = bestChild;
        depth++;
      }

      // current is now the leaf for this root's subtree
      if (seen.has(current.id)) continue;
      seen.add(current.id);

      const effectiveInfo = this.computeEffectivePriority(current, effectivePriorityCache);
      const priorityInfo = effectiveInfo.inheritedFrom
        ? effectiveInfo.reason
        : `priority ${current.priority}`;

      if (current.id !== root.id) {
        results.push({
          workItem: current,
          reason: `Next child by sort_index of open item ${root.id} (${priorityInfo})`
        });
      } else {
        results.push({
          workItem: current,
          reason: `Next open item by sort_index (${priorityInfo})`
        });
      }
    }

    this.debug(`${debugPrefix} buildCandidateList total=${results.length}`);
    return results;
  }

  /**
   * Collect ALL critical escalation results in priority order.
   *
   * Unlike handleCriticalEscalation() which returns the single best result,
   * this method returns an ordered list of all critical escalation candidates
   * for use in batch mode.
   */
  private collectCriticalEscalationResults(
    allItems: WorkItem[],
    options: {
      assignee?: string;
      searchTerm?: string;
      includeInReview?: boolean;
      debugPrefix?: string;
      hierarchyPositions: Map<string, number>;
      effectivePriorityCache: Map<string, { value: number; reason: string; inheritedFrom?: string }>;
    }
  ): NextWorkItemResult[] {
    const {
      assignee,
      searchTerm,
      includeInReview = false,
      debugPrefix = '[critical]',
      hierarchyPositions,
      effectivePriorityCache,
    } = options;

    const results: NextWorkItemResult[] = [];

    // Find all critical items from the full set
    const criticalItems = allItems.filter(
      item =>
        item.priority === 'critical' &&
        item.status !== 'deleted' &&
        item.status !== 'completed' &&
        item.status !== 'in-progress' &&
        (includeInReview || !(item.stage === 'in_review' && item.status === 'blocked'))
    );
    this.debug(`${debugPrefix} critical items from full set=${criticalItems.length}`);

    if (criticalItems.length === 0) return results;

    // ── Unblocked criticals ──
    const unblockedCriticals = criticalItems.filter(
      item => item.status !== 'blocked' && this.getNonClosedChildren(item.id).length === 0
    );
    const selectableUnblocked = this.applyFilters(unblockedCriticals, assignee, searchTerm);
    const sortedUnblocked = this.sortByHierarchyWithEffectivePriority(
      selectableUnblocked,
      hierarchyPositions,
      effectivePriorityCache,
    );
    for (const item of sortedUnblocked) {
      results.push({
        workItem: item,
        reason: `Next unblocked critical item by sort_index (priority ${item.priority})`
      });
    }

    // ── Blockers of blocked criticals ──
    const blockedCriticals = criticalItems.filter(item => item.status === 'blocked');
    if (blockedCriticals.length > 0) {
      const blockingPairs: { blocking: WorkItem; critical: WorkItem }[] = [];

      for (const critical of blockedCriticals) {
        const blockingChildren = this.getNonClosedChildren(critical.id);
        for (const child of blockingChildren) {
          blockingPairs.push({ blocking: child, critical });
        }
        const dependencyBlockers = this.getActiveDependencyBlockers(critical.id);
        for (const blocker of dependencyBlockers) {
          blockingPairs.push({ blocking: blocker, critical });
        }
      }

      // Apply assignee/search filters to blockers
      const filteredPairs = blockingPairs.filter(pair =>
        this.applyFilters([pair.blocking], assignee, searchTerm).length > 0
      );

      // Sort by: critical item priority (desc), then blocker hierarchy position
      const sortedPairs = filteredPairs.slice().sort((a, b) => {
        const critPriDiff = this.getPriorityValue(b.critical.priority) - this.getPriorityValue(a.critical.priority);
        if (critPriDiff !== 0) return critPriDiff;
        const aPos = hierarchyPositions.get(a.blocking.id) ?? Infinity;
        const bPos = hierarchyPositions.get(b.blocking.id) ?? Infinity;
        return aPos - bPos;
      });

      const seenBlockers = new Set<string>();
      for (const pair of sortedPairs) {
        if (seenBlockers.has(pair.blocking.id)) continue;
        seenBlockers.add(pair.blocking.id);
        results.push({
          workItem: pair.blocking,
          reason: `Blocking issue for critical item ${pair.critical.id} (${pair.critical.title})`
        });
      }

      // Fallback: blocked criticals themselves (if no blockers were found)
      if (filteredPairs.length === 0) {
        const selectableBlocked = this.applyFilters(blockedCriticals, assignee, searchTerm);
        const sortedBlocked = this.sortByHierarchyWithEffectivePriority(
          selectableBlocked.length > 0 ? selectableBlocked : blockedCriticals,
          hierarchyPositions,
          effectivePriorityCache,
        );
        for (const item of sortedBlocked) {
          results.push({
            workItem: item,
            reason: 'Blocked critical work item with no identifiable blocking issues'
          });
        }
      }
    }

    this.debug(`${debugPrefix} critical escalation results=${results.length}`);
    return results;
  }

  /**
   * Collect ALL non-critical blocker surfacing results in priority order.
   */
  private collectBlockerSurfacingResults(
    criticalPool: WorkItem[],
    filteredItems: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    hierarchyPositions?: Map<string, number>,
    debugPrefix: string = '[next]'
  ): NextWorkItemResult[] {
    const results: NextWorkItemResult[] = [];

    const nonCriticalBlocked = criticalPool.filter(
      item => item.status === 'blocked' && item.priority !== 'critical'
    );
    this.debug(`${debugPrefix} non-critical blocked=${nonCriticalBlocked.length}`);

    if (nonCriticalBlocked.length === 0 || filteredItems.length === 0) return results;

    // Find the highest priority value among open candidates
    const bestCompetitorPriority = Math.max(
      ...filteredItems.map(item => this.getPriorityValue(item.priority))
    );

    // Sort blocked items by priority descending
    const sortedBlocked = nonCriticalBlocked.slice().sort(
      (a, b) => this.getPriorityValue(b.priority) - this.getPriorityValue(a.priority)
    );

    const seenBlockers = new Set<string>();

    for (const blockedItem of sortedBlocked) {
      const blockedPriority = this.getPriorityValue(blockedItem.priority);
      if (blockedPriority < bestCompetitorPriority) continue;

      const blockingPairs: { blocking: WorkItem; blocked: WorkItem }[] = [];

      const dependencyBlockers = this.getActiveDependencyBlockers(blockedItem.id);
      for (const blocker of dependencyBlockers) {
        blockingPairs.push({ blocking: blocker, blocked: blockedItem });
      }

      const blockingChildren = this.getNonClosedChildren(blockedItem.id);
      for (const child of blockingChildren) {
        blockingPairs.push({ blocking: child, blocked: blockedItem });
      }

      // Apply assignee/search filters to blockers
      const filteredBlockers = blockingPairs.filter(pair =>
        this.applyFilters([pair.blocking], assignee, searchTerm).length > 0
      );

      this.debug(`${debugPrefix} blocker-surfacing: blockedItem=${blockedItem.id} pri=${blockedItem.priority} blockers=${filteredBlockers.length}`);

      // Sort blockers by hierarchy position
      const positions = hierarchyPositions ?? new Map<string, number>();
      const orderedPairs = filteredBlockers.slice().sort((a, b) => {
        const aPos = positions.get(a.blocking.id) ?? Infinity;
        const bPos = positions.get(b.blocking.id) ?? Infinity;
        return aPos - bPos;
      });

      for (const pair of orderedPairs) {
        if (seenBlockers.has(pair.blocking.id)) continue;
        seenBlockers.add(pair.blocking.id);
        results.push({
          workItem: pair.blocking,
          reason: `Blocking issue for ${pair.blocked.priority}-priority item ${pair.blocked.id} (${pair.blocked.title})`
        });
      }
    }

    return results;
  }

  /**
   * Sort items by hierarchical sort-index position, with effective priority
   * (descending) then createdAt (ascending) as tiebreakers when all
   * sortIndex values are equal.
   *
   * Uses pre-computed hierarchy positions to avoid rebuilding the hierarchy
   * tree for each sort operation.
   */
  private sortByHierarchyWithEffectivePriority(
    items: WorkItem[],
    hierarchyPositions: Map<string, number>,
    effectivePriorityCache: Map<string, { value: number; reason: string; inheritedFrom?: string }>
  ): WorkItem[] {
    if (items.length === 0) return [];

    // Check if all sortIndex values are equal (including all-zero)
    const firstSortIndex = items[0].sortIndex ?? 0;
    const allSameSortIndex = items.every(item => (item.sortIndex ?? 0) === firstSortIndex);

    if (allSameSortIndex) {
      // Fall back to effective priority (desc) → createdAt (asc) → id
      return items.slice().sort((a, b) => {
        const aEffective = this.computeEffectivePriority(a, effectivePriorityCache);
        const bEffective = this.computeEffectivePriority(b, effectivePriorityCache);
        const priDiff = bEffective.value - aEffective.value;
        if (priDiff !== 0) return priDiff;
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      });
    }

    // Use pre-computed hierarchy positions
    return items.slice().sort((a, b) => {
      const aPos = hierarchyPositions.get(a.id);
      const bPos = hierarchyPositions.get(b.id);
      if (aPos === undefined && bPos === undefined) {
        const createdDiff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        if (createdDiff !== 0) return createdDiff;
        return a.id.localeCompare(b.id);
      }
      if (aPos === undefined) return 1;
      if (bPos === undefined) return -1;
      if (aPos !== bPos) return aPos - bPos;
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Find the next work item to work on based on priority and creation time.
   *
   * Delegates to buildCandidateList() and returns the first result.
   *
   * @param assignee - Optional assignee filter
   * @param searchTerm - Optional search term for fuzzy matching
   * @returns The next work item and a reason for the selection, or null if none found
   */
  findNextWorkItem(
    assignee?: string,
    searchTerm?: string,
    includeInReview: boolean = false,
    includeBlocked: boolean = false
  ): NextWorkItemResult {
    const items = this.store.getAllWorkItems();
    const candidates = this.buildCandidateList(items, assignee, searchTerm, includeInReview, includeBlocked, '[next]');
    return candidates[0] ?? { workItem: null, reason: 'No actionable work items available' };
  }

  /**
   * Find multiple next work items (up to `count`) using the same selection
   * logic as `findNextWorkItem`.
   *
   * Builds the candidate list once and takes the first `count` results,
   * avoiding the O(N*M) per-iteration rebuild of the previous implementation.
   */
  findNextWorkItems(
    count: number,
    assignee?: string,
    searchTerm?: string,
    includeInReview: boolean = false,
    includeBlocked: boolean = false
  ): NextWorkItemResult[] {
    const items = this.store.getAllWorkItems();
    const candidates = this.buildCandidateList(items, assignee, searchTerm, includeInReview, includeBlocked, '[next batch]');
    const results = candidates.slice(0, count);
    // Ensure at least one result entry for callers that expect results[0]
    if (results.length === 0) {
      results.push({ workItem: null, reason: 'No work items available' });
    }
    return results;
  }

  /**
   * Apply assignee and search term filters to a list of work items
   */
  private applyFilters(items: WorkItem[], assignee?: string, searchTerm?: string): WorkItem[] {
    let filtered = items;

    // Filter by assignee if provided
    if (assignee) {
      filtered = filtered.filter(item => item.assignee === assignee);
    }

    // Filter by search term if provided (fuzzy match against id, title, description, and comments)
    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();
      filtered = filtered.filter(item => {
        const idMatch = item.id.toLowerCase().includes(lowerSearchTerm);
        // Check title and description
        const titleMatch = item.title.toLowerCase().includes(lowerSearchTerm);
        const descriptionMatch = item.description?.toLowerCase().includes(lowerSearchTerm) || false;
        
        // Check comments
        const comments = this.getCommentsForWorkItem(item.id);
        const commentMatch = comments.some(comment => 
          comment.comment.toLowerCase().includes(lowerSearchTerm)
        );
        
        return idMatch || titleMatch || descriptionMatch || commentMatch;
      });
    }

    return filtered;
  }

  /**
   * Clear all work items (useful for import)
   */
  clear(): void {
    this.store.clearWorkItems();
  }

  /**
   * Get all work items as an array
   */
  getAll(): WorkItem[] {
    return this.store.getAllWorkItems();
  }

  getAllOrderedByHierarchySortIndex(): WorkItem[] {
    return this.store.getAllWorkItemsOrderedByHierarchySortIndex();
  }

  getAllOrderedByScore(recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem[] {
    return this.sortItemsByScore(this.store.getAllWorkItems(), recencyPolicy);
  }

  /**
   * Import work items (replaces existing data)
   */
  import(items: WorkItem[], dependencyEdges?: DependencyEdge[]): void {
    this.store.clearWorkItems();
    for (const item of items) {
      this.store.saveWorkItem(item);
    }
    if (dependencyEdges) {
      this.store.clearDependencyEdges();
      for (const edge of dependencyEdges) {
        if (this.store.getWorkItem(edge.fromId) && this.store.getWorkItem(edge.toId)) {
          this.store.saveDependencyEdge(edge);
        }
      }
    }
    this.exportToJsonl();
    this.triggerAutoSync();
  }

  /**
   * Add a dependency edge (fromId depends on toId)
   */
  addDependencyEdge(fromId: string, toId: string): DependencyEdge | null {
    this.refreshFromJsonlIfNewer();
    if (!this.store.getWorkItem(fromId) || !this.store.getWorkItem(toId)) {
      return null;
    }

    const edge: DependencyEdge = {
      fromId,
      toId,
      createdAt: new Date().toISOString(),
    };

    this.store.saveDependencyEdge(edge);
    this.exportToJsonl();
    this.triggerAutoSync();
    return edge;
  }

  /**
   * Remove a dependency edge (fromId depends on toId)
   */
  removeDependencyEdge(fromId: string, toId: string): boolean {
    this.refreshFromJsonlIfNewer();
    const removed = this.store.deleteDependencyEdge(fromId, toId);
    if (removed) {
      this.exportToJsonl();
      this.triggerAutoSync();
    }
    return removed;
  }

  /**
   * List outbound dependency edges (fromId depends on toId)
   */
  listDependencyEdgesFrom(fromId: string): DependencyEdge[] {
    this.refreshFromJsonlIfNewer();
    return this.store.getDependencyEdgesFrom(fromId);
  }

  /**
   * List inbound dependency edges (items that depend on toId)
   */
  listDependencyEdgesTo(toId: string): DependencyEdge[] {
    this.refreshFromJsonlIfNewer();
    return this.store.getDependencyEdgesTo(toId);
  }

  private isDependencyActive(target: WorkItem | null): boolean {
    if (!target) {
      return false;
    }
    if (target.status === 'completed' || target.status === 'deleted') {
      return false;
    }
    if (target.stage === 'in_review' || target.stage === 'done') {
      return false;
    }
    return true;
  }

  private getActiveDependencyBlockers(itemId: string): WorkItem[] {
    const edges = this.listDependencyEdgesFrom(itemId);
    const blockers: WorkItem[] = [];
    for (const edge of edges) {
      const target = this.get(edge.toId);
      if (this.isDependencyActive(target) && target) {
        blockers.push(target);
      }
    }
    return blockers;
  }

  getInboundDependents(targetId: string): WorkItem[] {
    const inbound = this.listDependencyEdgesTo(targetId);
    const dependents: WorkItem[] = [];
    for (const edge of inbound) {
      const dependent = this.get(edge.fromId);
      if (dependent) {
        dependents.push(dependent);
      }
    }
    return dependents;
  }

  hasActiveBlockers(itemId: string): boolean {
    const edges = this.listDependencyEdgesFrom(itemId);
    for (const edge of edges) {
      const target = this.get(edge.toId);
      if (this.isDependencyActive(target)) {
        return true;
      }
    }
    return false;
  }

  reconcileBlockedStatus(itemId: string): boolean {
    const item = this.get(itemId);
    if (!item) {
      return false;
    }
    if (item.status !== 'blocked') {
      return false;
    }
    if (this.hasActiveBlockers(itemId)) {
      return false;
    }

    const updated: WorkItem = {
      ...item,
      status: 'open',
      updatedAt: new Date().toISOString(),
    };
    this.store.saveWorkItem(updated);
    this.exportToJsonl();
    this.triggerAutoSync();
    return true;
  }

  reconcileDependentStatus(itemId: string): boolean {
    const item = this.get(itemId);
    if (!item) {
      return false;
    }
    if (item.status === 'completed' || item.status === 'deleted') {
      return false;
    }

    if (this.hasActiveBlockers(itemId)) {
      if (item.status === 'blocked') {
        return false;
      }
      const updated: WorkItem = {
        ...item,
        status: 'blocked',
        updatedAt: new Date().toISOString(),
      };
      this.store.saveWorkItem(updated);
      this.exportToJsonl();
      this.triggerAutoSync();
      return true;
    }

    if (item.status !== 'blocked') {
      return false;
    }

    const updated: WorkItem = {
      ...item,
      status: 'open',
      updatedAt: new Date().toISOString(),
    };
    this.store.saveWorkItem(updated);
    this.exportToJsonl();
    this.triggerAutoSync();
    return true;
  }

  reconcileDependentsForTarget(targetId: string): number {
    const dependents = this.getInboundDependents(targetId);
    let updated = 0;
    for (const dependent of dependents) {
      if (this.reconcileDependentStatus(dependent.id)) {
        updated += 1;
      }
    }
    return updated;
  }

  /**
   * Create a new comment
   */
  createComment(input: CreateCommentInput): Comment | null {
    // Validate required fields
    if (!input.author || input.author.trim() === '') {
      throw new Error('Author is required');
    }
    if (!input.comment || input.comment.trim() === '') {
      throw new Error('Comment text is required');
    }
    
    // Verify that the work item exists
    if (!this.store.getWorkItem(input.workItemId)) {
      return null;
    }

    const id = this.generateCommentId();
    const now = new Date().toISOString();
    
    const comment: Comment = {
      id,
      workItemId: input.workItemId,
      author: input.author,
      comment: input.comment,
      createdAt: now,
      references: input.references || [],
      // Normalize nullable inputs: treat null as undefined
      githubCommentId: input.githubCommentId == null ? undefined : input.githubCommentId,
      githubCommentUpdatedAt: input.githubCommentUpdatedAt == null ? undefined : input.githubCommentUpdatedAt,
    };

    // Debug: log creation intent before saving (only when not silent)
     if (!this.silent) {
       // Send to stderr so JSON output on stdout is not contaminated
       this.debug(`WorklogDatabase.createComment: creating comment for ${input.workItemId} by ${input.author}`);
     }

     this.store.saveComment(comment);
     this.touchWorkItemUpdatedAt(input.workItemId);
     // Re-index the parent work item in FTS to include the new comment text
     const parentItem = this.store.getWorkItem(input.workItemId);
     if (parentItem) this.store.upsertFtsEntry(parentItem);
     this.exportToJsonl();
     this.triggerAutoSync();
     return comment;
  }

  /**
   * Get a comment by ID
   */
  getComment(id: string): Comment | null {
    return this.store.getComment(id);
  }

  /**
   * Update a comment
   */
  updateComment(id: string, input: UpdateCommentInput): Comment | null {
    const comment = this.store.getComment(id);
    if (!comment) {
      return null;
    }

    let updatedAny: any = {
      ...comment,
      ...input,
    };

    // Normalize nullable github mapping fields: convert null -> undefined
    if (updatedAny.githubCommentId == null) {
      updatedAny.githubCommentId = undefined;
    }
    if (updatedAny.githubCommentUpdatedAt == null) {
      updatedAny.githubCommentUpdatedAt = undefined;
    }

    // Prevent changing immutable fields
    const updated: Comment = {
      ...updatedAny,
      id: comment.id,
      workItemId: comment.workItemId,
      createdAt: comment.createdAt,
    } as Comment;

     this.store.saveComment(updated);
     this.touchWorkItemUpdatedAt(comment.workItemId);
     // Re-index the parent work item in FTS to reflect updated comment text
     const parentItem = this.store.getWorkItem(comment.workItemId);
     if (parentItem) this.store.upsertFtsEntry(parentItem);
     this.exportToJsonl();
     this.triggerAutoSync();
     return updated;
  }

  /**
   * Delete a comment
   */
  deleteComment(id: string): boolean {
     const comment = this.store.getComment(id);
     if (!comment) {
       return false;
     }
     const result = this.store.deleteComment(id);
      if (result) {
        this.touchWorkItemUpdatedAt(comment.workItemId);
        // Re-index the parent work item in FTS to reflect removed comment
        const parentItem = this.store.getWorkItem(comment.workItemId);
        if (parentItem) this.store.upsertFtsEntry(parentItem);
        this.exportToJsonl();
        this.triggerAutoSync();
      }
      return result;
  }

  /**
   * Get all comments for a work item
   */
  getCommentsForWorkItem(workItemId: string): Comment[] {
    this.refreshFromJsonlIfNewer();
    return this.store.getCommentsForWorkItem(workItemId);
  }

  /**
   * Get all comments as an array
   */
  getAllComments(): Comment[] {
    return this.store.getAllComments();
  }

  getAllDependencyEdges(): DependencyEdge[] {
    return this.store.getAllDependencyEdges();
  }

  /**
   * Import comments
   */
  importComments(comments: Comment[]): void {
    this.store.clearComments();
    for (const comment of comments) {
      this.store.saveComment(comment);
    }
    this.exportToJsonl();
    this.triggerAutoSync();
  }

  private touchWorkItemUpdatedAt(workItemId: string): void {
    const item = this.store.getWorkItem(workItemId);
    if (!item) {
      return;
    }
    this.store.saveWorkItem({
      ...item,
      updatedAt: new Date().toISOString(),
    });
  }
}
