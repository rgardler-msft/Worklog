/**
 * Tests for sort operations: move, list, next, reindex, and migration
 * This test suite validates the sort_index functionality for work items.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('Sort Operations', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    // Disable JSONL auto-export to keep perf tests focused on sort operations.
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, false, true);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('sortIndex field', () => {
    it('should initialize sortIndex to 0 for new items', () => {
      const item = db.create({ title: 'New item' });
      expect(item.sortIndex).toBe(0);
    });

    it('should allow setting custom sortIndex on creation', () => {
      const item = db.create({ title: 'Item with custom index', sortIndex: 500 });
      expect(item.sortIndex).toBe(500);
    });

    it('should update sortIndex through update method', () => {
      const item = db.create({ title: 'Item' });
      const updated = db.update(item.id, { sortIndex: 250 });
      expect(updated?.sortIndex).toBe(250);
    });

    it('should preserve sortIndex when updating other fields', () => {
      const item = db.create({ title: 'Item', sortIndex: 100 });
      const updated = db.update(item.id, { title: 'Updated title' });
      expect(updated?.sortIndex).toBe(100);
    });
  });

  describe('createWithNextSortIndex', () => {
    it('should create item with sortIndex based on siblings', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 100 });
      const item2 = db.createWithNextSortIndex({ title: 'Item 2' });
      expect(item2.sortIndex).toBeGreaterThan(item1.sortIndex);
    });

    it('should use specified gap value (default 100)', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 100 });
      const item2 = db.createWithNextSortIndex({ title: 'Item 2' }, 100);
      expect(item2.sortIndex).toBe(200);
    });

    it('should use custom gap value', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 100 });
      const item2 = db.createWithNextSortIndex({ title: 'Item 2' }, 50);
      expect(item2.sortIndex).toBe(150);
    });

    it('should place new items after all siblings with correct gap', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 100 });
      const item2 = db.create({ title: 'Item 2', sortIndex: 250 });
      const item3 = db.createWithNextSortIndex({ title: 'Item 3' });
      expect(item3.sortIndex).toBe(350);
    });

    it('should work with parent items', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id, sortIndex: 100 });
      const child2 = db.createWithNextSortIndex({ title: 'Child 2', parentId: parent.id });
      expect(child2.sortIndex).toBeGreaterThan(child1.sortIndex);
    });

    it('should handle empty sibling list', () => {
      const item = db.createWithNextSortIndex({ title: 'Only item' });
      expect(item.sortIndex).toBe(100);
    });
  });

  describe('assignSortIndexValues', () => {
    it('should assign sortIndex values ensuring proper ordering', () => {
      const item1 = db.create({ title: 'Task 1', sortIndex: 10 });
      const item2 = db.create({ title: 'Task 2', sortIndex: 5 });
      const item3 = db.create({ title: 'Task 3', sortIndex: 20 });

      const result = db.assignSortIndexValues(100);
      
      expect(result.updated).toBeGreaterThan(0);
      const updated1 = db.get(item1.id)!;
      const updated2 = db.get(item2.id)!;
      const updated3 = db.get(item3.id)!;

      // All items should have sortIndex values assigned
      expect(updated1.sortIndex).toBeGreaterThan(0);
      expect(updated2.sortIndex).toBeGreaterThan(0);
      expect(updated3.sortIndex).toBeGreaterThan(0);
    });

    it('should use specified gap between items', () => {
      const item1 = db.create({ title: 'Task 1' });
      const item2 = db.create({ title: 'Task 2' });
      const item3 = db.create({ title: 'Task 3' });

      db.assignSortIndexValues(50);

      const updated1 = db.get(item1.id)!;
      const updated2 = db.get(item2.id)!;
      const updated3 = db.get(item3.id)!;

      // All should have sortIndex values that are multiples of the gap
      expect(updated1.sortIndex % 50).toBe(0);
      expect(updated2.sortIndex % 50).toBe(0);
      expect(updated3.sortIndex % 50).toBe(0);
      
      // All should be positive
      expect(updated1.sortIndex).toBeGreaterThan(0);
      expect(updated2.sortIndex).toBeGreaterThan(0);
      expect(updated3.sortIndex).toBeGreaterThan(0);
    });

    it('should maintain hierarchy when assigning indices', () => {
      const parent = db.create({ title: 'Parent' });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id });
      const sibling = db.create({ title: 'Sibling' });

      db.assignSortIndexValues(100);

      const updatedParent = db.get(parent.id)!;
      const updatedChild1 = db.get(child1.id)!;
      const updatedChild2 = db.get(child2.id)!;
      const updatedSibling = db.get(sibling.id)!;

      // Parent should come before its children
      expect(updatedParent.sortIndex).toBeLessThan(updatedChild1.sortIndex);
      expect(updatedParent.sortIndex).toBeLessThan(updatedChild2.sortIndex);
      // All items should have positive sortIndex
      expect(updatedParent.sortIndex).toBeGreaterThan(0);
      expect(updatedSibling.sortIndex).toBeGreaterThan(0);
    });

    it('should return count of updated items', () => {
      db.create({ title: 'Task 1' });
      db.create({ title: 'Task 2' });
      db.create({ title: 'Task 3' });

      const result = db.assignSortIndexValues(100);
      expect(result.updated).toBeGreaterThan(0);
    });

    it('should not update items that already have correct sortIndex', () => {
      const item1 = db.create({ title: 'Task 1', sortIndex: 100 });
      const item2 = db.create({ title: 'Task 2', sortIndex: 200 });

      // First assignment establishes order
      db.assignSortIndexValues(100);

      // Second assignment should detect no changes needed
      const result = db.assignSortIndexValues(100);
      expect(result.updated).toBe(0);
    });
  });

  describe('previewSortIndexOrder', () => {
    it('should preview sortIndex assignment without modifying', () => {
      const item1 = db.create({ title: 'Task 1', sortIndex: 5 });
      const item2 = db.create({ title: 'Task 2', sortIndex: 3 });

      const preview = db.previewSortIndexOrder(100);

      // Original should be unchanged
      expect(db.get(item1.id)!.sortIndex).toBe(5);
      expect(db.get(item2.id)!.sortIndex).toBe(3);

      // Preview should show the new values
      const previewItem1 = preview.find(p => p.id === item1.id);
      const previewItem2 = preview.find(p => p.id === item2.id);

      expect(previewItem1?.sortIndex).toBeGreaterThan(0);
      expect(previewItem2?.sortIndex).toBeGreaterThan(0);
    });

    it('should return all items in preview', () => {
      db.create({ title: 'Task 1' });
      db.create({ title: 'Task 2' });
      db.create({ title: 'Task 3' });

      const preview = db.previewSortIndexOrder(100);
      expect(preview).toHaveLength(3);
    });

    it('should apply correct gap in preview', () => {
      db.create({ title: 'Task 1' });
      db.create({ title: 'Task 2' });
      db.create({ title: 'Task 3' });

      const preview = db.previewSortIndexOrder(50);
      
      // Should be evenly spaced with gap of 50
      const indices = preview.map(p => p.sortIndex).sort((a, b) => a - b);
      expect(indices[0]).toBe(50);
      expect(indices[1]).toBe(100);
      expect(indices[2]).toBe(150);
    });
  });

  describe('sorting with list command', () => {
    it('should preserve sortIndex when listing items', () => {
      const item1 = db.create({ title: 'Task 1', sortIndex: 300 });
      const item2 = db.create({ title: 'Task 2', sortIndex: 100 });
      const item3 = db.create({ title: 'Task 3', sortIndex: 200 });

      const items = db.list({});

      // Verify sortIndex values are preserved
      const retrieved1 = items.find(i => i.id === item1.id);
      const retrieved2 = items.find(i => i.id === item2.id);
      const retrieved3 = items.find(i => i.id === item3.id);

      expect(retrieved1?.sortIndex).toBe(300);
      expect(retrieved2?.sortIndex).toBe(100);
      expect(retrieved3?.sortIndex).toBe(200);
    });

    it('should respect sortIndex in hierarchical ordering when using computeSortIndexOrder', () => {
      const parent = db.create({ title: 'Parent', sortIndex: 100 });
      const child1 = db.create({ title: 'Child 1', parentId: parent.id, sortIndex: 200 });
      const child2 = db.create({ title: 'Child 2', parentId: parent.id, sortIndex: 150 });
      const sibling = db.create({ title: 'Sibling', sortIndex: 50 });

      // Use previewSortIndexOrder to see the hierarchical ordering
      const preview = db.previewSortIndexOrder(100);

      // Verify hierarchy is preserved in preview
      const parentEntry = preview.find(p => p.id === parent.id);
      const child1Entry = preview.find(p => p.id === child1.id);
      const child2Entry = preview.find(p => p.id === child2.id);
      const siblingEntry = preview.find(p => p.id === sibling.id);

      expect(parentEntry).toBeDefined();
      expect(child1Entry).toBeDefined();
      expect(child2Entry).toBeDefined();
      expect(siblingEntry).toBeDefined();
    });
  });

  describe('next item selection with sortIndex', () => {
    it('should prefer lower sortIndex for next item', () => {
      db.create({ title: 'Task 1', status: 'open', sortIndex: 300 });
      db.create({ title: 'Task 2', status: 'open', sortIndex: 100 });
      db.create({ title: 'Task 3', status: 'open', sortIndex: 200 });

      const result = db.findNextWorkItem();

      expect(result.workItem?.title).toBe('Task 2');
    });

    it('should return open items in sortIndex order', () => {
      const item1 = db.create({ title: 'Task 1', status: 'completed', sortIndex: 100 });
      const item2 = db.create({ title: 'Task 2', status: 'open', sortIndex: 200 });
      const item3 = db.create({ title: 'Task 3', status: 'open', sortIndex: 150 });

      const result = db.findNextWorkItem();

      expect(result.workItem?.id).toBe(item3.id);
    });

    it('should respect parent-child relationships in next item', () => {
      const parent = db.create({ title: 'Parent', status: 'open', sortIndex: 100 });
      const child = db.create({ title: 'Child', parentId: parent.id, status: 'open', sortIndex: 200 });

      const result = db.findNextWorkItem();

      // Parent should be returned first
      expect(result.workItem?.id).toBe(parent.id);
    });
  });

  describe('sorting stability and edge cases', () => {
    it('should handle items with same sortIndex', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 100 });
      const item2 = db.create({ title: 'Item 2', sortIndex: 100 });

      const items = db.list({});
      
      // Both items should be present
      expect(items.map(i => i.id)).toContain(item1.id);
      expect(items.map(i => i.id)).toContain(item2.id);
    });

    it('should handle large gaps in sortIndex', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 100 });
      const item2 = db.create({ title: 'Item 2', sortIndex: 100000 });
      const item3 = db.create({ title: 'Item 3', sortIndex: 50000 });

      // Verify items are created with correct sortIndex
      const retrieved1 = db.get(item1.id)!;
      const retrieved2 = db.get(item2.id)!;
      const retrieved3 = db.get(item3.id)!;

      expect(retrieved1.sortIndex).toBe(100);
      expect(retrieved2.sortIndex).toBe(100000);
      expect(retrieved3.sortIndex).toBe(50000);
    });

    it('should handle negative sortIndex values', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: -100 });
      const item2 = db.create({ title: 'Item 2', sortIndex: 100 });

      const items = db.list({});

      expect(items[0].id).toBe(item1.id);
      expect(items[1].id).toBe(item2.id);
    });

    it('should handle zero sortIndex correctly', () => {
      const item1 = db.create({ title: 'Item 1', sortIndex: 0 });
      const item2 = db.create({ title: 'Item 2', sortIndex: 100 });

      const items = db.list({});

      expect(items[0].id).toBe(item1.id);
      expect(items[1].id).toBe(item2.id);
    });
  });

  describe('performance with large datasets', () => {
    it('should handle 100 items efficiently', () => {
      for (let i = 0; i < 100; i++) {
        db.create({ title: `Task ${i}`, sortIndex: i * 10 });
      }

      const startTime = Date.now();
      const listed = db.list({});
      const duration = Date.now() - startTime;

      expect(listed).toHaveLength(100);
      expect(duration).toBeLessThan(1000); // Should complete in less than 1 second
    });

    it('should handle 100 items per hierarchy level', () => {
      const parent = db.create({ title: 'Parent' });
      for (let i = 0; i < 100; i++) {
        db.create({ 
          title: `Child ${i}`, 
          parentId: parent.id,
          sortIndex: i * 10 
        });
      }

      const startTime = Date.now();
      const listed = db.list({});
      const duration = Date.now() - startTime;

      expect(listed).toHaveLength(101); // parent + 100 children
      expect(duration).toBeLessThan(1000);
    });

    it('should reindex 100 items efficiently', () => {
      for (let i = 0; i < 100; i++) {
        db.create({ title: `Task ${i}` });
      }

      const startTime = Date.now();
      const result = db.assignSortIndexValues(100);
      const duration = Date.now() - startTime;

      expect(result.updated).toBeGreaterThan(0);
      expect(duration).toBeLessThan(1000);
    });

    it('should handle 500 items efficiently', () => {
      for (let i = 0; i < 500; i++) {
        db.create({ title: `Task ${i}`, sortIndex: i * 10 });
      }

      const startTime = Date.now();
      const listed = db.list({});
      const duration = Date.now() - startTime;

      expect(listed).toHaveLength(500);
      expect(duration).toBeLessThan(3000); // Allow 3 seconds for 500 items
    });

    it('should handle 500 items per hierarchy level', () => {
      const parent = db.create({ title: 'Parent' });
      for (let i = 0; i < 500; i++) {
        db.create({ 
          title: `Child ${i}`, 
          parentId: parent.id,
          sortIndex: i * 10 
        });
      }

      const startTime = Date.now();
      const listed = db.list({});
      const duration = Date.now() - startTime;

      expect(listed).toHaveLength(501); // parent + 500 children
      expect(duration).toBeLessThan(3000);
    });

    it('should reindex 500 items efficiently', () => {
      for (let i = 0; i < 500; i++) {
        db.create({ title: `Task ${i}` });
      }

      const startTime = Date.now();
      const result = db.assignSortIndexValues(100);
      const duration = Date.now() - startTime;

      expect(result.updated).toBeGreaterThan(0);
      expect(duration).toBeLessThan(3000); // Allow 3 seconds for reindexing 500 items
    });

    it('should handle 1000 items efficiently', () => {
      for (let i = 0; i < 1000; i++) {
        db.create({ title: `Task ${i}`, sortIndex: i * 10 });
      }

      const startTime = Date.now();
      const listed = db.list({});
      const duration = Date.now() - startTime;

      expect(listed).toHaveLength(1000);
      expect(duration).toBeLessThan(5000); // Allow 5 seconds for large dataset
    });

    it('should handle 1000 items per hierarchy level', () => {
      const parent = db.create({ title: 'Parent' });
      for (let i = 0; i < 1000; i++) {
        db.create({ 
          title: `Child ${i}`, 
          parentId: parent.id,
          sortIndex: i * 10 
        });
      }

      const startTime = Date.now();
      const listed = db.list({});
      const duration = Date.now() - startTime;

      expect(listed).toHaveLength(1001); // parent + 1000 children
      expect(duration).toBeLessThan(5000);
    });

    it('should reindex 500 items efficiently', () => {
      for (let i = 0; i < 500; i++) {
        db.create({ title: `Task ${i}` });
      }

      const startTime = Date.now();
      const result = db.assignSortIndexValues(100);
      const duration = Date.now() - startTime;

      expect(result.updated).toBeGreaterThan(0);
      expect(duration).toBeLessThan(3000); // Allow 3 seconds for reindexing 500 items
    });

    it('should find next item efficiently with 500 items', () => {
      for (let i = 0; i < 500; i++) {
        db.create({ title: `Task ${i}`, status: i % 10 === 0 ? 'open' : 'completed', sortIndex: i * 10 });
      }

      const startTime = Date.now();
      const result = db.findNextWorkItem();
      const duration = Date.now() - startTime;

      expect(result.workItem).toBeDefined();
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('sorting with filters', () => {
    it('should preserve sortIndex values when filtering by status', () => {
      const item1 = db.create({ title: 'Task 1', status: 'open', sortIndex: 300 });
      const item2 = db.create({ title: 'Task 2', status: 'in-progress', sortIndex: 100 });
      const item3 = db.create({ title: 'Task 3', status: 'open', sortIndex: 200 });

      const openItems = db.list({ status: 'open' });

      expect(openItems).toHaveLength(2);
      // Check sortIndex values are preserved
      const item1Result = openItems.find(i => i.id === item1.id);
      const item3Result = openItems.find(i => i.id === item3.id);
      expect(item1Result?.sortIndex).toBe(300);
      expect(item3Result?.sortIndex).toBe(200);
    });

    it('should preserve sortIndex values when filtering by priority', () => {
      const item1 = db.create({ title: 'Task 1', priority: 'high', sortIndex: 300 });
      const item2 = db.create({ title: 'Task 2', priority: 'low', sortIndex: 100 });
      const item3 = db.create({ title: 'Task 3', priority: 'high', sortIndex: 200 });

      const highPriorityItems = db.list({ priority: 'high' });

      expect(highPriorityItems).toHaveLength(2);
      // Check sortIndex values are preserved
      const item1Result = highPriorityItems.find(i => i.id === item1.id);
      const item3Result = highPriorityItems.find(i => i.id === item3.id);
      expect(item1Result?.sortIndex).toBe(300);
      expect(item3Result?.sortIndex).toBe(200);
    });

    it('should preserve sortIndex values when filtering by assignee', () => {
      const item1 = db.create({ title: 'Task 1', assignee: 'alice', sortIndex: 300 });
      const item2 = db.create({ title: 'Task 2', assignee: 'bob', sortIndex: 100 });
      const item3 = db.create({ title: 'Task 3', assignee: 'alice', sortIndex: 200 });

      const aliceItems = db.list({ assignee: 'alice' });

      expect(aliceItems).toHaveLength(2);
      // Check sortIndex values are preserved
      const item1Result = aliceItems.find(i => i.id === item1.id);
      const item3Result = aliceItems.find(i => i.id === item3.id);
      expect(item1Result?.sortIndex).toBe(300);
      expect(item3Result?.sortIndex).toBe(200);
    });
  });
});
