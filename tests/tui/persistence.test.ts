import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPersistence } from '../../src/tui/persistence.js';
import * as path from 'path';

describe('tui persistence', () => {
  const worklogDir = path.join('/tmp', 'worklog-test');
  let fsMock: any;

  beforeEach(() => {
    fsMock = {
      access: vi.fn().mockRejectedValue(new Error('missing')),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    };
  });

  it('returns null when file missing', async () => {
    const p = createPersistence(worklogDir, { fs: fsMock });
    const v = await p.loadPersistedState('prefix');
    expect(v).toBeNull();
  });

  it('loads JSON when present', async () => {
    fsMock.access = vi.fn().mockResolvedValue(undefined);
    fsMock.readFile = vi.fn().mockResolvedValue('{"default": {"expanded": ["a"]}}');
    const p = createPersistence(worklogDir, { fs: fsMock });
    const v = await p.loadPersistedState(undefined);
    expect(v).toEqual({ expanded: ['a'] });
  });

  it('saves state and creates dir when needed', async () => {
    fsMock.access = vi.fn().mockRejectedValue(new Error('missing'));
    const p = createPersistence(worklogDir, { fs: fsMock });
    await p.savePersistedState('prefix', { expanded: ['x'] });
    expect(fsMock.mkdir).toHaveBeenCalled();
    expect(fsMock.writeFile).toHaveBeenCalled();
  });

  it('handles corrupt json gracefully', async () => {
    fsMock.access = vi.fn().mockResolvedValue(undefined);
    fsMock.readFile = vi.fn().mockResolvedValue('not-json');
    const p = createPersistence(worklogDir, { fs: fsMock });
    const v = await p.loadPersistedState(undefined);
    expect(v).toBeNull();
  });
});
