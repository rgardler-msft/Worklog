import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { displayItemTree, displayItemTreeWithFormat } from '../../src/commands/helpers.js';
import type { WorkItem, WorkItemPriority, WorkItemStatus } from '../../src/types.js';
import { WorklogDatabase } from '../../src/database.js';
import { createTempDbPath, createTempDir, createTempJsonlPath, cleanupTempDir } from '../test-utils.js';

type WorkItemOverrides = Partial<WorkItem> & { id: string; title: string };

const baseWorkItem = (overrides: WorkItemOverrides): WorkItem => {
  const now = '2024-01-01T00:00:00.000Z';
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? '',
    status: (overrides.status ?? 'open') as WorkItemStatus,
    priority: (overrides.priority ?? 'medium') as WorkItemPriority,
    sortIndex: overrides.sortIndex ?? 0,
    parentId: overrides.parentId ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    tags: overrides.tags ?? [],
    assignee: overrides.assignee ?? '',
    stage: overrides.stage ?? '',
    issueType: overrides.issueType ?? 'task',
    createdBy: overrides.createdBy ?? '',
    deletedBy: overrides.deletedBy ?? '',
    deleteReason: overrides.deleteReason ?? '',
    risk: overrides.risk ?? '',
    effort: overrides.effort ?? ''
  };
};

const captureConsole = () => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(arg => String(arg)).join(' '));
  });
  return { lines, spy };
};

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

describe('tree rendering helpers', () => {
  let tempDir: string;
  let dbPath: string;
  let jsonlPath: string;
  let db: WorklogDatabase;

  beforeEach(() => {
    tempDir = createTempDir();
    dbPath = createTempDbPath(tempDir);
    jsonlPath = createTempJsonlPath(tempDir);
    db = new WorklogDatabase('TEST', dbPath, jsonlPath, false, true);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('orders roots and children for displayItemTree', () => {
    const items = [
      baseWorkItem({ id: 'TEST-ROOT-2', title: 'Root 2', priority: 'low', createdAt: '2024-01-02T00:00:00.000Z' }),
      baseWorkItem({ id: 'TEST-ROOT-1', title: 'Root 1', priority: 'high', createdAt: '2024-01-01T00:00:00.000Z' }),
      baseWorkItem({ id: 'TEST-CHILD-B', title: 'Child B', parentId: 'TEST-ROOT-1', priority: 'low', createdAt: '2024-01-03T00:00:00.000Z' }),
      baseWorkItem({ id: 'TEST-CHILD-A', title: 'Child A', parentId: 'TEST-ROOT-1', priority: 'low', createdAt: '2024-01-02T00:00:00.000Z' })
    ];

    const { lines, spy } = captureConsole();
    displayItemTree(items);
    spy.mockRestore();

    const normalized = lines.map(stripAnsi);
    const root1Index = normalized.findIndex(line => line.includes('Root 1'));
    const root2Index = normalized.findIndex(line => line.includes('Root 2'));
    const childAIndex = normalized.findIndex(line => line.includes('Child A'));
    const childBIndex = normalized.findIndex(line => line.includes('Child B'));

    expect(root1Index).toBeGreaterThanOrEqual(0);
    expect(root2Index).toBeGreaterThanOrEqual(0);
    expect(root1Index).toBeLessThan(root2Index);
    expect(childAIndex).toBeGreaterThanOrEqual(0);
    expect(childBIndex).toBeGreaterThanOrEqual(0);
    expect(childAIndex).toBeLessThan(childBIndex);
  });

  it('renders tree output using sortIndex ordering when db is provided', () => {
    const parent = db.create({ title: 'Parent' });
    const childA = db.create({ title: 'Child A', parentId: parent.id, sortIndex: 200 });
    const childB = db.create({ title: 'Child B', parentId: parent.id, sortIndex: 100 });

    const items = [parent, childA, childB];

    const { lines, spy } = captureConsole();
    displayItemTreeWithFormat(items, db, 'concise');
    spy.mockRestore();

    const normalized = lines.map(stripAnsi);
    const parentIndex = normalized.findIndex(line => line.includes('Parent'));
    const childAIndex = normalized.findIndex(line => line.includes('Child A'));
    const childBIndex = normalized.findIndex(line => line.includes('Child B'));

    expect(parentIndex).toBeGreaterThanOrEqual(0);
    expect(childAIndex).toBeGreaterThanOrEqual(0);
    expect(childBIndex).toBeGreaterThanOrEqual(0);
    expect(childBIndex).toBeLessThan(childAIndex);
  });
});
