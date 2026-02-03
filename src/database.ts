/**
 * Persistent database for work items with SQLite backend
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery, Comment, CreateCommentInput, UpdateCommentInput, NextWorkItemResult, DependencyEdge } from './types.js';
import { SqlitePersistentStore } from './persistent-store.js';
import { importFromJsonl, exportToJsonl, getDefaultDataPath } from './jsonl.js';
import { mergeWorkItems, mergeComments } from './sync.js';

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

    const jsonlStats = fs.statSync(this.jsonlPath);
    const jsonlMtime = jsonlStats.mtimeMs;

    const metadata = this.store.getAllMetadata();
    const lastImportMtime = metadata.lastJsonlImportMtime;

    // If DB is empty or JSONL is newer, refresh from JSONL
    const itemCount = this.store.countWorkItems();
    const shouldRefresh = itemCount === 0 || !lastImportMtime || jsonlMtime > lastImportMtime;

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
    const dependencyEdges = this.store.getAllDependencyEdges();
    exportToJsonl(itemsToExport, commentsToExport, this.jsonlPath, dependencyEdges);
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

  previewSortIndexOrder(gap: number): Array<{ id: string; sortIndex: number } & WorkItem> {
    const ordered = this.computeSortIndexOrder();
    return ordered.map((item, index) => ({
      ...item,
      sortIndex: (index + 1) * gap,
    }));
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
    };

    this.store.saveWorkItem(item);
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

    this.store.saveWorkItem(updated);
    this.exportToJsonl();
    this.triggerAutoSync();
    return updated;
  }

  /**
   * Delete a work item
   */
  delete(id: string): boolean {
    this.refreshFromJsonlIfNewer();
    const result = this.store.deleteWorkItem(id);
    if (result) {
      this.exportToJsonl();
      this.triggerAutoSync();
    }
    return result;
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
    const WEIGHTS = {
      priority: 1000,
      age: 10, // per day
      updated: 100, // recency boost/penalty
      blocked: -10000,
      effort: 20,
      assigneeBoost: 200,
    };

    let score = 0;

    // Priority base
    score += this.getPriorityValue(item.priority) * WEIGHTS.priority;

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
   */
  private findNextWorkItemFromItems(
    items: WorkItem[],
    assignee?: string,
    searchTerm?: string,
    recencyPolicy: 'prefer'|'avoid'|'ignore' = 'ignore',
    excluded?: Set<string>,
    debugPrefix: string = '[next]',
    includeInReview: boolean = false
  ): NextWorkItemResult {
    this.debug(`${debugPrefix} recencyPolicy=${recencyPolicy} assignee=${assignee || ''} search=${searchTerm || ''} excluded=${excluded?.size || 0}`);
    let filteredItems = items;
    this.debug(`${debugPrefix} total items=${filteredItems.length}`);

    // Filter out deleted items first
    filteredItems = filteredItems.filter(item => item.status !== 'deleted');
    if (!includeInReview) {
      filteredItems = filteredItems.filter(item => item.stage !== 'in_review');
    }
    if (excluded && excluded.size > 0) {
      filteredItems = filteredItems.filter(item => !excluded.has(item.id));
    }
    this.debug(`${debugPrefix} after deleted/excluded=${filteredItems.length}`);

    // Apply filters
    filteredItems = this.applyFilters(filteredItems, assignee, searchTerm);
    this.debug(`${debugPrefix} after assignee/search filters=${filteredItems.length}`);

    const criticalItems = filteredItems.filter(
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
        if (critical.status === 'blocked') {
          const blockingIssues = this.extractBlockingIssues(critical);
          for (const id of blockingIssues) {
            const blockingItem = this.get(id);
            if (blockingItem && blockingItem.status !== 'completed' && blockingItem.status !== 'deleted') {
              blockingPairs.push({ blocking: blockingItem, critical });
            }
          }
        }

        const blockingChildren = this.getNonClosedChildren(critical.id);
        for (const child of blockingChildren) {
          blockingPairs.push({ blocking: child, critical });
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
    const inProgressItems = filteredItems.filter(item => {
      const normalizedStatus = item.status.replace(/_/g, '-');
      return normalizedStatus === 'in-progress' || normalizedStatus === 'blocked';
    });
    this.debug(`${debugPrefix} in-progress/blocked items=${inProgressItems.length}`);

    if (inProgressItems.length === 0) {
      // No in-progress items, find highest priority and oldest non-in-progress item
      const openItems = filteredItems.filter(item => item.status !== 'completed');
      this.debug(`${debugPrefix} open items=${openItems.length}`);
      if (openItems.length === 0) {
        return { workItem: null, reason: 'No work items available' };
      }
      const selected = this.selectBySortIndex(openItems, recencyPolicy);
      this.debug(`${debugPrefix} selected open=${selected?.id || ''}`);
      return {
        workItem: selected,
        reason: `Next open item by sort_index${selected ? ` (priority ${selected.priority})` : ''}`
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

    // Check if the item is blocked - if so, prioritize its blocking issues
    if (selectedInProgress.status === 'blocked') {
      // Find blocking issues mentioned in description or comments
      const blockingIssues = this.extractBlockingIssues(selectedInProgress);
      if (blockingIssues.length > 0) {
        // Filter to find existing work items that match the blocking issue IDs
        const blockingItems = blockingIssues
          .map(id => this.get(id))
          .filter((item): item is WorkItem => item !== null && item.status !== 'completed' && item.status !== 'deleted');
        
        if (blockingItems.length > 0) {
          // Apply filters to blocking items and select highest priority
          const filteredBlockingItems = this.applyFilters(blockingItems, assignee, searchTerm);
          if (filteredBlockingItems.length > 0) {
            const selected = this.selectBySortIndex(filteredBlockingItems, recencyPolicy);
            this.debug(`${debugPrefix} selected blocking issue=${selected?.id || ''}`);
            return {
              workItem: selected,
              reason: `Blocking issue for ${selectedInProgress.id} (${selectedInProgress.title})`
            };
          }
        }
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
    );

    this.debug(`${debugPrefix} direct children=${directChildren.length} filtered children=${filteredChildren.length}`);

    if (filteredChildren.length === 0) {
      // No suitable direct children, return the in-progress item itself
      return {
        workItem: selectedInProgress,
        reason: `In-progress item with no open children`
      };
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
    includeInReview: boolean = false
  ): NextWorkItemResult {
    const items = this.store.getAllWorkItems();
    return this.findNextWorkItemFromItems(items, assignee, searchTerm, recencyPolicy, undefined, '[next]', includeInReview);
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
    includeInReview: boolean = false
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
        includeInReview
      );

      results.push(result);
      if (result.workItem) excluded.add(result.workItem.id);

      // If no work item was found, stop early
      if (!result.workItem) break;
    }

    return results;
  }

  /**
   * Extract blocking issue IDs from description and comments
   * Looks for work item ID patterns (e.g., "PREFIX-ABC123DEF")
   */
  private extractBlockingIssues(item: WorkItem): string[] {
    const blockingIds: string[] = [];
    // Pattern matches prefix followed by alphanumeric characters (e.g., WI-0MKRDE4YI1)
    const pattern = new RegExp(`${this.prefix}-[A-Z0-9]+`, 'gi');
    
    // Search in description
    if (item.description) {
      const matches = item.description.match(pattern);
      if (matches) {
        blockingIds.push(...matches.map(id => id.toUpperCase()));
      }
    }
    
    // Search in comments
    const comments = this.getCommentsForWorkItem(item.id);
    for (const comment of comments) {
      const matches = comment.comment.match(pattern);
      if (matches) {
        blockingIds.push(...matches.map(id => id.toUpperCase()));
      }
    }
    
    // Remove duplicates and the item itself
    return [...new Set(blockingIds)].filter(id => id !== item.id);
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

    // Filter by search term if provided (fuzzy match against title, description, and comments)
    if (searchTerm) {
      const lowerSearchTerm = searchTerm.toLowerCase();
      filtered = filtered.filter(item => {
        // Check title and description
        const titleMatch = item.title.toLowerCase().includes(lowerSearchTerm);
        const descriptionMatch = item.description?.toLowerCase().includes(lowerSearchTerm) || false;
        
        // Check comments
        const comments = this.getCommentsForWorkItem(item.id);
        const commentMatch = comments.some(comment => 
          comment.comment.toLowerCase().includes(lowerSearchTerm)
        );
        
        return titleMatch || descriptionMatch || commentMatch;
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
    };

    // Debug: log creation intent before saving (only when not silent)
     if (!this.silent) {
       // Send to stderr so JSON output on stdout is not contaminated
       this.debug(`WorklogDatabase.createComment: creating comment for ${input.workItemId} by ${input.author}`);
     }

     this.store.saveComment(comment);
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

    const updated: Comment = {
      ...comment,
      ...input,
      id: comment.id, // Prevent ID changes
      workItemId: comment.workItemId, // Prevent workItemId changes
      createdAt: comment.createdAt, // Prevent createdAt changes
    };

    this.store.saveComment(updated);
    this.exportToJsonl();
    this.triggerAutoSync();
    return updated;
  }

  /**
   * Delete a comment
   */
  deleteComment(id: string): boolean {
    const result = this.store.deleteComment(id);
    if (result) {
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
}
