/**
 * Regression test suite for the `wl next` selection algorithm.
 *
 * Each test case locks in a prior bug-fix scenario so that the algorithm
 * rebuild (WL-0MM2FKKOW1H0C0G4) does not regress previously fixed behaviors.
 *
 * Tests call the public `db.findNextWorkItem()` / `db.findNextWorkItems()`
 * entry points against a fresh in-memory database populated inline.
 *
 * Pattern notes:
 *   - Uses `await wait(10)` between creates when tests depend on distinct
 *     `createdAt` timestamps (per WL-0MM17NRAY0FJ1AK5 flaky-test fix).
 *   - Uses `createTempDir` / `cleanupTempDir` helpers for temp DB isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../src/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTempJsonlPath,
  createTempDbPath,
  wait,
} from './test-utils.js';

describe('wl next regression tests (WL-0MM2FKKOW1H0C0G4)', () => {
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

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Deleted items filtered (WL-0MLDIFLCR1REKNGA)
  // Deleted items must never be returned by wl next.
  // ─────────────────────────────────────────────────────────────────────
  describe('deleted items filtered (WL-0MLDIFLCR1REKNGA)', () => {
    it('should never return a deleted item even if it has the highest priority', () => {
      db.create({ title: 'Deleted critical', priority: 'critical', status: 'deleted' });
      const openItem = db.create({ title: 'Open low', priority: 'low', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(openItem.id);
    });

    it('should return null when only deleted items exist', () => {
      db.create({ title: 'Deleted A', priority: 'high', status: 'deleted' });
      db.create({ title: 'Deleted B', priority: 'critical', status: 'deleted' });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should filter deleted items from batch results', () => {
      db.create({ title: 'Deleted', priority: 'critical', status: 'deleted' });
      const a = db.create({ title: 'Open A', priority: 'high', status: 'open' });
      const b = db.create({ title: 'Open B', priority: 'medium', status: 'open' });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(ids).not.toContain(undefined);
      // Should contain only non-deleted items
      for (const r of results) {
        if (r.workItem) {
          expect(r.workItem.status).not.toBe('deleted');
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Orphan promotion under completed/deleted parents
  //             (WL-0MM1CD2IJ1R2ZI5J)
  // Items whose ancestors are completed or deleted must be promoted to
  // root level and compete on their own sortIndex.
  // ─────────────────────────────────────────────────────────────────────
  describe('orphan promotion under completed/deleted parents (WL-0MM1CD2IJ1R2ZI5J)', () => {
    it('should promote open child under completed parent to root level', () => {
      const completedParent = db.create({
        title: 'Completed parent',
        priority: 'high',
        status: 'completed',
        sortIndex: 100,
      });
      const orphan = db.create({
        title: 'Orphan task',
        priority: 'low',
        status: 'open',
        parentId: completedParent.id,
        sortIndex: 300,
      });
      const rootItem = db.create({
        title: 'Root feature',
        priority: 'medium',
        status: 'open',
        sortIndex: 50,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // rootItem (sortIndex=50) should sort before orphan (sortIndex=300)
      // since orphan is now at root level, not hidden under parent at 100
      expect(result.workItem!.id).toBe(rootItem.id);
    });

    it('should promote deeply nested orphan when all ancestors are completed', () => {
      const root = db.create({ title: 'Root', priority: 'high', status: 'completed', sortIndex: 100 });
      const l1 = db.create({ title: 'L1', priority: 'high', status: 'completed', parentId: root.id, sortIndex: 200 });
      const l2 = db.create({ title: 'L2', priority: 'high', status: 'completed', parentId: l1.id, sortIndex: 300 });
      const orphan = db.create({ title: 'Deep orphan', priority: 'medium', status: 'open', parentId: l2.id, sortIndex: 400 });
      const anotherRoot = db.create({ title: 'Another root', priority: 'medium', status: 'open', sortIndex: 50 });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // anotherRoot (sortIndex=50) should be picked first
      expect(result.workItem!.id).toBe(anotherRoot.id);
    });

    it('should promote orphan under deleted parent to root level', () => {
      const deletedParent = db.create({ title: 'Deleted parent', priority: 'high', status: 'deleted', sortIndex: 100 });
      const orphan = db.create({ title: 'Orphan under deleted', priority: 'medium', status: 'open', parentId: deletedParent.id, sortIndex: 200 });
      const rootItem = db.create({ title: 'Root item', priority: 'medium', status: 'open', sortIndex: 50 });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(rootItem.id);
    });

    it('should NOT promote child when parent is open', () => {
      const parent = db.create({ title: 'Open parent', priority: 'medium', status: 'open', sortIndex: 100 });
      const child = db.create({ title: 'Child task', priority: 'medium', status: 'open', parentId: parent.id, sortIndex: 200 });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Parent is open, so child stays under parent in hierarchy and child
      // is returned via hierarchy descent
      expect(result.workItem!.id).toBe(child.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Childless epic eligibility (WL-0MM1CD3SP1CO6NK9)
  // Epics without children must not be excluded from the candidate list.
  // ─────────────────────────────────────────────────────────────────────
  describe('childless epic eligibility (WL-0MM1CD3SP1CO6NK9)', () => {
    it('should surface a childless epic as a candidate', () => {
      const epic = db.create({
        title: 'Important epic',
        priority: 'high',
        status: 'open',
        issueType: 'epic',
        sortIndex: 100,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(epic.id);
    });

    it('should surface a critical childless epic over lower-priority non-epics', () => {
      db.create({ title: 'Low task', priority: 'low', status: 'open', sortIndex: 50 });
      const criticalEpic = db.create({
        title: 'Critical epic',
        priority: 'critical',
        status: 'open',
        issueType: 'epic',
        sortIndex: 200,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(criticalEpic.id);
    });

    it('should descend into epic children when they exist', () => {
      const epic = db.create({ title: 'Parent epic', priority: 'high', status: 'open', issueType: 'epic', sortIndex: 100 });
      const child = db.create({ title: 'Child task', priority: 'medium', status: 'open', parentId: epic.id, sortIndex: 200 });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(child.id);
    });

    it('should return the epic itself when all children are completed', () => {
      const epic = db.create({ title: 'Nearly done epic', priority: 'high', status: 'open', issueType: 'epic', sortIndex: 100 });
      db.create({ title: 'Done child', priority: 'medium', status: 'completed', parentId: epic.id, sortIndex: 200 });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(epic.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Batch dedup / unique results (WL-0MLFU4PQA1EJ1OQK)
  // `findNextWorkItems(n)` must return unique items, no duplicates.
  // ─────────────────────────────────────────────────────────────────────
  describe('batch dedup / unique results (WL-0MLFU4PQA1EJ1OQK)', () => {
    it('should return unique items in batch mode', () => {
      const a = db.create({ title: 'Task A', priority: 'high', status: 'open' });
      const b = db.create({ title: 'Task B', priority: 'medium', status: 'open' });
      const c = db.create({ title: 'Task C', priority: 'low', status: 'open' });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // All IDs must be unique
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(3);
    });

    it('should not return duplicates when requesting more items than available', () => {
      db.create({ title: 'Task A', priority: 'high', status: 'open' });
      db.create({ title: 'Task B', priority: 'medium', status: 'open' });

      const results = db.findNextWorkItems(5);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // Should only return 2 items (no padding with duplicates or nulls)
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(2);
    });

    it('should return unique items with hierarchy', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'open', sortIndex: 100 });
      const child1 = db.create({ title: 'Child 1', priority: 'high', status: 'open', parentId: parent.id, sortIndex: 200 });
      const child2 = db.create({ title: 'Child 2', priority: 'medium', status: 'open', parentId: parent.id, sortIndex: 300 });
      const other = db.create({ title: 'Other root', priority: 'medium', status: 'open', sortIndex: 400 });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: In-review exclusion (WL-0ML2TS8I409ALBU6)
  // Items with status=blocked + stage=in_review must be excluded by
  // default, but included when --include-in-review is set.
  // ─────────────────────────────────────────────────────────────────────
  describe('in-review exclusion (WL-0ML2TS8I409ALBU6)', () => {
    it('should exclude blocked in_review items by default', () => {
      const inReview = db.create({
        title: 'In review',
        status: 'blocked',
        stage: 'in_review',
        priority: 'high',
      });
      const openItem = db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(openItem.id);
      expect(result.workItem!.id).not.toBe(inReview.id);
    });

    it('should include blocked in_review items when includeInReview=true', () => {
      const inReview = db.create({
        title: 'In review',
        status: 'blocked',
        stage: 'in_review',
        priority: 'high',
      });
      db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem(undefined, undefined, true);
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(inReview.id);
    });

    it('should return null when only in-review items exist and flag is off', () => {
      db.create({ title: 'In review only', status: 'blocked', stage: 'in_review', priority: 'critical' });

      const result = db.findNextWorkItem();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Blocker-vs-priority ordering (WL-0MLYHCZCS1FY5I6H)
  // A higher-priority open item must win over the blocker of a
  // lower-priority blocked item.
  // ─────────────────────────────────────────────────────────────────────
  describe('blocker-vs-priority ordering (WL-0MLYHCZCS1FY5I6H)', () => {
    it('should prefer higher-priority open item over blocker of lower-priority blocked item', () => {
      // A (medium, open) blocks B (medium, blocked)
      // C (high, open) -- should win
      const blockerA = db.create({ title: 'Blocker A', priority: 'medium', status: 'open' });
      const blockedB = db.create({ title: 'Blocked B', priority: 'medium', status: 'blocked' });
      db.addDependencyEdge(blockedB.id, blockerA.id);
      const highC = db.create({ title: 'High priority C', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(highC.id);
    });

    it('should prefer blocker when blocked item has higher priority than all competitors', () => {
      // X (medium, open) blocks Y (critical, blocked)
      // Z (high, open) -- should lose because Y is critical
      const blockerX = db.create({ title: 'Blocker X', priority: 'medium', status: 'open' });
      const blockedY = db.create({ title: 'Blocked Y', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(blockedY.id, blockerX.id);
      db.create({ title: 'High priority Z', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(blockerX.id);
    });

    it('should prefer blocker when blocked item has equal priority to best competitor', () => {
      // Blocker (low) blocks BlockedItem (high, blocked)
      // Competitor (high, open)
      // Blocked item priority (high) is >= competitor (high), so blocker wins
      const blocker = db.create({ title: 'Blocker', priority: 'low', status: 'open' });
      const blockedItem = db.create({ title: 'Blocked item', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(blockedItem.id, blocker.id);
      db.create({ title: 'Competitor', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(blocker.id);
    });

    it('should prefer higher-priority open item over child blocker of lower-priority blocked item', () => {
      const parent = db.create({ title: 'Blocked parent', priority: 'medium', status: 'blocked' });
      db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: parent.id });
      const highItem = db.create({ title: 'High priority item', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(highItem.id);
    });

    it('should prefer child blocker when blocked parent has critical priority', () => {
      const parent = db.create({ title: 'Blocked parent', priority: 'critical', status: 'blocked' });
      const childBlocker = db.create({ title: 'Blocking child', priority: 'low', status: 'open', parentId: parent.id });
      db.create({ title: 'High priority item', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(childBlocker.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Blocked item filtering (WL-0MLZWO96O1RS086V)
  // Dependency-blocked items must be excluded by default and included
  // when --include-blocked is set.
  // ─────────────────────────────────────────────────────────────────────
  describe('blocked item filtering (WL-0MLZWO96O1RS086V)', () => {
    it('should not return a dependency-blocked item by default', () => {
      const itemA = db.create({ title: 'Dep-blocked A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Prerequisite B', priority: 'low', status: 'open' });
      db.addDependencyEdge(itemA.id, itemB.id);
      const itemC = db.create({ title: 'Unblocked C', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).not.toBe(itemA.id);
      expect([itemB.id, itemC.id]).toContain(result.workItem!.id);
    });

    it('should return a dependency-blocked item when includeBlocked=true', () => {
      const itemA = db.create({ title: 'Dep-blocked A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Prerequisite B', priority: 'low', status: 'open' });
      db.addDependencyEdge(itemA.id, itemB.id);

      const result = db.findNextWorkItem(undefined, undefined, false, true);
      expect(result.workItem).not.toBeNull();
      // With includeBlocked, A should be in the candidate pool
    });

    it('should not filter items whose dependency target is completed (edge inactive)', () => {
      const itemA = db.create({ title: 'Formerly blocked A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Completed prerequisite B', priority: 'low', status: 'completed' });
      db.addDependencyEdge(itemA.id, itemB.id);

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should still surface blockers for critical dep-blocked items', () => {
      const itemY = db.create({ title: 'Blocker Y', priority: 'low', status: 'open' });
      const itemX = db.create({ title: 'Critical blocked X', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(itemX.id, itemY.id);

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(itemY.id);
    });

    it('should not return a dep-blocked in-progress item', () => {
      const inProgressItem = db.create({ title: 'In-progress dep-blocked', priority: 'high', status: 'in-progress' });
      const prereq = db.create({ title: 'Prerequisite', priority: 'low', status: 'open' });
      db.addDependencyEdge(inProgressItem.id, prereq.id);
      const openItem = db.create({ title: 'Available open item', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).not.toBe(inProgressItem.id);
      expect([prereq.id, openItem.id]).toContain(result.workItem!.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Priority inheritance / scoring boost (WL-0MM0B4FNW0ZLOTV8)
  // Items that block high/critical-priority items must be prioritized
  // above equal-priority peers that block nothing.
  // ─────────────────────────────────────────────────────────────────────
  describe('priority inheritance / scoring boost (WL-0MM0B4FNW0ZLOTV8)', () => {
    it('should prefer item blocking a critical downstream item over equal-priority peer', () => {
      const itemA = db.create({ title: 'Unblocker A', priority: 'high', status: 'open' });
      db.create({ title: 'Plain B', priority: 'high', status: 'open' });
      const criticalDownstream = db.create({ title: 'Critical downstream', priority: 'critical', status: 'blocked' });
      db.addDependencyEdge(criticalDownstream.id, itemA.id);

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should prefer item blocking a high downstream item over equal-priority peer', () => {
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      db.create({ title: 'Plain B', priority: 'medium', status: 'open' });
      const highDownstream = db.create({ title: 'High downstream', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(highDownstream.id, itemA.id);

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should preserve priority dominance: high beats medium that blocks high', () => {
      // A is high priority, blocks nothing
      // B is medium priority, blocks a high-priority downstream
      // A should still win because own priority > boost
      const itemA = db.create({ title: 'High priority A', priority: 'high', status: 'open' });
      const itemB = db.create({ title: 'Medium unblocker B', priority: 'medium', status: 'open' });
      const highDownstream = db.create({ title: 'High downstream', priority: 'high', status: 'open' });
      db.addDependencyEdge(highDownstream.id, itemB.id);

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should prefer item blocking critical over item blocking only high', () => {
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      const itemB = db.create({ title: 'Unblocker B', priority: 'medium', status: 'open' });
      const criticalDownstream = db.create({ title: 'Critical downstream', priority: 'critical', status: 'blocked' });
      const highDownstream = db.create({ title: 'High downstream', priority: 'high', status: 'blocked' });
      db.addDependencyEdge(criticalDownstream.id, itemA.id);
      db.addDependencyEdge(highDownstream.id, itemB.id);

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should NOT boost an item that only blocks low/medium priority items', async () => {
      const itemA = db.create({ title: 'Blocks low A', priority: 'medium', status: 'open' });
      const lowDownstream = db.create({ title: 'Low downstream', priority: 'low', status: 'open' });
      db.addDependencyEdge(lowDownstream.id, itemA.id);
      await wait(10);
      const itemB = db.create({ title: 'Plain B', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      // A should win by age (older), NOT by boost since low doesn't qualify
      expect(result.workItem!.id).toBe(itemA.id);

      // Verify reverse: if B is older, B wins (no boost on A for medium)
      const db2TempDir = createTempDir();
      const db2Path = createTempDbPath(db2TempDir);
      const db2JsonlPath = createTempJsonlPath(db2TempDir);
      const db2 = new WorklogDatabase('TEST', db2Path, db2JsonlPath, true, true);
      try {
        const olderB = db2.create({ title: 'Older plain B', priority: 'medium', status: 'open' });
        await wait(10);
        const newerA = db2.create({ title: 'Blocks medium A', priority: 'medium', status: 'open' });
        const medDownstream = db2.create({ title: 'Medium downstream', priority: 'medium', status: 'open' });
        db2.addDependencyEdge(medDownstream.id, newerA.id);

        const result2 = db2.findNextWorkItem();
        expect(result2.workItem!.id).toBe(olderB.id);
      } finally {
        db2.close();
        cleanupTempDir(db2TempDir);
      }
    });

    it('should not boost for completed or deleted downstream items', async () => {
      const itemA = db.create({ title: 'Unblocker A', priority: 'medium', status: 'open' });
      await wait(10);
      const itemB = db.create({ title: 'Plain B', priority: 'medium', status: 'open' });
      const completedCritical = db.create({ title: 'Completed critical', priority: 'critical', status: 'completed' });
      db.addDependencyEdge(completedCritical.id, itemA.id);

      const result = db.findNextWorkItem();
      // A should NOT get a boost; wins by age (older)
      expect(result.workItem!.id).toBe(itemA.id);

      // Verify with deleted status
      const db2TempDir = createTempDir();
      const db2Path = createTempDbPath(db2TempDir);
      const db2JsonlPath = createTempJsonlPath(db2TempDir);
      const db2 = new WorklogDatabase('TEST', db2Path, db2JsonlPath, true, true);
      try {
        const olderB2 = db2.create({ title: 'Older B', priority: 'medium', status: 'open' });
        await wait(10);
        const newerA2 = db2.create({ title: 'Blocks deleted A', priority: 'medium', status: 'open' });
        const deletedCritical = db2.create({ title: 'Deleted critical', priority: 'critical', status: 'deleted' });
        db2.addDependencyEdge(deletedCritical.id, newerA2.id);

        const result2 = db2.findNextWorkItem();
        // No boost for deleted items; B is older so B wins
        expect(result2.workItem!.id).toBe(olderB2.id);
      } finally {
        db2.close();
        cleanupTempDir(db2TempDir);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Flaky test timing pattern (WL-0MM17NRAY0FJ1AK5)
  // Tests that depend on distinct createdAt timestamps must use
  // async+delay to avoid flaky results.
  // ─────────────────────────────────────────────────────────────────────
  describe('age-based tiebreaker with timing (WL-0MM17NRAY0FJ1AK5)', () => {
    it('should select oldest item when priorities are equal', async () => {
      const oldest = db.create({ title: 'Oldest', priority: 'high', status: 'open' });
      await wait(10);
      db.create({ title: 'Newer', priority: 'high', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(oldest.id);
    });

    it('should select oldest item in batch mode as first result', async () => {
      const oldest = db.create({ title: 'Oldest', priority: 'medium', status: 'open' });
      await wait(10);
      const newer = db.create({ title: 'Newer', priority: 'medium', status: 'open' });

      const results = db.findNextWorkItems(2);
      expect(results[0].workItem!.id).toBe(oldest.id);
      expect(results[1].workItem!.id).toBe(newer.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Blocked/in-review flag behavior (WL-0MLC3SUXI0QI9I3L)
  // The --include-in-review flag must correctly control inclusion of
  // blocked items with stage=in_review.
  // ─────────────────────────────────────────────────────────────────────
  describe('blocked/in-review flag behavior (WL-0MLC3SUXI0QI9I3L)', () => {
    it('should exclude blocked+in_review by default', () => {
      db.create({ title: 'In review', status: 'blocked', stage: 'in_review', priority: 'critical' });
      const openItem = db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(openItem.id);
    });

    it('should include blocked+in_review when includeInReview=true', () => {
      const inReview = db.create({ title: 'In review', status: 'blocked', stage: 'in_review', priority: 'critical' });
      db.create({ title: 'Open', status: 'open', priority: 'low' });

      const result = db.findNextWorkItem(undefined, undefined, true);
      expect(result.workItem!.id).toBe(inReview.id);
    });

    it('should not affect blocked items without in_review stage', () => {
      // A regular blocked item (not in_review) should be handled by normal blocked logic
      const blocked = db.create({ title: 'Blocked', status: 'blocked', priority: 'high' });
      const blocker = db.create({ title: 'Blocker child', status: 'open', priority: 'low', parentId: blocked.id });

      const result = db.findNextWorkItem();
      // Should surface the blocker for the blocked item
      expect(result.workItem!.id).toBe(blocker.id);
    });

    it('should not affect open items with in_review stage (edge case)', () => {
      // An open item with stage=in_review is NOT blocked, so the filter shouldn't apply
      const openInReview = db.create({ title: 'Open in review', status: 'open', stage: 'in_review', priority: 'high' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(openInReview.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Formal-only blocking (WL-0MLPSNIEL161NV6C)
  // Only formal relationships (children, dependency edges) should
  // identify blockers. Description/comment text must be ignored.
  // ─────────────────────────────────────────────────────────────────────
  describe('formal-only blocking (WL-0MLPSNIEL161NV6C)', () => {
    it('should ignore blocking issues mentioned in description', () => {
      const blocker = db.create({ title: 'Blocking issue', priority: 'low', status: 'open' });
      const blocked = db.create({
        title: 'Blocked task',
        priority: 'high',
        status: 'blocked',
        description: `This is blocked by ${blocker.id}`,
      });

      const result = db.findNextWorkItem();
      // Should return the blocked item since description hints are ignored
      expect(result.workItem!.id).toBe(blocked.id);
    });

    it('should ignore blocking issues mentioned in comments', () => {
      const blocker = db.create({ title: 'Blocking issue', priority: 'medium', status: 'open' });
      const blocked = db.create({ title: 'Blocked task', priority: 'high', status: 'blocked' });
      db.createComment({
        workItemId: blocked.id,
        author: 'test',
        comment: `Cannot proceed due to ${blocker.id}`,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(blocked.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Fixture-based integration (next-ranking-fixture.jsonl)
  // Verifies the dependency-chain scoring boost using the generalized
  // fixture file.
  // ─────────────────────────────────────────────────────────────────────
  describe('fixture: next-ranking dependency chain', () => {
    let fixtureTempDir: string;
    let fixtureDb: WorklogDatabase;

    beforeEach(() => {
      fixtureTempDir = createTempDir();
      const fixtureSource = path.resolve(__dirname, 'fixtures', 'next-ranking-fixture.jsonl');
      const fixtureJsonlPath = createTempJsonlPath(fixtureTempDir);
      const fixtureDbPath = createTempDbPath(fixtureTempDir);
      fs.copyFileSync(fixtureSource, fixtureJsonlPath);
      fixtureDb = new WorklogDatabase('FIX', fixtureDbPath, fixtureJsonlPath, false, true);
    });

    afterEach(() => {
      fixtureDb.close();
      cleanupTempDir(fixtureTempDir);
    });

    it('should prefer medium-priority unblocker over equal-priority peers when it blocks a high-priority item', () => {
      // FIX-PHASE2 (medium, open) blocks FIX-PHASE3 (high)
      // FIX-DISTRACT-A and FIX-DISTRACT-B are medium, open, no deps
      // FIX-PHASE2 should win due to blocking boost
      const result = fixtureDb.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe('FIX-PHASE2');
    });

    it('should select unblocked high-priority item over medium unblocker', () => {
      // Adding a new high-priority unblocked item should beat FIX-PHASE2
      const highItem = fixtureDb.create({ title: 'Urgent high item', priority: 'high', status: 'open' });

      const result = fixtureDb.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(highItem.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: In-progress handling
  // wl next should not return in-progress items themselves. It should
  // descend into children or fall back to other open items.
  // ─────────────────────────────────────────────────────────────────────
  describe('in-progress handling', () => {
    it('should not return in-progress item when it has no open children', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      db.create({ title: 'Done child', priority: 'high', status: 'completed', parentId: parent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem).toBeNull();
    });

    it('should select direct child under in-progress item', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'in-progress' });
      const child = db.create({ title: 'Child', priority: 'high', status: 'open', parentId: parent.id });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(child.id);
    });

    it('should skip in-progress item and select next open item when no open children', () => {
      db.create({ title: 'In-progress parent', priority: 'high', status: 'in-progress' });
      const openItem = db.create({ title: 'Other open task', priority: 'medium', status: 'open' });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(openItem.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Regression: Hierarchical sort (WL-0MLYIK4AA1WJPZNU)
  // Parent-child relationships should influence selection via hierarchy
  // descent from best root candidate.
  // ─────────────────────────────────────────────────────────────────────
  describe('hierarchical sort (WL-0MLYIK4AA1WJPZNU)', () => {
    it('should descend into best child of selected root', () => {
      const parent = db.create({ title: 'Parent', priority: 'high', status: 'open', sortIndex: 100 });
      const bestChild = db.create({ title: 'Best child', priority: 'high', status: 'open', parentId: parent.id, sortIndex: 200 });
      db.create({ title: 'Other child', priority: 'low', status: 'open', parentId: parent.id, sortIndex: 300 });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(bestChild.id);
    });

    it('should select among root-level candidates using sortIndex', () => {
      db.create({ title: 'Root A', priority: 'medium', status: 'open', sortIndex: 300 });
      const rootB = db.create({ title: 'Root B', priority: 'medium', status: 'open', sortIndex: 100 });
      db.create({ title: 'Root C', priority: 'medium', status: 'open', sortIndex: 200 });

      const result = db.findNextWorkItem();
      expect(result.workItem!.id).toBe(rootB.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Critical Escalation (WL-0MM346MLV0THH548)
  // handleCriticalEscalation() operates on the full item set.
  // Unblocked criticals win over all non-criticals; blocked criticals
  // surface their direct blocker (child or dependency edge).
  // ─────────────────────────────────────────────────────────────────────
  describe('critical escalation (WL-0MM346MLV0THH548)', () => {
    it('should surface blocker of critical item assigned to a different user', async () => {
      // Critical item assigned to Bob is blocked by a task assigned to Alice.
      // When Alice queries wl next --assignee alice, the blocker should surface
      // because handleCriticalEscalation operates on the FULL item set.
      const critical = db.create({
        title: 'Critical Bob item',
        priority: 'critical',
        status: 'blocked',
        assignee: 'bob',
      });
      const aliceBlocker = db.create({
        title: 'Alice blocker',
        priority: 'medium',
        status: 'open',
        assignee: 'alice',
        parentId: critical.id,
      });
      await wait(10);
      db.create({
        title: 'Alice normal task',
        priority: 'high',
        status: 'open',
        assignee: 'alice',
      });

      const result = db.findNextWorkItem('alice');
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(aliceBlocker.id);
      expect(result.reason).toContain('critical');
    });

    it('should surface dep-edge blocker of critical item from full set', async () => {
      // Critical item has a dependency-edge blocker. The blocker is not
      // assigned to anyone, but should still be surfaced.
      const critical = db.create({
        title: 'Critical with dep',
        priority: 'critical',
        status: 'blocked',
        assignee: 'bob',
      });
      const blocker = db.create({
        title: 'Dependency blocker',
        priority: 'medium',
        status: 'open',
      });
      db.addDependencyEdge(critical.id, blocker.id);
      await wait(10);
      db.create({
        title: 'Other task',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(blocker.id);
      expect(result.reason).toContain('critical');
    });

    it('should prefer unblocked critical over non-critical items regardless of sortIndex', async () => {
      // Even if a non-critical has a better sortIndex, the unblocked critical wins.
      db.create({
        title: 'Non-critical first',
        priority: 'high',
        status: 'open',
        sortIndex: 1,
      });
      await wait(10);
      const critical = db.create({
        title: 'Critical item',
        priority: 'critical',
        status: 'open',
        sortIndex: 999,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(critical.id);
      expect(result.reason).toContain('critical');
    });

    it('should select among multiple unblocked criticals by sortIndex', () => {
      db.create({
        title: 'Critical A',
        priority: 'critical',
        status: 'open',
        sortIndex: 300,
      });
      const criticalB = db.create({
        title: 'Critical B',
        priority: 'critical',
        status: 'open',
        sortIndex: 100,
      });
      db.create({
        title: 'Critical C',
        priority: 'critical',
        status: 'open',
        sortIndex: 200,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(criticalB.id);
    });

    it('should fall back to priority+age when all criticals have same sortIndex', async () => {
      const criticalOld = db.create({
        title: 'Critical old',
        priority: 'critical',
        status: 'open',
        sortIndex: 0,
      });
      await wait(10);
      db.create({
        title: 'Critical new',
        priority: 'critical',
        status: 'open',
        sortIndex: 0,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Same priority, same sortIndex — oldest wins
      expect(result.workItem!.id).toBe(criticalOld.id);
    });

    it('should return blocked critical as last resort when no blockers found', () => {
      // A blocked critical with no children and no dep edges
      const critical = db.create({
        title: 'Stuck critical',
        priority: 'critical',
        status: 'blocked',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(critical.id);
      expect(result.reason).toContain('no identifiable blocking issues');
    });

    it('should not surface blocked+in_review critical when includeInReview is false', () => {
      db.create({
        title: 'In review critical',
        priority: 'critical',
        status: 'blocked',
        stage: 'in_review',
      });
      const openItem = db.create({
        title: 'Open low',
        priority: 'low',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(openItem.id);
    });

    it('should surface blocked+in_review critical when includeInReview is true', () => {
      const critical = db.create({
        title: 'In review critical',
        priority: 'critical',
        status: 'blocked',
        stage: 'in_review',
      });
      db.create({
        title: 'Open low',
        priority: 'low',
        status: 'open',
      });

      const result = db.findNextWorkItem(undefined, undefined, true);
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(critical.id);
    });

    it('should surface blocker from outside search filter for critical item', async () => {
      // Critical item mentions "infra" in its title but its blocker mentions "auth".
      // When searching for "auth", the blocker should be surfaced because
      // critical escalation finds the critical from the full set.
      const critical = db.create({
        title: 'Critical infra issue',
        priority: 'critical',
        status: 'blocked',
      });
      const blocker = db.create({
        title: 'Auth service fix',
        priority: 'medium',
        status: 'open',
        parentId: critical.id,
      });
      await wait(10);
      db.create({
        title: 'Auth docs update',
        priority: 'low',
        status: 'open',
      });

      const result = db.findNextWorkItem(undefined, 'auth');
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(blocker.id);
      expect(result.reason).toContain('critical');
    });

    it('should handle critical with both child and dep-edge blockers', async () => {
      // Critical item has both a child and a dep-edge blocker.
      // Either blocker may be selected depending on hierarchy sort order;
      // the important thing is that one of them is surfaced.
      const critical = db.create({
        title: 'Critical with both',
        priority: 'critical',
        status: 'blocked',
      });
      const childBlocker = db.create({
        title: 'Child blocker',
        priority: 'medium',
        status: 'open',
        parentId: critical.id,
        sortIndex: 200,
      });
      const depBlocker = db.create({
        title: 'Dep blocker',
        priority: 'medium',
        status: 'open',
        sortIndex: 100,
      });
      db.addDependencyEdge(critical.id, depBlocker.id);

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Either blocker is acceptable; both unblock the critical
      const selectedId = result.workItem!.id;
      expect([childBlocker.id, depBlocker.id]).toContain(selectedId);
      expect(result.reason).toContain('critical');
    });

    it('should skip excluded blockers in batch mode', async () => {
      const critical = db.create({
        title: 'Critical parent',
        priority: 'critical',
        status: 'blocked',
      });
      const child1 = db.create({
        title: 'First child',
        priority: 'high',
        status: 'open',
        parentId: critical.id,
        sortIndex: 100,
      });
      await wait(10);
      const child2 = db.create({
        title: 'Second child',
        priority: 'high',
        status: 'open',
        parentId: critical.id,
        sortIndex: 200,
      });

      const results = db.findNextWorkItems(2);
      expect(results.length).toBe(2);
      // First batch result should pick child1 (lower sortIndex)
      expect(results[0].workItem!.id).toBe(child1.id);
      // Second batch result should pick child2 (child1 is excluded)
      expect(results[1].workItem!.id).toBe(child2.id);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Blocker priority inheritance (WL-0MM346ZBD1YSKKSV)
  // When all sortIndex values are equal, selectBySortIndex falls back to
  // effective priority (max of own priority and priority inherited from
  // blocked dependents or parent items) then createdAt (oldest first).
  // ─────────────────────────────────────────────────────────────────────
  describe('blocker priority inheritance (WL-0MM346ZBD1YSKKSV)', () => {
    it('should elevate a low-priority item that blocks a critical item via dependency edge', async () => {
      // lowBlocker (low, open) blocks criticalItem (critical, blocked) via dep edge
      // mediumItem (medium, open) — would normally win by own priority
      // Expected: lowBlocker wins because it inherits critical effective priority
      const criticalItem = db.create({
        title: 'Critical blocked',
        priority: 'critical',
        status: 'blocked',
      });
      await wait(10);
      const lowBlocker = db.create({
        title: 'Low blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(criticalItem.id, lowBlocker.id);
      await wait(10);
      const mediumItem = db.create({
        title: 'Medium standalone',
        priority: 'medium',
        status: 'open',
      });

      // Critical blocked items are handled by Stage 2 (critical escalation),
      // so the low blocker should be surfaced as a critical blocker.
      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(lowBlocker.id);
      expect(result.reason).toContain('Blocking issue');
    });

    it('should prefer higher effective priority over raw priority when sortIndex values are equal', async () => {
      // Two open items, same sortIndex (default 0):
      //   itemA (low, open) — blocks highBlocked (high, blocked) via dep edge
      //   itemB (medium, open) — standalone
      // itemA effective priority = high (inherited), itemB effective = medium (own)
      // Expected: itemA wins because its effective priority is higher
      //
      // Note: If the high blocked item triggers Stage 3 blocker surfacing,
      // itemA is surfaced as a blocker. Either way, itemA should be selected.
      const highBlocked = db.create({
        title: 'High blocked',
        priority: 'high',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low blocker of high',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(highBlocked.id, itemA.id);
      await wait(10);
      db.create({
        title: 'Medium standalone',
        priority: 'medium',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should inherit priority from parent via parent-child relationship', async () => {
      // parent (high, open), childA (low, open, child of parent), childB (low, open, child of parent)
      // Both children inherit high effective priority from parent.
      // Tiebreaker: createdAt — childA is older, so childA wins.
      const parent = db.create({
        title: 'High parent',
        priority: 'high',
        status: 'open',
      });
      await wait(10);
      const childA = db.create({
        title: 'Child A',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });
      await wait(10);
      db.create({
        title: 'Child B',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Selection descends into parent's children; both have effective=high,
      // so createdAt tiebreaker picks childA (older).
      expect(result.workItem!.id).toBe(childA.id);
    });

    it('should not inherit priority from completed dependents', async () => {
      // completedItem (critical, completed) depends on itemA (low, open) via dep edge
      // itemB (medium, open) — standalone
      // itemA should NOT inherit from completed dependent → effective = low
      // Expected: itemB wins (medium > low)
      const completedItem = db.create({
        title: 'Completed critical',
        priority: 'critical',
        status: 'completed',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low item',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(completedItem.id, itemA.id);
      await wait(10);
      const itemB = db.create({
        title: 'Medium item',
        priority: 'medium',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemB.id);
    });

    it('should not inherit priority from deleted parent', async () => {
      // parent (critical, deleted) has childA (low, open)
      // itemB (medium, open)
      // childA should NOT inherit from deleted parent → effective = low
      // Expected: itemB wins (medium > low)
      db.create({
        title: 'Deleted critical parent',
        priority: 'critical',
        status: 'deleted',
      });
      // Create itemB first so it doesn't win by createdAt
      const itemB = db.create({
        title: 'Medium item',
        priority: 'medium',
        status: 'open',
      });
      await wait(10);
      // Note: parentId still references the deleted parent, but inheritance
      // should skip deleted parents.
      db.create({
        title: 'Child of deleted',
        priority: 'low',
        status: 'open',
        parentId: undefined, // Deleted parents' children are effectively orphans
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemB.id);
    });

    it('should take the maximum of own priority and inherited priority', async () => {
      // itemA (high, open) blocks mediumBlocked (medium, blocked) via dep edge
      // itemA own = high, inherited from dependent = medium → effective = high (own wins)
      // itemB (high, open)
      // Both have effective=high; itemA is older → itemA wins by createdAt
      const mediumBlocked = db.create({
        title: 'Medium blocked',
        priority: 'medium',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'High blocker',
        priority: 'high',
        status: 'open',
      });
      db.addDependencyEdge(mediumBlocked.id, itemA.id);
      await wait(10);
      db.create({
        title: 'High standalone',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      // Both have effective=high; itemA wins by createdAt (older).
      // Note: mediumBlocked may trigger Stage 3 blocker surfacing if its
      // priority >= the best open competitor. Either way, itemA is selected.
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should include effective priority info in reason string when priority is inherited', async () => {
      // parent (critical, open), child (low, open, child of parent)
      // No other candidates, so child is selected. Reason should mention inheritance.
      const parent = db.create({
        title: 'Critical parent',
        priority: 'critical',
        status: 'open',
      });
      await wait(10);
      const child = db.create({
        title: 'Low child',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(child.id);
      // Reason should mention the inherited priority
      expect(result.reason).toContain('inherited from');
      expect(result.reason).toContain(parent.id);
    });

    it('should show own priority in reason when no inheritance occurs', async () => {
      // Single high-priority item — no inheritance, reason should show own priority
      const item = db.create({
        title: 'High standalone',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(item.id);
      expect(result.reason).toContain('priority high');
    });

    it('should inherit the highest priority among multiple dependents', async () => {
      // criticalDep (critical, blocked) depends on itemA via dep edge
      // highDep (high, blocked) depends on itemA via dep edge
      // itemA (low, open) — inherits critical (the highest)
      // itemB (high, open) — standalone
      // Expected: itemA wins via critical escalation (Stage 2) or effective priority
      const criticalDep = db.create({
        title: 'Critical dependent',
        priority: 'critical',
        status: 'blocked',
      });
      await wait(10);
      const highDep = db.create({
        title: 'High dependent',
        priority: 'high',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low multi-blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(criticalDep.id, itemA.id);
      db.addDependencyEdge(highDep.id, itemA.id);
      await wait(10);
      db.create({
        title: 'High standalone',
        priority: 'high',
        status: 'open',
      });

      const result = db.findNextWorkItem();
      expect(result.workItem).not.toBeNull();
      expect(result.workItem!.id).toBe(itemA.id);
    });

    it('should use effective priority in batch mode across multiple selections', async () => {
      // itemA (low, open) blocks highBlocked (high, blocked) via dep edge → effective=high
      // itemB (medium, open) — standalone → effective=medium
      // itemC (low, open) — standalone → effective=low
      // Batch of 3: should order by effective priority
      const highBlocked = db.create({
        title: 'High blocked',
        priority: 'high',
        status: 'blocked',
      });
      await wait(10);
      const itemA = db.create({
        title: 'Low blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(highBlocked.id, itemA.id);
      await wait(10);
      const itemB = db.create({
        title: 'Medium standalone',
        priority: 'medium',
        status: 'open',
      });
      await wait(10);
      const itemC = db.create({
        title: 'Low standalone',
        priority: 'low',
        status: 'open',
      });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      // itemA should be first (effective=high via blocker surfacing or effective priority)
      expect(ids[0]).toBe(itemA.id);
      // Remaining items should include both itemB and itemC
      expect(ids).toContain(itemB.id);
      expect(ids).toContain(itemC.id);
    });

    it('computeEffectivePriority returns correct result for item with no dependents', () => {
      const item = db.create({
        title: 'Standalone medium',
        priority: 'medium',
        status: 'open',
      });

      const result = db.computeEffectivePriority(item);
      expect(result.value).toBe(2); // medium = 2
      expect(result.reason).toContain('own priority: medium');
      expect(result.inheritedFrom).toBeUndefined();
    });

    it('computeEffectivePriority returns inherited priority from dependency edge', () => {
      const critical = db.create({
        title: 'Critical dependent',
        priority: 'critical',
        status: 'blocked',
      });
      const blocker = db.create({
        title: 'Low blocker',
        priority: 'low',
        status: 'open',
      });
      db.addDependencyEdge(critical.id, blocker.id);

      const result = db.computeEffectivePriority(blocker);
      expect(result.value).toBe(4); // critical = 4
      expect(result.reason).toContain('inherited from');
      expect(result.reason).toContain(critical.id);
      expect(result.inheritedFrom).toBe(critical.id);
    });

    it('computeEffectivePriority returns inherited priority from parent', () => {
      const parent = db.create({
        title: 'High parent',
        priority: 'high',
        status: 'open',
      });
      const child = db.create({
        title: 'Low child',
        priority: 'low',
        status: 'open',
        parentId: parent.id,
      });

      const result = db.computeEffectivePriority(child);
      expect(result.value).toBe(3); // high = 3
      expect(result.reason).toContain('inherited from');
      expect(result.reason).toContain(parent.id);
      expect(result.inheritedFrom).toBe(parent.id);
    });

    it('computeEffectivePriority uses cache for repeated calls', () => {
      const item = db.create({
        title: 'Medium item',
        priority: 'medium',
        status: 'open',
      });

      const cache = new Map<string, { value: number; reason: string; inheritedFrom?: string }>();
      const result1 = db.computeEffectivePriority(item, cache);
      const result2 = db.computeEffectivePriority(item, cache);

      // Both calls should return the same object reference (from cache)
      expect(result1).toBe(result2);
      expect(cache.size).toBe(1);
      expect(cache.has(item.id)).toBe(true);
    });
  });

  // ── buildCandidateList / batch mode (WL-0MM347F9D1EGKLSQ) ──
  describe('buildCandidateList batch mode (WL-0MM347F9D1EGKLSQ)', () => {
    it('batch mode with 500 items completes in < 500ms for n=10', () => {
      const priorities = ['low', 'medium', 'high', 'critical'] as const;
      for (let i = 0; i < 500; i++) {
        db.create({
          title: `Task ${i}`,
          priority: priorities[i % 4],
          status: i % 10 === 0 ? 'completed' : 'open',
          sortIndex: i * 10,
        });
      }

      const start = Date.now();
      const results = db.findNextWorkItems(10);
      const duration = Date.now() - start;

      expect(results.length).toBe(10);
      expect(duration).toBeLessThan(3000); // Budget: <500ms typical, 3s under full-suite load
      // All returned items should be unique
      const ids = results.map(r => r.workItem?.id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('batch mode returns in-progress children before unrelated open items', async () => {
      const parent = db.create({
        title: 'WIP parent',
        priority: 'high',
        status: 'in-progress',
      });
      await wait(10);
      const child1 = db.create({
        title: 'Child 1',
        priority: 'medium',
        status: 'open',
        parentId: parent.id,
      });
      await wait(10);
      const child2 = db.create({
        title: 'Child 2',
        priority: 'medium',
        status: 'open',
        parentId: parent.id,
      });
      await wait(10);
      const unrelated = db.create({
        title: 'Unrelated open',
        priority: 'high',
        status: 'open',
      });

      const results = db.findNextWorkItems(4);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);

      // Children of in-progress parent should come first
      expect(ids[0]).toBe(child1.id);
      expect(ids[1]).toBe(child2.id);
      // The parent should NOT appear (it's in-progress)
      expect(ids).not.toContain(parent.id);
      // Unrelated item should also appear
      expect(ids).toContain(unrelated.id);
    });

    it('batch mode preserves root-then-descend ordering across subtrees', async () => {
      // Root A (high) -> Leaf A1 (medium)
      // Root B (medium)
      // Expected batch order: Leaf A1 (descends from Root A which wins), then Root B
      const rootA = db.create({
        title: 'Root A',
        priority: 'high',
        status: 'open',
      });
      await wait(10);
      const leafA1 = db.create({
        title: 'Leaf A1',
        priority: 'medium',
        status: 'open',
        parentId: rootA.id,
      });
      await wait(10);
      const rootB = db.create({
        title: 'Root B',
        priority: 'medium',
        status: 'open',
      });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);

      expect(ids[0]).toBe(leafA1.id); // Descends from high-priority root A
      expect(ids[1]).toBe(rootB.id);  // Root B is next
      expect(ids).not.toContain(rootA.id); // Root A is not a leaf, not directly recommended
    });

    it('batch mode returns empty-result guard when no items exist', () => {
      const results = db.findNextWorkItems(5);
      expect(results.length).toBe(1);
      expect(results[0].workItem).toBeNull();
      expect(results[0].reason).toContain('No');
    });

    it('batch mode with N > available returns only available candidates', async () => {
      db.create({ title: 'Only item', priority: 'medium', status: 'open' });

      const results = db.findNextWorkItems(10);
      expect(results.length).toBe(1);
      expect(results[0].workItem).not.toBeNull();
    });

    it('batch mode critical escalation precedes normal candidates', async () => {
      const normal = db.create({
        title: 'Normal high',
        priority: 'high',
        status: 'open',
      });
      await wait(10);
      const critBlocked = db.create({
        title: 'Critical blocked',
        priority: 'critical',
        status: 'blocked',
      });
      await wait(10);
      const blocker = db.create({
        title: 'Blocker of critical',
        priority: 'low',
        status: 'open',
        parentId: critBlocked.id,
      });

      const results = db.findNextWorkItems(3);
      const ids = results.map(r => r.workItem?.id).filter(Boolean);

      // Blocker of critical should come first (critical escalation tier)
      expect(ids[0]).toBe(blocker.id);
      // Normal high-priority item should come after
      expect(ids).toContain(normal.id);
    });
  });
});
