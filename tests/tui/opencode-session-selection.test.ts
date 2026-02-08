import { describe, it, expect, vi } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

type RouteHandler = (opts: any) => { statusCode?: number; body?: string };

const makeResponse = (statusCode: number, body?: string) => {
  const listeners: Record<string, Function[]> = {};
  return {
    statusCode,
    resume: () => {},
    on: (event: string, cb: Function) => {
      (listeners[event] = listeners[event] || []).push(cb);
    },
    emit: (event: string, data?: any) => {
      const fns = listeners[event] || [];
      for (const fn of fns) fn(data);
    },
    flush: () => {
      if (body !== undefined) {
        for (const fn of listeners.data || []) fn(body);
      }
      for (const fn of listeners.end || []) fn();
    },
  } as any;
};

const makeHttpMock = (routes: Record<string, RouteHandler>) => ({
  request: (opts: any, cb: Function) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = opts.path || '';
    const key = `${method} ${path}`;
    const idKey = path.startsWith('/session/') && path !== '/session' ? `${method} /session/:id` : '';
    const handler = routes[key] || (idKey ? routes[idKey] : undefined);
    const { statusCode = 200, body } = handler ? handler(opts) : { statusCode: 200, body: '' };
    const res = makeResponse(statusCode, body);
    cb(res);
    setTimeout(() => res.flush(), 0);
    return {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      abort: vi.fn(),
      removeAllListeners: vi.fn(),
    } as any;
  },
});

const makeClient = (httpImpl: any, persistedState: any) => {
  return new OpencodeClient({
    port: 1234,
    log: () => {},
    showToast: () => {},
    modalDialogs: { selectList: async () => null, editTextarea: async () => null, confirmTextbox: async () => true },
    render: () => {},
    persistedState,
    httpImpl,
    spawnImpl: () => { throw new Error('not used'); },
  } as any);
};

describe('OpencodeClient session selection', () => {
  it('prefers the current session when ids match', async () => {
    const httpImpl = makeHttpMock({});
    const persistedState = { load: async () => ({}), save: vi.fn().mockResolvedValue(undefined), getPrefix: () => undefined };
    const client = makeClient(httpImpl as any, persistedState);

    (client as any).currentSessionId = 'WL-123';
    const result = await (client as any).resolveSessionSelection('WL-123');

    expect(result).toEqual({ id: 'WL-123', workItemId: 'WL-123', existing: true });
  });

  it('uses persisted mapping when the session exists', async () => {
    const httpImpl = makeHttpMock({
      'GET /session/:id': () => ({ statusCode: 200, body: '' }),
    });
    const persistedState = {
      load: async () => ({ sessionMap: { 'WL-1': 'sess-1' } }),
      save: vi.fn().mockResolvedValue(undefined),
      getPrefix: () => undefined,
    };
    const client = makeClient(httpImpl as any, persistedState);

    const result = await (client as any).createSession('WL-1');
    expect(result).toEqual({ id: 'sess-1', workItemId: 'WL-1', existing: true });
  });

  it('falls back to title lookup when persisted session is missing', async () => {
    const httpImpl = makeHttpMock({
      'GET /session/:id': () => ({ statusCode: 404, body: '' }),
      'GET /session': () => ({
        statusCode: 200,
        body: JSON.stringify([{ id: 'sess-2', title: 'workitem:WL-1 TUI Session' }]),
      }),
    });
    const persistedState = {
      load: async () => ({ sessionMap: { 'WL-1': 'stale' } }),
      save: vi.fn().mockResolvedValue(undefined),
      getPrefix: () => undefined,
    };
    const client = makeClient(httpImpl as any, persistedState);

    const result = await (client as any).createSession('WL-1');
    expect(result).toEqual({ id: 'sess-2', workItemId: 'WL-1', existing: true });
    expect(persistedState.save).toHaveBeenCalled();
  });

  it('creates a new session when no matches are found', async () => {
    const httpImpl = makeHttpMock({
      'GET /session': () => ({ statusCode: 200, body: JSON.stringify([]) }),
      'POST /session': () => ({
        statusCode: 200,
        body: JSON.stringify({ id: 'sess-3', title: 'workitem:WL-1 TUI Session' }),
      }),
    });
    const persistedState = { load: async () => ({}), save: vi.fn().mockResolvedValue(undefined), getPrefix: () => undefined };
    const client = makeClient(httpImpl as any, persistedState);

    const result = await (client as any).createSession('WL-1');
    expect(result.id).toBe('sess-3');
    expect(result.workItemId).toBe('WL-1');
    expect(persistedState.save).toHaveBeenCalled();
  });
});
