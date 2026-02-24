/**
 * Tests for FTS5 full-text search
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import { createTempDir, cleanupTempDir, createTempJsonlPath, createTempDbPath } from './test-utils.js';

describe('FTS Search', () => {
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

  describe('ftsAvailable', () => {
    it('should report FTS5 as available', () => {
      // better-sqlite3 includes FTS5 by default
      expect(db.ftsAvailable).toBe(true);
    });
  });

  describe('search after create', () => {
    it('should find a work item by title', () => {
      db.create({ title: 'Database corruption fix' });
      const { results, ftsUsed } = db.search('database');
      expect(ftsUsed).toBe(true);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBeDefined();
    });

    it('should find a work item by description', () => {
      db.create({
        title: 'Simple title',
        description: 'This work item fixes a memory leak in the parser module',
      });
      const { results } = db.search('memory leak');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].matchedColumn).toBe('description');
    });

    it('should find a work item by tags', () => {
      db.create({
        title: 'Unrelated title',
        tags: ['frontend', 'react', 'performance'],
      });
      const { results } = db.search('react');
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should return snippet with highlight markers', () => {
      db.create({ title: 'Implement caching layer for Redis' });
      const { results } = db.search('caching');
      expect(results.length).toBeGreaterThanOrEqual(1);
      // FTS5 snippets use << >> markers
      expect(results[0].snippet).toContain('<<');
      expect(results[0].snippet).toContain('>>');
    });

    it('should return empty results for non-matching query', () => {
      db.create({ title: 'Something completely different' });
      const { results } = db.search('xyznonexistent');
      expect(results.length).toBe(0);
    });

    it('should return empty results for empty query', () => {
      db.create({ title: 'Test item' });
      const { results } = db.search('');
      expect(results.length).toBe(0);
    });
  });

  describe('search with filters', () => {
    it('should filter by status', () => {
      db.create({ title: 'Open bug', status: 'open' });
      db.create({ title: 'Closed bug fix', status: 'completed' });

      const { results: openResults } = db.search('bug', { status: 'open' });
      expect(openResults.length).toBe(1);
      expect(openResults[0].itemId).toBeDefined();

      const { results: closedResults } = db.search('bug', { status: 'completed' });
      expect(closedResults.length).toBe(1);
    });

    it('should filter by parentId', () => {
      const parent = db.create({ title: 'Parent epic' });
      db.create({ title: 'Child feature work', parentId: parent.id });
      db.create({ title: 'Orphan feature work' });

      const { results } = db.search('feature', { parentId: parent.id });
      expect(results.length).toBe(1);
    });

    it('should filter by tags', () => {
      db.create({ title: 'Frontend widget', tags: ['frontend', 'ui'] });
      db.create({ title: 'Backend widget', tags: ['backend', 'api'] });

      const { results } = db.search('widget', { tags: ['frontend'] });
      expect(results.length).toBe(1);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 10; i++) {
        db.create({ title: `Repeated search target item ${i}` });
      }

      const { results } = db.search('search target', { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('search with new filter flags', () => {
    describe('--priority filter', () => {
      it('should filter by priority (FTS path)', () => {
        db.create({ title: 'Priority alpha task', priority: 'high' });
        db.create({ title: 'Priority alpha chore', priority: 'low' });

        const { results } = db.search('priority alpha', { priority: 'high' });
        expect(results.length).toBe(1);
        // verify the returned item is the high-priority one
        const item = db.get(results[0].itemId);
        expect(item?.priority).toBe('high');
      });

      it('should return no results when priority does not match', () => {
        db.create({ title: 'Priority beta task', priority: 'medium' });

        const { results } = db.search('priority beta', { priority: 'critical' });
        expect(results.length).toBe(0);
      });
    });

    describe('--assignee filter', () => {
      it('should filter by assignee (FTS path)', () => {
        db.create({ title: 'Assignee alpha work', assignee: 'alice' });
        db.create({ title: 'Assignee alpha work', assignee: 'bob' });

        const { results } = db.search('assignee alpha', { assignee: 'alice' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.assignee).toBe('alice');
      });

      it('should return no results when assignee does not match', () => {
        db.create({ title: 'Assignee beta work', assignee: 'alice' });

        const { results } = db.search('assignee beta', { assignee: 'charlie' });
        expect(results.length).toBe(0);
      });
    });

    describe('--stage filter', () => {
      it('should filter by stage (FTS path)', () => {
        db.create({ title: 'Stage alpha item', stage: 'in_progress' });
        db.create({ title: 'Stage alpha item', stage: 'done' });

        const { results } = db.search('stage alpha', { stage: 'in_progress' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.stage).toBe('in_progress');
      });
    });

    describe('--issue-type filter', () => {
      it('should filter by issueType (FTS path)', () => {
        db.create({ title: 'Issuetype alpha entry', issueType: 'bug' });
        db.create({ title: 'Issuetype alpha entry', issueType: 'feature' });

        const { results } = db.search('issuetype alpha', { issueType: 'bug' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.issueType).toBe('bug');
      });
    });

    describe('--needs-producer-review filter', () => {
      it('should filter by needsProducerReview true (FTS path)', () => {
        db.create({ title: 'Review alpha item', needsProducerReview: true });
        db.create({ title: 'Review alpha item', needsProducerReview: false });

        const { results } = db.search('review alpha', { needsProducerReview: true });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.needsProducerReview).toBe(true);
      });

      it('should filter by needsProducerReview false (FTS path)', () => {
        db.create({ title: 'Review beta item', needsProducerReview: true });
        db.create({ title: 'Review beta item', needsProducerReview: false });

        const { results } = db.search('review beta', { needsProducerReview: false });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.needsProducerReview).toBe(false);
      });
    });

    describe('--deleted filter', () => {
      it('should exclude items with status deleted by default (FTS path)', () => {
        // Create an item directly with status 'deleted' — this keeps its
        // FTS entry (unlike db.delete which removes it), so the FTS JOIN
        // exclusion clause `AND workitems.status != deleted` is exercised.
        db.create({ title: 'Deleted alpha item', status: 'deleted' as any });
        db.create({ title: 'Deleted alpha item', status: 'open' });

        const { results } = db.search('deleted alpha');
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.status).toBe('open');
      });

      it('should include items with status deleted when deleted flag is set (FTS path)', () => {
        db.create({ title: 'Deleted beta item', status: 'deleted' as any });
        db.create({ title: 'Deleted beta item', status: 'open' });

        const { results } = db.search('deleted beta', { deleted: true });
        expect(results.length).toBe(2);
      });
    });

    describe('combined filters', () => {
      it('should combine priority and assignee (FTS path)', () => {
        db.create({ title: 'Combined alpha work', priority: 'high', assignee: 'alice' });
        db.create({ title: 'Combined alpha work', priority: 'high', assignee: 'bob' });
        db.create({ title: 'Combined alpha work', priority: 'low', assignee: 'alice' });

        const { results } = db.search('combined alpha', { priority: 'high', assignee: 'alice' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.priority).toBe('high');
        expect(item?.assignee).toBe('alice');
      });

      it('should combine stage, issueType, and existing status filter (FTS path)', () => {
        db.create({ title: 'Multi alpha item', stage: 'in_progress', issueType: 'bug', status: 'in-progress' });
        db.create({ title: 'Multi alpha item', stage: 'in_progress', issueType: 'feature', status: 'in-progress' });
        db.create({ title: 'Multi alpha item', stage: 'done', issueType: 'bug', status: 'completed' });

        const { results } = db.search('multi alpha', { stage: 'in_progress', issueType: 'bug', status: 'in-progress' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.stage).toBe('in_progress');
        expect(item?.issueType).toBe('bug');
        expect(item?.status).toBe('in-progress');
      });

      it('should combine new filters with existing tags filter (FTS path)', () => {
        db.create({ title: 'Tagscombo alpha item', priority: 'high', tags: ['frontend'] });
        db.create({ title: 'Tagscombo alpha item', priority: 'high', tags: ['backend'] });
        db.create({ title: 'Tagscombo alpha item', priority: 'low', tags: ['frontend'] });

        const { results } = db.search('tagscombo alpha', { priority: 'high', tags: ['frontend'] });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.priority).toBe('high');
        expect(item?.tags).toContain('frontend');
      });
    });
  });

  describe('searchFallback with new filter flags', () => {
    // Test the fallback search path directly via SqlitePersistentStore.searchFallback().
    // better-sqlite3 always includes FTS5, so we cannot disable it at the
    // WorklogDatabase level; calling searchFallback() on the store exercises
    // the application-level filtering code path that would run when FTS5 is
    // unavailable.

    describe('--priority filter (fallback)', () => {
      it('should filter by priority', () => {
        db.create({ title: 'Fbpriority alpha task', priority: 'high' });
        db.create({ title: 'Fbpriority alpha chore', priority: 'low' });

        const results = (db as any).store.searchFallback('fbpriority alpha', { priority: 'high' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.priority).toBe('high');
      });
    });

    describe('--assignee filter (fallback)', () => {
      it('should filter by assignee', () => {
        db.create({ title: 'Fbassignee alpha work', assignee: 'alice' });
        db.create({ title: 'Fbassignee alpha work', assignee: 'bob' });

        const results = (db as any).store.searchFallback('fbassignee alpha', { assignee: 'alice' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.assignee).toBe('alice');
      });
    });

    describe('--stage filter (fallback)', () => {
      it('should filter by stage', () => {
        db.create({ title: 'Fbstage alpha item', stage: 'review' });
        db.create({ title: 'Fbstage alpha item', stage: 'done' });

        const results = (db as any).store.searchFallback('fbstage alpha', { stage: 'review' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.stage).toBe('review');
      });
    });

    describe('--issue-type filter (fallback)', () => {
      it('should filter by issueType', () => {
        db.create({ title: 'Fbtype alpha entry', issueType: 'epic' });
        db.create({ title: 'Fbtype alpha entry', issueType: 'task' });

        const results = (db as any).store.searchFallback('fbtype alpha', { issueType: 'epic' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.issueType).toBe('epic');
      });
    });

    describe('--needs-producer-review filter (fallback)', () => {
      it('should filter by needsProducerReview true', () => {
        db.create({ title: 'Fbreview alpha item', needsProducerReview: true });
        db.create({ title: 'Fbreview alpha item', needsProducerReview: false });

        const results = (db as any).store.searchFallback('fbreview alpha', { needsProducerReview: true });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.needsProducerReview).toBe(true);
      });

      it('should filter by needsProducerReview false', () => {
        db.create({ title: 'Fbreview beta item', needsProducerReview: true });
        db.create({ title: 'Fbreview beta item', needsProducerReview: false });

        const results = (db as any).store.searchFallback('fbreview beta', { needsProducerReview: false });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.needsProducerReview).toBe(false);
      });
    });

    describe('--deleted filter (fallback)', () => {
      it('should exclude deleted items by default', () => {
        db.create({ title: 'Fbdeleted alpha item', status: 'open' });
        // Create an item with status 'deleted' directly (avoids db.delete
        // which would also remove the FTS entry, allowing us to verify the
        // fallback filter independently).
        db.create({ title: 'Fbdeleted alpha item', status: 'deleted' as any });

        const results = (db as any).store.searchFallback('fbdeleted alpha');
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.status).toBe('open');
      });

      it('should include deleted items when deleted flag is set', () => {
        db.create({ title: 'Fbdeleted beta item', status: 'open' });
        db.create({ title: 'Fbdeleted beta item', status: 'deleted' as any });

        const results = (db as any).store.searchFallback('fbdeleted beta', { deleted: true });
        expect(results.length).toBe(2);
      });
    });

    describe('combined filters (fallback)', () => {
      it('should combine priority and assignee', () => {
        db.create({ title: 'Fbcombo alpha work', priority: 'high', assignee: 'alice' });
        db.create({ title: 'Fbcombo alpha work', priority: 'high', assignee: 'bob' });
        db.create({ title: 'Fbcombo alpha work', priority: 'low', assignee: 'alice' });

        const results = (db as any).store.searchFallback('fbcombo alpha', { priority: 'high', assignee: 'alice' });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.priority).toBe('high');
        expect(item?.assignee).toBe('alice');
      });

      it('should combine stage, issueType and needsProducerReview', () => {
        db.create({ title: 'Fbmulti alpha item', stage: 'review', issueType: 'bug', needsProducerReview: true });
        db.create({ title: 'Fbmulti alpha item', stage: 'review', issueType: 'bug', needsProducerReview: false });
        db.create({ title: 'Fbmulti alpha item', stage: 'done', issueType: 'bug', needsProducerReview: true });

        const results = (db as any).store.searchFallback('fbmulti alpha', { stage: 'review', issueType: 'bug', needsProducerReview: true });
        expect(results.length).toBe(1);
        const item = db.get(results[0].itemId);
        expect(item?.stage).toBe('review');
        expect(item?.issueType).toBe('bug');
        expect(item?.needsProducerReview).toBe(true);
      });
    });
  });

  describe('index updates on write', () => {
    it('should reflect updates in search results', () => {
      const item = db.create({ title: 'Original title alpha' });
      let { results } = db.search('alpha');
      expect(results.length).toBe(1);

      db.update(item.id, { title: 'Updated title beta' });
      ({ results } = db.search('alpha'));
      expect(results.length).toBe(0);

      ({ results } = db.search('beta'));
      expect(results.length).toBe(1);
    });

    it('should remove deleted items from search', () => {
      const item = db.create({ title: 'Deletable item gamma' });
      let { results } = db.search('gamma');
      expect(results.length).toBe(1);

      db.delete(item.id);
      ({ results } = db.search('gamma'));
      expect(results.length).toBe(0);
    });

    it('should index comment text and reflect comment changes', () => {
      const item = db.create({ title: 'Bug report' });

      // Add a comment and search for it
      db.createComment({
        workItemId: item.id,
        author: 'tester',
        comment: 'Reproduced the segfault on ARM64',
      });

      let { results } = db.search('segfault');
      expect(results.length).toBe(1);
      expect(results[0].itemId).toBe(item.id);

      // Update the comment
      const comments = db.getCommentsForWorkItem(item.id);
      db.updateComment(comments[0].id, { comment: 'Actually it was a null pointer dereference' });

      ({ results } = db.search('segfault'));
      expect(results.length).toBe(0);

      ({ results } = db.search('null pointer'));
      expect(results.length).toBe(1);
    });

    it('should update index when a comment is deleted', () => {
      const item = db.create({ title: 'Feature request' });
      const comment = db.createComment({
        workItemId: item.id,
        author: 'user',
        comment: 'Please add dark mode support',
      });

      let { results } = db.search('dark mode');
      expect(results.length).toBe(1);

      db.deleteComment(comment!.id);
      ({ results } = db.search('dark mode'));
      expect(results.length).toBe(0);
    });
  });

  describe('rebuildFtsIndex', () => {
    it('should rebuild the entire index', () => {
      db.create({ title: 'Rebuild test alpha' });
      db.create({ title: 'Rebuild test beta' });
      db.create({ title: 'Rebuild test gamma' });

      const { indexed } = db.rebuildFtsIndex();
      expect(indexed).toBe(3);

      const { results } = db.search('rebuild test');
      expect(results.length).toBe(3);
    });

    it('should include comments after rebuild', () => {
      const item = db.create({ title: 'Comment rebuild test' });
      db.createComment({
        workItemId: item.id,
        author: 'agent',
        comment: 'Unique searchable token xylophone',
      });

      db.rebuildFtsIndex();

      const { results } = db.search('xylophone');
      expect(results.length).toBe(1);
      expect(results[0].itemId).toBe(item.id);
    });
  });

  describe('ranking', () => {
    it('should rank title matches higher than description matches', () => {
      db.create({
        title: 'Authentication module',
        description: 'Handles user login and session management',
      });
      db.create({
        title: 'Session management refactor',
        description: 'Improve the authentication flow for better security',
      });

      const { results } = db.search('authentication');
      expect(results.length).toBe(2);
      // The item with "authentication" in the title should rank first
      // since title has weight 10 vs description weight 5
      expect(results[0].matchedColumn).toBe('title');
    });
  });

  describe('WorklogDatabase.search() method', () => {
    it('should return ftsUsed=true when FTS5 is available', () => {
      db.create({ title: 'Test search method' });
      const result = db.search('search method');
      expect(result.ftsUsed).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    });
  });
});
