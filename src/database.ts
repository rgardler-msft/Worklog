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
   * Refresh database from JSONL file if JSONL is newer
   */
  private refreshFromJsonlIfNewer(): void {
    if (!fs.existsSync(this.jsonlPath)) {
      return; // No JSONL file, nothing to refresh from
    }

    // Hold the file lock while checking mtime and importing to prevent
    // another process from writing between our stat and read.
    withFileLock(this.lockPath, () => {
      if (!fs.existsSync(this.jsonlPath)) {
        return; // File may have been removed between our check and lock acquisition
      }

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
    });
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
    if (this.store.ftsAvailable) {
      return { results: this.store.searchFts(query, options), ftsUsed: true };
    }
    if (!this.silent) {
      this.debug('FTS5 is not available; falling back to application-level search');
    }
    return { results: this.store.searchFallback(query, options), ftsUsed: false };
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
      status: input.status || 'open',
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
        // Normalize status: convert underscores to hyphens for matching
        // (handles legacy data stored with underscores vs the canonical hyphenated format)
        const normalizedQueryStatus = query.status.replace(/_/g, '-');
        items = items.filter(item => {
          const normalizedItemStatus = item.status.replace(/_/g, '-');
          return normalizedItemStatus === normalizedQueryStatus;
        });
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
   * Select the deepest in-progress item, using priority+age as tie-breaker
   */
   private selectDeepestInProgress(items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem | null {
    if (items.length === 0) {
      return null;
    }

    const depths = items.map(item => ({ item, depth: this.getDepth(item.id) }));
    const maxDepth = Math.max(...depths.map(entry => entry.depth));
    const deepest = depths
      .filter(entry => entry.depth === maxDepth)
      .map(entry => entry.item);

    return this.selectBySortIndex(deepest, recencyPolicy);
  }

  /**
   * Find a higher priority sibling of an in-progress item
   */
  private findHigherPrioritySibling(items: WorkItem[], selectedInProgress: WorkItem, recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem | null {
    if (!selectedInProgress.parentId) {
      return null;
    }

    const inProgressPriority = this.getPriorityValue(selectedInProgress.priority);
    const siblingCandidates = items.filter(item =>
      item.parentId === selectedInProgress.parentId &&
      item.id !== selectedInProgress.id &&
      item.status !== 'completed' &&
      item.status !== 'deleted' &&
      item.status !== 'in-progress' &&
      item.status !== 'blocked' &&
      this.getPriorityValue(item.priority) > inProgressPriority
    );

    if (siblingCandidates.length === 0) {
      return null;
    }

    return this.selectByScore(siblingCandidates, recencyPolicy);
  }

  /**
   * Select the highest priority blocking candidate with critical reference
   */
  private selectHighestPriorityBlocking(pairs: { blocking: WorkItem; critical: WorkItem }[]): { blocking: WorkItem; critical: WorkItem } | null {
    if (pairs.length === 0) {
      return null;
    }

    const orderedBlocking = this.orderBySortIndex(pairs.map(pair => pair.blocking));
    const selected = orderedBlocking[0];
    return selected ? pairs.find(pair => pair.blocking.id === selected.id) ?? null : null;
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
      assigneeBoost: 200,
    };

    let score = 0;

    // Priority base
    score += this.getPriorityValue(item.priority) * WEIGHTS.priority;

    // Blocks-high-priority boost: if this item is a dependency prerequisite for
    // active items with high or critical priority, add a proportional boost.
    // This ensures that among equal-priority peers, unblockers rank higher.
    // Uses store-direct access to avoid per-item refreshFromJsonlIfNewer overhead
    // (consistent with the dependency filter at the top of findNextWorkItemFromItems).
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

  /**
   * Select item by computed score. Tie-breakers: createdAt (older first), then id.
   */
  private selectByScore(items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem | null {
    if (!items || items.length === 0) return null;
    const now = Date.now();
    const scored = items.map(it => ({
      it,
      score: this.computeScore(it, now, recencyPolicy),
      createdAt: new Date(it.createdAt).getTime(),
    }));

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.it.id.localeCompare(b.it.id);
    });

    return scored[0].it;
  }

  private orderBySortIndex(items: WorkItem[]): WorkItem[] {
    const orderedAll = this.store.getAllWorkItemsOrderedByHierarchySortIndex();
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

  private selectBySortIndex(items: WorkItem[], recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore'): WorkItem | null {
    if (!items || items.length === 0) return null;
    const firstSortIndex = items[0].sortIndex ?? 0;
    const allSame = items.every(item => (item.sortIndex ?? 0) === firstSortIndex);
    if (allSame) {
      return this.selectByScore(items, recencyPolicy);
    }
    return this.orderBySortIndex(items)[0] ?? null;
  }

  /**
   * Shared next-item selection logic to keep single-item and batch results aligned.
   *
   * Selection proceeds through several phases:
   *   1. Filter out deleted, epic, in_review (unless opted in), and excluded items.
   *   2. Partition into dependency-blocked and unblocked candidates.
   *   3. Critical-path escalation: if a critical item is blocked, surface its direct
   *      blocker immediately (bypasses scoring).
   *   4. Hierarchical descent: if an in-progress parent exists, recurse into its children.
   *   5. Score-based ranking among remaining candidates via {@link computeScore}:
   *        priority (1000/level) → blocks-high-priority boost (500) → blocked penalty
   *        → age/effort/recency tie-breakers.
   *   6. If no unblocked candidates remain and includeBlocked is set, fall back to
   *      blocked items ranked by the same scoring logic.
   */
  private findNextWorkItemFromItems(
    items: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
    excluded?: Set<string>,
    debugPrefix: string = '[next]',
    includeInReview: boolean = false,
    includeBlocked: boolean = false
  ): NextWorkItemResult {
    this.debug(`${debugPrefix} recencyPolicy=${recencyPolicy} assignee=${assignee || ''} search=${searchTerm || ''} excluded=${excluded?.size || 0}`);
    let filteredItems = items;
    this.debug(`${debugPrefix} total items=${filteredItems.length}`);

    // Filter out deleted items first
    filteredItems = filteredItems.filter(item => item.status !== 'deleted');
    // Exclude epics from being recommended by `wl next` by default
    filteredItems = filteredItems.filter(item => item.issueType !== 'epic');
    if (!includeInReview) {
      filteredItems = filteredItems.filter(
        item => !(item.stage === 'in_review' && item.status === 'blocked')
      );
    }
    if (excluded && excluded.size > 0) {
      filteredItems = filteredItems.filter(item => !excluded.has(item.id));
    }
    // Save pre-dep-blocker pool so the critical-path can still surface blockers
    const preDepBlockerItems = filteredItems;
    if (!includeBlocked) {
      // Use store-direct access to avoid per-item refreshFromJsonlIfNewer overhead
      // (data is already fresh from the getAllWorkItems call at the top of the stack)
      filteredItems = filteredItems.filter(item => {
        const edges = this.store.getDependencyEdgesFrom(item.id);
        for (const edge of edges) {
          const target = this.store.getWorkItem(edge.toId);
          if (this.isDependencyActive(target ?? null)) {
            return false;
          }
        }
        return true;
      });
    }
    this.debug(`${debugPrefix} after deleted/excluded/dep-blocker=${filteredItems.length}`);

    // Apply filters
    filteredItems = this.applyFilters(filteredItems, assignee, searchTerm);
    this.debug(`${debugPrefix} after assignee/search filters=${filteredItems.length}`);

    // Critical items: use pre-dep-blocker pool so that blocked criticals still surface their blockers
    const criticalPool = this.applyFilters(preDepBlockerItems, assignee, searchTerm);
    const criticalItems = criticalPool.filter(
      item => item.priority === 'critical' && item.status !== 'completed' && item.status !== 'deleted'
    );
    this.debug(`${debugPrefix} critical items=${criticalItems.length}`);
    const unblockedCriticals = criticalItems.filter(
      item => item.status !== 'blocked' && this.getNonClosedChildren(item.id).length === 0
    );

    this.debug(`${debugPrefix} unblocked criticals=${unblockedCriticals.length}`);

    if (unblockedCriticals.length > 0) {
      const selected = this.selectBySortIndex(unblockedCriticals, recencyPolicy);
      this.debug(`${debugPrefix} selected critical=${selected?.id || ''}`);
      return {
        workItem: selected,
        reason: `Next unblocked critical item by sort_index${selected ? ` (priority ${selected.priority})` : ''}`
      };
    }

    const blockedCriticals = criticalItems.filter(
      item => item.status === 'blocked'
    );
    this.debug(`${debugPrefix} blocked criticals=${blockedCriticals.length}`);
    if (blockedCriticals.length > 0) {
      const blockingPairs: { blocking: WorkItem; critical: WorkItem }[] = [];

      for (const critical of blockedCriticals) {
        const blockingChildren = this.getNonClosedChildren(critical.id);
        for (const child of blockingChildren) {
          if (excluded?.has(child.id)) continue;
          blockingPairs.push({ blocking: child, critical });
        }

        const dependencyBlockers = this.getActiveDependencyBlockers(critical.id);
        for (const blocker of dependencyBlockers) {
          if (excluded?.has(blocker.id)) continue;
          blockingPairs.push({ blocking: blocker, critical });
        }
      }

      const filteredBlockingPairs = blockingPairs.filter(pair =>
        this.applyFilters([pair.blocking], assignee, searchTerm).length > 0
      );
      const selectedBlocking = this.selectHighestPriorityBlocking(filteredBlockingPairs);

      this.debug(`${debugPrefix} blocking candidates=${filteredBlockingPairs.length} selectedBlocking=${selectedBlocking?.blocking.id || ''}`);

      if (selectedBlocking) {
        return {
          workItem: selectedBlocking.blocking,
          reason: `Blocking issue for critical item ${selectedBlocking.critical.id} (${selectedBlocking.critical.title})`
        };
      }

      const selectedBlockedCritical = this.selectBySortIndex(blockedCriticals, recencyPolicy);
      this.debug(`${debugPrefix} selected blocked critical=${selectedBlockedCritical?.id || ''}`);
      return {
        workItem: selectedBlockedCritical,
        reason: 'Blocked critical work item with no identifiable blocking issues'
      };
    }

    // Find in-progress and blocked items
    // For blocked items: use pre-dep-blocker pool so blocked items with dependency
    // edges are still visible for blocker-surfacing logic.
    // For in-progress items: use filtered (post dep-blocker) pool so dep-blocked
    // in-progress items are not selected as the final result.
    const inProgressFromFiltered = this.applyFilters(filteredItems, assignee, searchTerm).filter(item => {
      const normalizedStatus = item.status.replace(/_/g, '-');
      return normalizedStatus === 'in-progress';
    });
    const blockedFromPreFilter = this.applyFilters(preDepBlockerItems, assignee, searchTerm).filter(item => {
      const normalizedStatus = item.status.replace(/_/g, '-');
      return normalizedStatus === 'blocked';
    });
    const inProgressItems = [...inProgressFromFiltered, ...blockedFromPreFilter];
    this.debug(`${debugPrefix} in-progress/blocked items=${inProgressItems.length}`);

    if (inProgressItems.length === 0) {
      // No in-progress items, find highest priority and oldest non-in-progress item
      // Respect hierarchy: select among root-level candidates, then descend into children
      const openItems = filteredItems.filter(item => item.status !== 'completed');
      this.debug(`${debugPrefix} open items=${openItems.length}`);
      if (openItems.length === 0) {
        return { workItem: null, reason: 'No work items available' };
      }

      // Identify root-level candidates: items whose parent is not in the open set
      const openIds = new Set(openItems.map(item => item.id));
      const rootCandidates = openItems.filter(item => !item.parentId || !openIds.has(item.parentId));
      this.debug(`${debugPrefix} root candidates=${rootCandidates.length}`);

      if (rootCandidates.length === 0) {
        // Fallback: all items have parents in the pool (shouldn't happen normally)
        const selected = this.selectBySortIndex(openItems, recencyPolicy);
        this.debug(`${debugPrefix} selected open (fallback)=${selected?.id || ''}`);
        return {
          workItem: selected,
          reason: `Next open item by sort_index${selected ? ` (priority ${selected.priority})` : ''}`
        };
      }

      const selectedRoot = this.selectBySortIndex(rootCandidates, recencyPolicy);
      this.debug(`${debugPrefix} selected root=${selectedRoot?.id || ''}`);

      if (!selectedRoot) {
        return { workItem: null, reason: 'No work items available' };
      }

      // Descend recursively into the subtree: at each level, if the selected item
      // has open children, pick the best child and continue descending
      let current = selectedRoot;
      let depth = 0;
      const maxDepth = 50; // Guard against circular references
      while (depth < maxDepth) {
        const children = openItems.filter(item =>
          item.parentId === current.id &&
          item.status !== 'completed' &&
          item.status !== 'deleted'
        ).filter(item => !excluded?.has(item.id));
        this.debug(`${debugPrefix} descend depth=${depth} current=${current.id} children=${children.length}`);

        if (children.length === 0) break;

        const bestChild = this.selectBySortIndex(children, recencyPolicy);
        if (!bestChild) break;

        current = bestChild;
        depth++;
      }

      if (current.id !== selectedRoot.id) {
        this.debug(`${debugPrefix} selected descendant=${current.id} of root=${selectedRoot.id}`);
        return {
          workItem: current,
          reason: `Next child by sort_index of open item ${selectedRoot.id}${current ? ` (priority ${current.priority})` : ''}`
        };
      }

      return {
        workItem: selectedRoot,
        reason: `Next open item by sort_index${selectedRoot ? ` (priority ${selectedRoot.priority})` : ''}`
      };
    }

    // There are in-progress or blocked items
    // Find the highest priority and oldest active item
    // Note: Blocked items trigger blocking issue detection, in-progress items trigger descendant traversal
    const selectedInProgress = this.selectDeepestInProgress(inProgressItems, recencyPolicy);
    this.debug(`${debugPrefix} selected in-progress=${selectedInProgress?.id || ''}`);
    if (!selectedInProgress) {
      return { workItem: null, reason: 'No work items available' };
    }

    const higherPrioritySibling = this.findHigherPrioritySibling(filteredItems, selectedInProgress, recencyPolicy);
    this.debug(`${debugPrefix} higher priority sibling=${higherPrioritySibling?.id || ''}`);
    if (higherPrioritySibling) {
      return {
        workItem: higherPrioritySibling,
        reason: `Higher priority sibling of in-progress item ${selectedInProgress.id} (${selectedInProgress.title}); selected item priority is ${higherPrioritySibling.priority}`
      };
    }

    // Check if the item is blocked - if so, prioritize formal blockers
    // BUT only if the blocked item's priority is >= the best competing open item
    if (selectedInProgress.status === 'blocked') {
      const blockedPriority = this.getPriorityValue(selectedInProgress.priority);

      // Find the best competing non-blocked, non-in-progress open item
      const competingOpenItems = filteredItems.filter(item => {
        const normalizedStatus = item.status.replace(/_/g, '-');
        return normalizedStatus !== 'in-progress' &&
               normalizedStatus !== 'blocked' &&
               item.status !== 'completed' &&
               item.status !== 'deleted' &&
               item.id !== selectedInProgress.id;
      }).filter(item => !excluded?.has(item.id));

      const bestCompetitor = this.selectByScore(competingOpenItems, recencyPolicy);
      const bestCompetitorPriority = bestCompetitor ? this.getPriorityValue(bestCompetitor.priority) : 0;

      this.debug(`${debugPrefix} blocked item priority=${selectedInProgress.priority}(${blockedPriority}) bestCompetitor=${bestCompetitor?.id || 'none'} priority=${bestCompetitor?.priority || 'none'}(${bestCompetitorPriority})`);

      // If a competing open item has strictly higher priority than the blocked item,
      // prefer the competitor over the blocker
      if (bestCompetitor && bestCompetitorPriority > blockedPriority) {
        this.debug(`${debugPrefix} preferring higher-priority open item over blocker`);
        return {
          workItem: bestCompetitor,
          reason: `Higher priority open item preferred over blocker of lower-priority blocked item ${selectedInProgress.id} (${selectedInProgress.title})`
        };
      }

      const blockingChildren = this.getNonClosedChildren(selectedInProgress.id);
      const dependencyBlockers = this.getActiveDependencyBlockers(selectedInProgress.id);
      const blockingCandidates = [...blockingChildren, ...dependencyBlockers];
      const filteredBlockingCandidates = this.applyFilters(blockingCandidates, assignee, searchTerm)
        .filter(item => !excluded?.has(item.id));
      if (filteredBlockingCandidates.length > 0) {
        const selected = this.selectBySortIndex(filteredBlockingCandidates, recencyPolicy);
        this.debug(`${debugPrefix} selected blocking issue=${selected?.id || ''}`);
        return {
          workItem: selected,
          reason: `Blocking issue for ${selectedInProgress.id} (${selectedInProgress.title})`
        };
      }
      // If no blocking issues found or they don't exist, return the blocked item itself
      return {
        workItem: selectedInProgress,
        reason: `Blocked item with no identifiable blocking issues`
      };
    }

    // Select best direct child of the in-progress item
    const directChildren = this.getChildren(selectedInProgress.id);
    const filteredChildren = this.applyFilters(directChildren, assignee, searchTerm).filter(
      item => item.status !== 'in-progress' && item.status !== 'completed' && item.status !== 'deleted'
    ).filter(item => !excluded?.has(item.id));

    this.debug(`${debugPrefix} direct children=${directChildren.length} filtered children=${filteredChildren.length}`);

    if (filteredChildren.length === 0) {
      if (excluded?.has(selectedInProgress.id)) {
        return { workItem: null, reason: 'No available items after exclusions' };
      }
      // No suitable direct children — fall through to find the best non-in-progress
      // open item instead of returning the in-progress item itself (it's already
      // being worked on, so wl next should recommend something actionable).
      const fallbackItems = filteredItems.filter(item => {
        const ns = item.status.replace(/_/g, '-');
        return ns !== 'in-progress' &&
               ns !== 'blocked' &&
               item.status !== 'completed' &&
               item.status !== 'deleted' &&
               item.id !== selectedInProgress.id;
      }).filter(item => !excluded?.has(item.id));
      const fallback = this.selectBySortIndex(fallbackItems, recencyPolicy);
      if (fallback) {
        return {
          workItem: fallback,
          reason: `Next open item by sort_index (in-progress item ${selectedInProgress.id} has no open children)`
        };
      }
      return { workItem: null, reason: 'No actionable work items available (only in-progress items remain)' };
    }

    const selected = this.selectBySortIndex(filteredChildren, recencyPolicy);
    this.debug(`${debugPrefix} selected child=${selected?.id || ''}`);
    return {
      workItem: selected,
      reason: `Next child by sort_index of deepest in-progress item ${selectedInProgress.id}`
    };
  }

  /**
   * Find the next work item to work on based on priority and creation time
   * @param assignee - Optional assignee filter
   * @param searchTerm - Optional search term for fuzzy matching
   * @returns The next work item and a reason for the selection, or null if none found
   */
  findNextWorkItem(
    assignee?: string,
    searchTerm?: string,
    recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
    includeInReview: boolean = false,
    includeBlocked: boolean = false
  ): NextWorkItemResult {
    const items = this.store.getAllWorkItems();
    return this.findNextWorkItemFromItems(items, assignee, searchTerm, recencyPolicy, undefined, '[next]', includeInReview, includeBlocked);
  }

  /**
   * Find multiple next work items (up to `count`) using the same selection logic
   * as `findNextWorkItem`, but excluding already-selected items between iterations.
   */
  findNextWorkItems(
    count: number,
    assignee?: string,
    searchTerm?: string,
    recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
    includeInReview: boolean = false,
    includeBlocked: boolean = false
  ): NextWorkItemResult[] {
    const results: NextWorkItemResult[] = [];
    const excluded = new Set<string>();

    for (let i = 0; i < count; i += 1) {
      const result = this.findNextWorkItemFromItems(
        this.store.getAllWorkItems(),
        assignee,
        searchTerm,
        recencyPolicy,
        excluded,
        `[next batch ${i + 1}/${count}]`,
        includeInReview,
        includeBlocked
      );

      results.push(result);
      if (result.workItem) excluded.add(result.workItem.id);

      // If no work item was found, stop early
      if (!result.workItem) break;
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
   * Helper method to select the highest priority and oldest item from a list
   */
  private selectHighestPriorityOldest(items: WorkItem[]): WorkItem | null {
    if (items.length === 0) {
      return null;
    }

    // Define priority order
    const priorityOrder: { [key: string]: number } = {
      'critical': 4,
      'high': 3,
      'medium': 2,
      'low': 1,
    };

    // Sort by priority (descending) then by createdAt (ascending - oldest first)
    const sorted = items.sort((a, b) => {
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      // If priorities are equal, sort by creation time (oldest first)
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return sorted[0];
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
