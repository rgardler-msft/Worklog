/**
 * Tests for FTS5 full-text search
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorklogDatabase } from '../src/database.js';
import * as searchMetrics from '../src/search-metrics.js';
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

  // moved to tests/search-fallback.test.ts

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

  describe('ID-aware search', () => {
    it('should return exact ID match as top result when searching by full prefixed ID', () => {
      const item = db.create({ title: 'Target item for ID search' });
      db.create({ title: 'Another item mentioning nothing related' });
      const { results } = db.search(item.id);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe(item.id);
      expect(results[0].matchedColumn).toBe('id');
      expect(results[0].rank).toBe(-Infinity);
    });

    it('should return exact ID match when searching by lowercase prefixed ID', () => {
      const item = db.create({ title: 'Case insensitive ID lookup' });
      const { results } = db.search(item.id.toLowerCase());
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe(item.id);
      expect(results[0].matchedColumn).toBe('id');
    });

    it('should resolve bare (unprefixed) ID using configured prefix', () => {
      const item = db.create({ title: 'Prefix resolution test' });
      // Strip the "TEST-" prefix to get bare ID
      const bareId = item.id.replace(/^TEST-/, '');
      const { results } = db.search(bareId);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe(item.id);
      expect(results[0].matchedColumn).toBe('id');
      expect(results[0].rank).toBe(-Infinity);
    });

    it('should find partial ID substring matches (>= 8 chars)', () => {
      const item = db.create({ title: 'Partial ID match test' });
      // Take 8+ chars from the middle of the ID (after prefix)
      const bareId = item.id.replace(/^TEST-/, '');
      const partialId = bareId.substring(0, 8);
      const { results } = db.search(partialId);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const found = results.find(r => r.itemId === item.id);
      expect(found).toBeDefined();
      expect(found!.matchedColumn).toBe('id');
      // Partial matches get rank -1000 (not -Infinity)
      expect(found!.rank).toBe(-1000);
    });

    it('should not match partial IDs shorter than 8 chars', () => {
      const item = db.create({ title: 'Short partial ID test' });
      const bareId = item.id.replace(/^TEST-/, '');
      const shortPartial = bareId.substring(0, 5);
      const { results } = db.search(shortPartial);
      // Should not find via ID matching (might find via FTS if text happens to match)
      const idMatch = results.find(r => r.matchedColumn === 'id');
      expect(idMatch).toBeUndefined();
    });

    it('should find partial ID with prefix included (e.g. TEST-0MLZVROU)', () => {
      const item = db.create({ title: 'Prefixed partial ID test' });
      // Take prefix + first 8 chars of the unique part (e.g. "TEST-0MM0BLTA")
      const bareId = item.id.replace(/^TEST-/, '');
      const prefixedPartial = `TEST-${bareId.substring(0, 8)}`;
      const { results } = db.search(prefixedPartial);
      expect(results.length).toBeGreaterThanOrEqual(1);
      const found = results.find(r => r.itemId === item.id);
      expect(found).toBeDefined();
      expect(found!.matchedColumn).toBe('id');
    });

    it('should rank exact ID match above FTS text matches', () => {
      const target = db.create({ title: 'Bug fix for authentication' });
      db.create({
        title: 'Authentication improvement',
        description: `Related to ${target.id}`,
      });
      // Search by exact ID — target should be first
      const { results } = db.search(target.id);
      expect(results[0].itemId).toBe(target.id);
      expect(results[0].matchedColumn).toBe('id');
    });

    it('should deduplicate ID matches with FTS results', () => {
      const item = db.create({
        title: 'Unique dedup test keyword',
        description: 'Testing deduplication of ID and FTS results',
      });
      // Search with a multi-token query: the ID + a text term
      const { results } = db.search(`${item.id} dedup`);
      // The item should appear only once
      const occurrences = results.filter(r => r.itemId === item.id);
      expect(occurrences.length).toBe(1);
      // And it should be the ID match (first)
      expect(occurrences[0].matchedColumn).toBe('id');
    });

    it('should handle multi-token queries with ID and text terms', () => {
      const target = db.create({ title: 'Multi-token target item' });
      db.create({ title: 'Keyword findable item' });
      // Search with ID + text keyword
      const { results } = db.search(`${target.id} keyword`);
      // ID match should be first
      expect(results[0].itemId).toBe(target.id);
      expect(results[0].matchedColumn).toBe('id');
      // FTS may or may not find additional results depending on how it handles
      // the mixed ID+text query — the key guarantee is that the ID match is first
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('should return no results for a non-existent ID', () => {
      db.create({ title: 'Some item' });
      const { results } = db.search('TEST-ZZZZZZZZZZZZZZZZZ');
      // No ID match, no FTS match
      const idMatches = results.filter(r => r.matchedColumn === 'id');
      expect(idMatches.length).toBe(0);
    });

    it('should preserve existing filter options with ID search', () => {
      const openItem = db.create({ title: 'Open item for filter test' });
      db.update(openItem.id, { status: 'in-progress' });
      // Search by ID with status filter — should still return the item
      const { results: inProgress } = db.search(openItem.id, { status: 'in-progress' });
      expect(inProgress.length).toBeGreaterThanOrEqual(1);
      expect(inProgress[0].itemId).toBe(openItem.id);
    });

    it('should handle searching by ID with extra whitespace', () => {
      const item = db.create({ title: 'Whitespace handling test' });
      const { results } = db.search(`  ${item.id}  `);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].itemId).toBe(item.id);
    });
  });

  describe('search metrics counters', () => {
    beforeEach(() => {
      searchMetrics.reset();
    });

    it('should increment search.total on every search call', () => {
      db.create({ title: 'Metrics total test' });
      const before = searchMetrics.snapshot();
      db.search('metrics');
      db.search('total');
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.total']).toBe(2);
    });

    it('should increment search.exact_id when a full prefixed ID matches', () => {
      const item = db.create({ title: 'Exact ID metrics test' });
      const before = searchMetrics.snapshot();
      db.search(item.id);
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.exact_id']).toBe(1);
      expect(delta['search.total']).toBe(1);
    });

    it('should increment search.prefix_resolved when a bare ID is resolved via prefix', () => {
      const item = db.create({ title: 'Prefix resolve metrics test' });
      const bareId = item.id.replace(/^TEST-/, '');
      const before = searchMetrics.snapshot();
      db.search(bareId);
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.prefix_resolved']).toBe(1);
      expect(delta['search.total']).toBe(1);
    });

    it('should increment search.partial_id on partial-ID substring match', () => {
      const item = db.create({ title: 'Partial ID metrics test' });
      const bareId = item.id.replace(/^TEST-/, '');
      const partial = bareId.substring(0, 8);
      const before = searchMetrics.snapshot();
      db.search(partial);
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.partial_id']).toBeGreaterThanOrEqual(1);
      expect(delta['search.total']).toBe(1);
    });

    it('should increment search.fts when FTS path is used', () => {
      db.create({ title: 'FTS metrics test keyword' });
      const before = searchMetrics.snapshot();
      db.search('keyword');
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.fts']).toBe(1);
      expect(delta['search.total']).toBe(1);
    });

    it('should increment both search.exact_id and search.fts for an exact ID search', () => {
      const item = db.create({ title: 'Combined metrics test' });
      const before = searchMetrics.snapshot();
      db.search(item.id);
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      // Exact ID match fires, then FTS also runs on the query
      expect(delta['search.exact_id']).toBe(1);
      expect(delta['search.fts']).toBe(1);
      expect(delta['search.total']).toBe(1);
    });

    it('should not increment search.exact_id for a text-only query', () => {
      db.create({ title: 'Text only metrics test' });
      const before = searchMetrics.snapshot();
      db.search('text only');
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.exact_id'] || 0).toBe(0);
      expect(delta['search.prefix_resolved'] || 0).toBe(0);
      expect(delta['search.partial_id'] || 0).toBe(0);
      expect(delta['search.fts']).toBe(1);
    });

    it('should not increment search.partial_id when partial token is too short', () => {
      const item = db.create({ title: 'Short partial metrics test' });
      const bareId = item.id.replace(/^TEST-/, '');
      const shortPartial = bareId.substring(0, 5);
      const before = searchMetrics.snapshot();
      db.search(shortPartial);
      const after = searchMetrics.snapshot();
      const delta = searchMetrics.diff(before, after);
      expect(delta['search.partial_id'] || 0).toBe(0);
    });
  });
});

describe('search-metrics module', () => {
  beforeEach(() => {
    searchMetrics.reset();
  });

  it('increment() should create and increment a counter', () => {
    searchMetrics.increment('test.counter');
    expect(searchMetrics.snapshot()['test.counter']).toBe(1);
    searchMetrics.increment('test.counter');
    expect(searchMetrics.snapshot()['test.counter']).toBe(2);
  });

  it('increment() should accept a custom step', () => {
    searchMetrics.increment('test.step', 5);
    expect(searchMetrics.snapshot()['test.step']).toBe(5);
  });

  it('snapshot() should return a copy that is not affected by later increments', () => {
    searchMetrics.increment('test.snap', 3);
    const snap = searchMetrics.snapshot();
    searchMetrics.increment('test.snap', 7);
    expect(snap['test.snap']).toBe(3);
    expect(searchMetrics.snapshot()['test.snap']).toBe(10);
  });

  it('reset() should clear all counters', () => {
    searchMetrics.increment('test.a');
    searchMetrics.increment('test.b', 2);
    searchMetrics.reset();
    const snap = searchMetrics.snapshot();
    expect(Object.keys(snap).length).toBe(0);
  });

  it('diff() should compute the delta between two snapshots', () => {
    searchMetrics.increment('search.total', 3);
    searchMetrics.increment('search.fts', 2);
    const before = searchMetrics.snapshot();
    searchMetrics.increment('search.total', 5);
    searchMetrics.increment('search.exact_id', 1);
    const after = searchMetrics.snapshot();
    const delta = searchMetrics.diff(before, after);
    expect(delta['search.total']).toBe(5);
    expect(delta['search.fts']).toBe(0);
    expect(delta['search.exact_id']).toBe(1);
  });

  it('diff() should handle keys present only in before snapshot', () => {
    searchMetrics.increment('search.removed', 3);
    const before = searchMetrics.snapshot();
    searchMetrics.reset();
    const after = searchMetrics.snapshot();
    const delta = searchMetrics.diff(before, after);
    expect(delta['search.removed']).toBe(-3);
  });
});
