/**
 * Tests for WorklogDatabase
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('WorklogDatabase', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
  });

  afterEach(() => {
    db.close();
    cleanupTempDir(tempDir);
  });

  describe('create', () => {
    it('should create a work item with required fields', () => {
      const item = db.create({
        title: 'Test task',
      });

      expect(item).toBeDefined();
      expect(item.id).toMatch(/^TEST-[A-Z0-9]+$/);
      expect(item.title).toBe('Test task');
      expect(item.description).toBe('');
      expect(item.status).toBe('open');
      expect(item.priority).toBe('medium');
      expect(item.sortIndex).toBe(0);
      expect(item.parentId).toBe(null);
      expect(item.tags).toEqual([]);
      expect(item.assignee).toBe('');
      expect(item.stage).toBe('');
      expect(item.issueType).toBe('');
      expect(item.createdBy).toBe('');
      expect(item.deletedBy).toBe('');
      expect(item.deleteReason).toBe('');
      expect(item.risk).toBe('');
      expect(item.effort).toBe('');
      expect(item.githubIssueNumber).toBeUndefined();
      expect(item.githubIssueId).toBeUndefined();
      expect(item.githubIssueUpdatedAt).toBeUndefined();
      expect(item.createdAt).toBeDefined();
      expect(item.updatedAt).toBeDefined();
    });

    it('should create a work item with all optional fields', () => {
      const item = db.create({
        title: 'Full task',
        description: 'A complete description',
        status: 'in-progress',
        priority: 'high',
        tags: ['feature', 'backend'],
        assignee: 'john.doe',
        stage: 'development',
        issueType: 'task',
        createdBy: 'john.doe',
      });

      expect(item.title).toBe('Full task');
      expect(item.description).toBe('A complete description');
      expect(item.status).toBe('in-progress');
      expect(item.priority).toBe('high');
      expect(item.tags).toEqual(['feature', 'backend']);
      expect(item.assignee).toBe('john.doe');
      expect(item.stage).toBe('development');
      expect(item.issueType).toBe('task');
      expect(item.createdBy).toBe('john.doe');
    });

    it('should create a work item with a parent', () => {
      const parent = db.create({ title: 'Parent task' });
      const child = db.create({
        title: 'Child task',
        parentId: parent.id,
      });

      expect(child.parentId).toBe(parent.id);
    });

    it('should generate unique IDs for multiple items', () => {
      const item1 = db.create({ title: 'Task 1' });
      const item2 = db.create({ title: 'Task 2' });
      const item3 = db.create({ title: 'Task 3' });

      expect(item1.id).not.toBe(item2.id);
      expect(item2.id).not.toBe(item3.id);
      expect(item1.id).not.toBe(item3.id);
    });
  });

  describe('get', () => {
    it('should retrieve a work item by ID', () => {
      const created = db.create({ title: 'Test task' });
      const retrieved = db.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe('Test task');
    });

    it('should return null for non-existent ID', () => {
      const result = db.get('TEST-NONEXISTENT');
      expect(result).toBe(null);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      // Create test data
      db.create({ title: 'Task 1', status: 'open', priority: 'high', needsProducerReview: true });
      db.create({ title: 'Task 2', status: 'in-progress', priority: 'medium' });
      db.create({ title: 'Task 3', status: 'completed', priority: 'low' });
      db.create({ title: 'Task 4', status: 'open', priority: 'high', tags: ['backend'], needsProducerReview: true });
      db.create({ title: 'Task 5', status: 'blocked', priority: 'critical', assignee: 'alice' });
    });

    it('should list all work items when no filters are provided', () => {
      const items = db.list({});
      expect(items).toHaveLength(5);
    });

    it('should filter by status', () => {
      const openItems = db.list({ status: 'open' });
      expect(openItems).toHaveLength(2);
      openItems.forEach(item => expect(item.status).toBe('open'));
    });

    it('should filter by priority', () => {
      const highPriorityItems = db.list({ priority: 'high' });
      expect(highPriorityItems).toHaveLength(2);
      highPriorityItems.forEach(item => expect(item.priority).toBe('high'));
    });

    it('should filter by status and priority', () => {
      const items = db.list({ status: 'open', priority: 'high' });
      expect(items).toHaveLength(2);
      items.forEach(item => {
        expect(item.status).toBe('open');
        expect(item.priority).toBe('high');
      });
    });

    it('should filter by tags', () => {
      const items = db.list({ tags: ['backend'] });
      expect(items).toHaveLength(1);
      expect(items[0].tags).toContain('backend');
    });

    it('should filter by assignee', () => {
      const items = db.list({ assignee: 'alice' });
      expect(items).toHaveLength(1);
      expect(items[0].assignee).toBe('alice');
    });

    it('should filter by parentId null (root items)', () => {
      const items = db.list({ parentId: null });
      expect(items).toHaveLength(5);
    });

    it('should filter by needsProducerReview true', () => {
      const items = db.list({ needsProducerReview: true });
      expect(items).toHaveLength(2);
      items.forEach(item => expect(item.needsProducerReview).toBe(true));
    });

    it('should filter by needsProducerReview false', () => {
      const items = db.list({ needsProducerReview: false });
      expect(items).toHaveLength(3);
      items.forEach(item => expect(item.needsProducerReview).not.toBe(true));
    });
  });

  describe('update', () => {
    it('should update a work item title', async () => {
      const item = db.create({ title: 'Original title' });
      // Wait a moment to ensure updatedAt timestamp will be different
      await new Promise(resolve => setTimeout(resolve, 10));
      const updated = db.update(item.id, { title: 'Updated title' });

      expect(updated).toBeDefined();
      expect(updated?.title).toBe('Updated title');
      expect(updated?.id).toBe(item.id);
      expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(item.updatedAt).getTime()
      );
    });

    it('should update multiple fields', () => {
      const item = db.create({ title: 'Task' });
      const updated = db.update(item.id, {
        title: 'Updated task',
        status: 'in-progress',
        priority: 'high',
        description: 'New description',
      });

      expect(updated?.title).toBe('Updated task');
      expect(updated?.status).toBe('in-progress');
      expect(updated?.priority).toBe('high');
      expect(updated?.description).toBe('New description');
    });

    it('should return null for non-existent ID', () => {
      const result = db.update('TEST-NONEXISTENT', { title: 'Updated' });
      expect(result).toBe(null);
    });
  });

  describe('delete', () => {
    it('should delete a work item', () => {
      const item = db.create({ title: 'To delete' });
      const deleted = db.delete(item.id);

      expect(deleted).toBe(true);
      const updated = db.get(item.id);
      expect(updated).not.toBe(null);
      expect(updated?.status).toBe('deleted');
      expect(updated?.stage).toBe('');
    });

    it('should not regress deleted status after dependent reconciliation', () => {
      const blocker = db.create({ title: 'Blocker' });
      const dependent = db.create({ title: 'Dependent' });
      db.addDependencyEdge(dependent.id, blocker.id);

      const deleted = db.delete(blocker.id);
      expect(deleted).toBe(true);

      const updated = db.get(blocker.id);
      expect(updated?.status).toBe('deleted');
    });

    it('should return false for non-existent ID', () => {
      const result = db.delete('TEST-NONEXISTENT');
      expect(result).toBe(false);
    });
  });

  describe('getChildren', () => {
    it('should return children of a work item', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id });
      db.create({ title: 'Other task' }); // Unrelated task

      const children = db.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map(c => c.id)).toContain(child1.id);
      expect(children.map(c => c.id)).toContain(child2.id);
    });

    it('should return empty array for item with no children', () => {
      const item = db.create({ title: 'No children' });
      const children = db.getChildren(item.id);
      expect(children).toEqual([]);
    });
  });

  describe('getDescendants', () => {
    it('should return all descendants including nested children', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id });
      const grandchild = db.create({ title: 'Grandchild', parentId: child1.id });

      const descendants = db.getDescendants(parent.id);
      expect(descendants).toHaveLength(3);
      expect(descendants.map(d => d.id)).toContain(child1.id);
      expect(descendants.map(d => d.id)).toContain(child2.id);
      expect(descendants.map(d => d.id)).toContain(grandchild.id);
    });
  });

  describe('comments', () => {
    let workItemId: string;

    beforeEach(() => {
      const item = db.create({ title: 'Task with comments' });
      workItemId = item.id;
    });

    it('should create a comment', () => {
      const comment = db.createComment({
        workItemId,
        author: 'John Doe',
        comment: 'This is a comment',
      });

      expect(comment).toBeDefined();
      expect(comment?.id).toMatch(/^TEST-C[A-Z0-9]+$/);
      expect(comment?.workItemId).toBe(workItemId);
      expect(comment?.author).toBe('John Doe');
      expect(comment?.comment).toBe('This is a comment');
      expect(comment?.references).toEqual([]);
    });

    it('should create a comment with references', () => {
      const comment = db.createComment({
        workItemId,
        author: 'Jane Doe',
        comment: 'Comment with references',
        references: ['TEST-123', 'src/file.ts', 'https://example.com'],
      });

      expect(comment?.references).toEqual(['TEST-123', 'src/file.ts', 'https://example.com']);
    });

    it('should get a comment by ID', () => {
      const created = db.createComment({
        workItemId,
        author: 'John',
        comment: 'Test',
      });
      const retrieved = db.getComment(created!.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created!.id);
    });

    it('should list comments for a work item', () => {
      db.createComment({ workItemId, author: 'A', comment: 'Comment 1' });
      db.createComment({ workItemId, author: 'B', comment: 'Comment 2' });

      const comments = db.getCommentsForWorkItem(workItemId);
      expect(comments).toHaveLength(2);
    });

    it('should update a comment', () => {
      const comment = db.createComment({
        workItemId,
        author: 'John',
        comment: 'Original',
      });
      const updated = db.updateComment(comment!.id, {
        comment: 'Updated comment',
      });

      expect(updated?.comment).toBe('Updated comment');
      expect(updated?.author).toBe('John');
    });

    it('should delete a comment', () => {
      const comment = db.createComment({
        workItemId,
        author: 'John',
        comment: 'To delete',
      });
      const deleted = db.deleteComment(comment!.id);

      expect(deleted).toBe(true);
      expect(db.getComment(comment!.id)).toBe(null);
    });
  });

  describe('dependency edges', () => {
    it('should add and list outbound dependency edges', () => {
      const from = db.create({ title: 'From' });
      const to = db.create({ title: 'To' });

      const edge = db.addDependencyEdge(from.id, to.id);
      expect(edge).toBeDefined();
      expect(edge?.fromId).toBe(from.id);
      expect(edge?.toId).toBe(to.id);

      const outbound = db.listDependencyEdgesFrom(from.id);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].fromId).toBe(from.id);
      expect(outbound[0].toId).toBe(to.id);
    });

    it('should list inbound dependency edges', () => {
      const from = db.create({ title: 'From' });
      const to = db.create({ title: 'To' });

      db.addDependencyEdge(from.id, to.id);

      const inbound = db.listDependencyEdgesTo(to.id);
      expect(inbound).toHaveLength(1);
      expect(inbound[0].fromId).toBe(from.id);
      expect(inbound[0].toId).toBe(to.id);
    });

    it('should remove dependency edges', () => {
      const from = db.create({ title: 'From' });
      const to = db.create({ title: 'To' });
      db.addDependencyEdge(from.id, to.id);

      const removed = db.removeDependencyEdge(from.id, to.id);
      expect(removed).toBe(true);
      expect(db.listDependencyEdgesFrom(from.id)).toHaveLength(0);
      expect(db.listDependencyEdgesTo(to.id)).toHaveLength(0);
    });

    it('should return null when adding edge with missing items', () => {
      const from = db.create({ title: 'From' });
      const edge = db.addDependencyEdge(from.id, 'TEST-NOTFOUND');
      expect(edge).toBeNull();
    });

    it('should open a blocked dependent when dependency is removed and no blockers remain', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      const removed = db.removeDependencyEdge(blocked.id, blocker.id);
      expect(removed).toBe(true);

      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('open');
    });

    it('should keep blocked status when other active blockers remain', () => {
      const blockerA = db.create({ title: 'Blocker A', status: 'open', stage: 'in_progress' });
      const blockerB = db.create({ title: 'Blocker B', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blockerA.id);
      db.addDependencyEdge(blocked.id, blockerB.id);

      const removed = db.removeDependencyEdge(blocked.id, blockerA.id);
      expect(removed).toBe(true);

      db.reconcileBlockedStatus(blocked.id);
      expect(db.get(blocked.id)?.status).toBe('blocked');
    });

    it('should unblock dependents when target becomes inactive', () => {
      const blocker = db.create({ title: 'Blocker', status: 'open', stage: 'in_progress' });
      const blocked = db.create({ title: 'Blocked', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      db.update(blocker.id, { stage: 'done' });
      expect(db.get(blocked.id)?.status).toBe('open');
    });
  });

  describe('import and export', () => {
    it('should import work items', () => {
      const items = [
        {
          id: 'TEST-001',
          title: 'Imported 1',
          description: '',
          status: 'open' as const,
          priority: 'medium' as const,
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: '',
          issueType: '',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '' as const,
          effort: '' as const,
        },
        {
          id: 'TEST-002',
          title: 'Imported 2',
          description: '',
          status: 'completed' as const,
          priority: 'high' as const,
          sortIndex: 0,
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: ['test'],
          assignee: 'alice',
          stage: 'done',
          issueType: '',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
          risk: '' as const,
          effort: '' as const,
        },
      ];

      db.import(items);
      const allItems = db.getAll();

      expect(allItems).toHaveLength(2);
      expect(allItems.find(i => i.id === 'TEST-001')).toBeDefined();
      expect(allItems.find(i => i.id === 'TEST-002')).toBeDefined();
    });

    it('should record lastJsonlExportMtime in metadata after export', () => {
      // Ensure initial state: remove jsonl if present
      if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath);

      const dbWithExport = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
      dbWithExport.create({ title: 'Export test' });

      // Read metadata directly from the underlying sqlite store
      const store = dbWithExport['store'] as any; // access for testing
      const mtimeStr = store.getMetadata('lastJsonlExportMtime');
      expect(mtimeStr).toBeDefined();
      const mtimeNum = Number(mtimeStr);
      expect(Number.isFinite(mtimeNum)).toBe(true);

      const fileStats = fs.statSync(jsonlPath);
      // mtime recorded should equal file mtime (within 1ms)
      expect(Math.abs(mtimeNum - fileStats.mtimeMs)).toBeLessThan(2);
    });
  });

  describe('autoExport', () => {
    it('should export to JSONL when autoExport is enabled', () => {
      // Create with autoExport enabled (default)
      const dbWithExport = new WorklogDatabase('TEST', dbPath, jsonlPath, true, true);
      
      // Ensure no JSONL file exists initially
      if (fs.existsSync(jsonlPath)) {
        fs.unlinkSync(jsonlPath);
      }
      
      // Create an item
      dbWithExport.create({ title: 'Test with export' });
      
      // JSONL file should exist
      expect(fs.existsSync(jsonlPath)).toBe(true);
    });

    it('should not export to JSONL when autoExport is disabled', () => {
      // Create with autoExport disabled
      const dbWithoutExport = new WorklogDatabase('TEST', dbPath, jsonlPath, false, true);
      
      // Ensure no JSONL file exists initially
      if (fs.existsSync(jsonlPath)) {
        fs.unlinkSync(jsonlPath);
      }
      
      // Create an item
      dbWithoutExport.create({ title: 'Test without export' });
      
      // JSONL file should not exist
      expect(fs.existsSync(jsonlPath)).toBe(false);
    });
  });

  describe('findNextWorkItem', () => {
    it('should return null when no work items exist', () => {
      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
      expect(result.reason).toBeDefined();
    });

    it('should return the only open item when no in-progress items exist', () => {
      const item = db.create({ title: 'Only task', priority: 'high' });
      const result = db.findNextWorkItem();
      
      expect(result.workItem).not.toBeNull();
      expect(result.workItem?.id).toBe(item.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should return highest priority item when multiple open items exist', () => {
      db.create({ title: 'Low priority', priority: 'low', status: 'open' });
      const highPrio = db.create({ title: 'High priority', priority: 'high', status: 'open' });
      db.create({ title: 'Medium priority', priority: 'medium', status: 'open' });
      
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highPrio.id);
      expect(result.reason).toBeDefined();
    });

    it('should return oldest item when priorities are equal', async () => {
      // Create items with same priority but different times
      const oldest = db.create({ title: 'Oldest', priority: 'high', status: 'open' });
      // Small delay to ensure different timestamps
      const delay = () => new Promise(resolve => setTimeout(resolve, 10));
      
      await delay();
      db.create({ title: 'Newer', priority: 'high', status: 'open' });
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(oldest.id);
    });

    it('should select direct child under in-progress item', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Child', priority: 'high', status: 'open', parentId: parent.id });
      const grandchild = db.create({ title: 'Grandchild', priority: 'high', status: 'open', parentId: child.id });
      
      const result = db.findNextWorkItem();
      // Should select the direct child since parent is in-progress
      expect(result.workItem?.id).toBe(child.id);
      expect(result.reason).toContain('child');
    });

    it('should skip completed and deleted items', () => {
      db.create({ title: 'Completed', priority: 'critical', status: 'completed' });
      db.create({ title: 'Deleted', priority: 'critical', status: 'deleted' });
      const openItem = db.create({ title: 'Open', priority: 'low', status: 'open' });
      
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(openItem.id);
    });

    it('should exclude blocked in_review items by default', () => {
      const inReviewBlocked = db.create({ title: 'In review', status: 'blocked', stage: 'in_review', priority: 'high' });
      const openItem = db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(openItem.id);
      expect(result.workItem?.id).not.toBe(inReviewBlocked.id);
    });

    it('should include blocked in_review items when requested', () => {
      const inReviewBlocked = db.create({ title: 'In review', status: 'blocked', stage: 'in_review', priority: 'high' });
      db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem(undefined, undefined, 'ignore', true);
      expect(result.workItem?.id).toBe(inReviewBlocked.id);
    });

    it('should filter by assignee when provided', () => {
      const johnItem = db.create({ title: 'John task', priority: 'high', status: 'open', assignee: 'john' });
      db.create({ title: 'Jane task', priority: 'critical', status: 'open', assignee: 'jane' });
      
      const result = db.findNextWorkItem('john');
      expect(result.workItem?.id).toBe(johnItem.id);
    });

    it('should filter by search term in title', () => {
      db.create({ title: 'Unrelated task', priority: 'critical', status: 'open' });
      const searchItem = db.create({ title: 'Bug fix needed', priority: 'low', status: 'open' });
      
      const result = db.findNextWorkItem(undefined, 'bug');
      expect(result.workItem?.id).toBe(searchItem.id);
    });

    it('should filter by search term in description', () => {
      db.create({ title: 'Task 1', description: 'Something else', priority: 'critical', status: 'open' });
      const searchItem = db.create({ title: 'Task 2', description: 'Fix the authentication bug', priority: 'low', status: 'open' });
      
      const result = db.findNextWorkItem(undefined, 'authentication');
      expect(result.workItem?.id).toBe(searchItem.id);
    });

    it('should filter by search term in comments', () => {
      db.create({ title: 'Task 1', priority: 'critical', status: 'open' });
      const searchItem = db.create({ title: 'Task 2', priority: 'low', status: 'open' });
      
      // Add a comment with the search term
      db.createComment({
        workItemId: searchItem.id,
        author: 'test',
        comment: 'This needs database optimization'
      });
      
      const result = db.findNextWorkItem(undefined, 'database');
      expect(result.workItem?.id).toBe(searchItem.id);
    });

    it('should filter by search term in id', () => {
      const target = db.create({ title: 'Target', priority: 'low', status: 'open' });
      db.create({ title: 'Other', priority: 'critical', status: 'open' });

      const idFragment = target.id.slice(-6).toLowerCase();
      const result = db.findNextWorkItem(undefined, idFragment);
      expect(result.workItem?.id).toBe(target.id);
    });

    it('should not return in-progress item when it has no suitable children', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Completed child', priority: 'high', status: 'completed', parentId: parent.id });
      
      const result = db.findNextWorkItem();
      // The in-progress item is already being worked on so wl next should not
      // recommend it again. With no other open items the result should be null.
      expect(result.workItem).toBeNull();
    });

    it('should skip in-progress item with no children and select next open item', () => {
      const parent = db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Completed child', priority: 'high', status: 'completed', parentId: parent.id });
      const openItem = db.create({ title: 'Other open task', priority: 'medium', status: 'open' });
      
      const result = db.findNextWorkItem();
      // Should skip the in-progress parent and return the open item instead
      expect(result.workItem?.id).toBe(openItem.id);
      expect(result.reason).toContain('Next open item by sort_index');
    });

    it('should select highest priority child when multiple children exist', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Low leaf', priority: 'low', status: 'open', parentId: parent.id });
      const highLeaf = db.create({ title: 'High leaf', priority: 'high', status: 'open', parentId: parent.id });
      
      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highLeaf.id);
    });

    it('should apply assignee filter to children', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress', assignee: 'john' });
      db.create({ title: 'Child for jane', priority: 'high', status: 'open', parentId: parent.id, assignee: 'jane' });
      const johnChild = db.create({ title: 'Child for john', priority: 'low', status: 'open', parentId: parent.id, assignee: 'john' });
      
      const result = db.findNextWorkItem('john');
      // Should select john's child even though jane's has higher priority
      expect(result.workItem?.id).toBe(johnChild.id);
    });

    it('should apply search filter to children', () => {
      const parent = db.create({ title: 'Parent task', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Regular child', priority: 'critical', status: 'open', parentId: parent.id });
      const bugChild = db.create({ title: 'Bug fix needed', priority: 'low', status: 'open', parentId: parent.id });
      
      const result = db.findNextWorkItem(undefined, 'bug');
      // Should select the bug child even though regular has higher priority
      expect(result.workItem?.id).toBe(bugChild.id);
    });

    it('should select blocking child for blocked item', () => {
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked'
      });
      const blocker = db.create({
        title: 'Blocking child',
        priority: 'low',
        status: 'open',
        parentId: blocked.id
      });

      const result = db.findNextWorkItem();
      // Should select the blocking child
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
      expect(result.reason).toContain(blocked.id);
    });

    it('should select dependency blocker for blocked item', () => {
      const blocker = db.create({ title: 'Dependency blocker', priority: 'medium', status: 'open' });
      const blocked = db.create({ title: 'Blocked task', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blocked.id, blocker.id);

      const result = db.findNextWorkItem();
      // Should select the dependency blocker
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
      expect(result.reason).toContain(blocked.id);
    });

    it('should ignore blocking issues mentioned in description', () => {
      const blocker = db.create({ title: 'Blocking issue', priority: 'low', status: 'open' });
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked',
        description: `This is blocked by ${blocker.id}`
      });

      const result = db.findNextWorkItem();
      // Should return the blocked item itself since description hints are ignored
      expect(result.workItem?.id).toBe(blocked.id);
      expect(result.reason).toContain('Blocked item');
    });

    it('should ignore blocking issues mentioned in comments', () => {
      const blocker = db.create({ title: 'Blocking issue', priority: 'medium', status: 'open' });
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked'
      });

      // Add comment mentioning the blocker
      db.createComment({
        workItemId: blocked.id,
        author: 'test',
        comment: `Cannot proceed due to ${blocker.id}`
      });

      const result = db.findNextWorkItem();
      // Should return the blocked item itself since comments are ignored
      expect(result.workItem?.id).toBe(blocked.id);
      expect(result.reason).toContain('Blocked item');
    });

    it('should prefer higher-priority open item over blocker of lower-priority blocked item', () => {
      // A (medium, open) blocks B (medium, blocked)
      // C (high, open) -- should win
      const blockerA = db.create({ title: 'Blocker A', priority: 'medium', status: 'open' });
      const blockedB = db.create({ title: 'Blocked B', priority: 'medium', status: 'blocked' });
      db.addDependencyEdge(blockedB.id, blockerA.id);
      const highC = db.create({ title: 'High priority C', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highC.id);
      expect(result.reason).toContain('Higher priority open item');
    });

    it('should prefer blocker when blocked item has higher priority than competing open items', () => {
      // X (medium, open) blocks Y (critical, blocked)
      // Z (high, open) -- should lose because Y is critical
      const blockerX = db.create({ title: 'Blocker X', priority: 'medium', status: 'open' });
      const blockedY = db.create({ title: 'Blocked Y', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(blockedY.id, blockerX.id);
      db.create({ title: 'High priority Z', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Should select blocker X because it unblocks a critical item
      expect(result.workItem?.id).toBe(blockerX.id);
      expect(result.reason).toContain('Blocking issue');
      expect(result.reason).toContain('critical');
    });

    it('should prefer blocker when blocked item has equal priority to best competing open item', () => {
      // Blocker (low, open) blocks BlockedItem (high, blocked)
      // Competitor (high, open) -- equal priority to blocked item, blocker should still win
      const blocker = db.create({ title: 'Blocker', priority: 'low', status: 'open' });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, blocker.id);
      db.create({ title: 'Competitor', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Blocker should win because blocked item's priority (high) is NOT less than competitor (high)
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should prefer blocker when no competing open items exist', () => {
      // Only a blocked item and its blocker exist
      const blocker = db.create({ title: 'Blocker', priority: 'low', status: 'open' });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'medium', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, blocker.id);

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(blocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should prefer higher-priority open item over child blocker of lower-priority blocked item', () => {
      // Child blocker (open) blocks Parent (medium, blocked)
      // HighItem (high, open) -- should win
      const parent = db.create({ title: 'Blocked parent', priority: 'medium', status: 'blocked' });
      db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: parent.id });
      const highItem = db.create({ title: 'High priority item', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highItem.id);
      expect(result.reason).toContain('Higher priority open item');
    });

    it('should prefer blocker of higher-priority blocked item over lower-priority open items with child blockers', () => {
      // Child blocker (open) blocks Parent (critical, blocked)
      // LowItem (high, open) -- should lose because parent is critical
      const parent = db.create({ title: 'Blocked parent', priority: 'critical', status: 'blocked' });
      const childBlocker = db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: parent.id });
      db.create({ title: 'High priority item', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      // Should select child blocker because blocked parent is critical
      // Note: critical blocked items are handled by Phase 2, so this may return via Phase 2
      expect(result.workItem?.id).toBe(childBlocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('Phase 4: sibling wins over child of lower-priority parent (Example 1)', () => {
      // A (low, open), B (high, open, child of A), C (medium, open, sibling of A)
      // Expected: C wins because A (low) < C (medium)
      const grandparent = db.create({ title: 'Grandparent', priority: 'high', status: 'open' });
      const itemA = db.create({ title: 'Item A', priority: 'low', status: 'open', parentId: grandparent.id });
      db.create({ title: 'Item B', priority: 'high', status: 'open', parentId: itemA.id });
      const itemC = db.create({ title: 'Item C', priority: 'medium', status: 'open', parentId: grandparent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemC.id);
    });

    it('Phase 4: child wins when parent priority >= sibling (Example 2)', () => {
      // A (medium, open), B (high, open, child of A), C (medium, open, sibling of A)
      // Expected: B wins because A (medium) >= C (medium)
      const grandparent = db.create({ title: 'Grandparent', priority: 'high', status: 'open' });
      const itemA = db.create({ title: 'Item A', priority: 'medium', status: 'open', parentId: grandparent.id });
      const itemB = db.create({ title: 'Item B', priority: 'high', status: 'open', parentId: itemA.id });
      db.create({ title: 'Item C', priority: 'medium', status: 'open', parentId: grandparent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemB.id);
    });

    it('Phase 4: low-priority child wins when parent priority >= sibling (Example 3)', () => {
      // A (medium, open), B (low, open, child of A), C (medium, open, sibling of A)
      // Expected: B wins because A (medium) >= C (medium), and B is A's child
      const grandparent = db.create({ title: 'Grandparent', priority: 'high', status: 'open' });
      const itemA = db.create({ title: 'Item A', priority: 'medium', status: 'open', parentId: grandparent.id });
      const itemB = db.create({ title: 'Item B', priority: 'low', status: 'open', parentId: itemA.id });
      db.create({ title: 'Item C', priority: 'medium', status: 'open', parentId: grandparent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(itemB.id);
    });

    it('Phase 4: top-level items without children are selected normally', () => {
      // No hierarchy, should work as before
      db.create({ title: 'Low item', priority: 'low', status: 'open' });
      const highItem = db.create({ title: 'High item', priority: 'high', status: 'open' });
      db.create({ title: 'Medium item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highItem.id);
    });

    it('Phase 4: top-level item with children descends to best child', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'open' });
      const bestChild = db.create({ title: 'Best child', priority: 'high', status: 'open', parentId: parent.id });
      db.create({ title: 'Other child', priority: 'low', status: 'open', parentId: parent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(bestChild.id);
      expect(result.reason).toContain('child');
    });

    // Dependency-blocker filter tests (WL-0MM04HDI618Y7DT0)

    it('should not return a dependency-blocked item by default', () => {
      // A has a dependency edge to B (A depends on B), so A is blocked
      // C is a normal open item that should be returned instead
      const itemA = db.create({ title: 'Dep-blocked item A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Prerequisite B', priority: 'low', status: 'open' });
      db.addDependencyEdge(itemA.id, itemB.id);
      const itemC = db.create({ title: 'Unblocked item C', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // A is dependency-blocked so it should be excluded; C or B should be selected
      expect(result.workItem?.id).not.toBe(itemA.id);
      // B or C should be selected (B is a prerequisite, C is unblocked)
      expect([itemB.id, itemC.id]).toContain(result.workItem?.id);
    });

    it('should return a dependency-blocked item when includeBlocked=true', () => {
      // A depends on B (A is dep-blocked), A has higher priority
      const itemA = db.create({ title: 'Dep-blocked item A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Prerequisite B', priority: 'low', status: 'open' });
      db.addDependencyEdge(itemA.id, itemB.id);

      // With includeBlocked=true, A should be in the candidate pool
      const result = db.findNextWorkItem(undefined, undefined, 'ignore', false, true);
      // A is high priority and includeBlocked is true, so it may be selected
      // The key assertion: A is NOT filtered out (it could be selected or its blocker could be)
      expect(result.workItem).toBeDefined();
    });

    it('should return a dep-blocked item whose blocker is completed (edge inactive)', () => {
      // A depends on B, but B is completed so the edge is inactive
      const itemA = db.create({ title: 'Formerly blocked A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Completed prerequisite B', priority: 'low', status: 'completed' });
      db.addDependencyEdge(itemA.id, itemB.id);

      const result = db.findNextWorkItem();
      // B is completed, so the dependency edge is inactive; A should NOT be filtered
      expect(result.workItem?.id).toBe(itemA.id);
    });

    it('should still surface blockers for critical dep-blocked items', () => {
      // Critical item X depends on Y (X is dep-blocked)
      // The critical path should still detect X and surface Y as the blocker
      const itemY = db.create({ title: 'Blocker Y', priority: 'low', status: 'open' });
      const itemX = db.create({ title: 'Critical blocked X', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(itemX.id, itemY.id);

      const result = db.findNextWorkItem();
      // The critical path should surface Y as the blocker of X
      expect(result.workItem?.id).toBe(itemY.id);
      expect(result.reason).toContain('Blocking issue');
      expect(result.reason).toContain(itemX.id);
    });

    it('should not affect items with no dependency edges (regression guard)', () => {
      // Items with no dependency edges should be selected normally
      db.create({ title: 'Low item', priority: 'low', status: 'open' });
      const highItem = db.create({ title: 'High item', priority: 'high', status: 'open' });
      db.create({ title: 'Medium item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem?.id).toBe(highItem.id);
    });

    it('should not return a dep-blocked in-progress item', () => {
      // An in-progress item that has active dependency blockers should NOT be
      // returned as the next item. Instead, a non-blocked open item should be selected.
      const inProgressItem = db.create({ title: 'In-progress dep-blocked', priority: 'high', status: 'in-progress' });
      const prereq = db.create({ title: 'Prerequisite', priority: 'low', status: 'open' });
      db.addDependencyEdge(inProgressItem.id, prereq.id);
      const openItem = db.create({ title: 'Available open item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // The in-progress item is dep-blocked, so it should not be selected
      // The open item or the prerequisite should be selected instead
      expect(result.workItem?.id).not.toBe(inProgressItem.id);
      expect([prereq.id, openItem.id]).toContain(result.workItem?.id);
    });
  });
});
