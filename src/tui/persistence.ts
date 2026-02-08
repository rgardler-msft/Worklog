import * as fs from 'fs';
import * as path from 'path';

export type FsLike = Pick<typeof fs.promises, 'access' | 'readFile' | 'writeFile' | 'mkdir'>;

export function createPersistence(worklogDir: string, opts?: { fs?: FsLike; debugLog?: (msg: string) => void }) {
  const fsImpl: FsLike = opts?.fs ?? fs.promises;
  const debugLog = opts?.debugLog ?? (() => {});
  const statePath = path.join(worklogDir, 'tui-state.json');

  const fileExists = async (target: string) => {
    try {
      await fsImpl.access(target);
      return true;
    } catch (_) {
      return false;
    }
  };

  async function loadPersistedState(prefix?: string) {
    try {
      if (!(await fileExists(statePath))) return null;
      const raw = await fsImpl.readFile(statePath, 'utf8');
      const j = JSON.parse(raw || '{}');
      const val = j[prefix || 'default'] || null;
      debugLog(`loadPersistedState prefix=${String(prefix || 'default')} path=${statePath} present=${val !== null}`);
      return val;
    } catch (err) {
      debugLog(`loadPersistedState error: ${String(err)}`);
      return null;
    }
  }

  async function savePersistedState(prefix: string | undefined, state: any) {
    try {
      await fsImpl.mkdir(worklogDir, { recursive: true });
      let j: any = {};
      if (await fileExists(statePath)) {
        try { j = JSON.parse(await fsImpl.readFile(statePath, 'utf8') || '{}'); } catch { j = {}; }
      }
      j[prefix || 'default'] = state;
      await fsImpl.writeFile(statePath, JSON.stringify(j, null, 2), 'utf8');
      try {
        const keys = Object.keys(state || {}).join(',');
        debugLog(`savePersistedState prefix=${String(prefix || 'default')} path=${statePath} keys=[${keys}]`);
      } catch (_) {}
    } catch (err) {
      debugLog(`savePersistedState error: ${String(err)}`);
      // ignore persistence errors but log for debugging
    }
  }

  return { loadPersistedState, savePersistedState, statePath };
}
