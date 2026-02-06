import { describe, it, expect } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

describe('OpencodeClient SSE cleanup', () => {
  it('stops handling payloads after [DONE] and ignores subsequent chunks', async () => {
    const emitted: string[] = [];

    const pane = {
      setContent: (c: string) => emitted.push(String(c)),
      getContent: () => emitted.join('\n'),
      setScrollPerc: (_: number) => {},
      focus: () => {},
    } as any;

    // Mock httpImpl.request to simulate an SSE response stream
    const listeners: Record<string, Function[]> = {};
    const res = {
      on: (ev: string, cb: Function) => {
        (listeners[ev] = listeners[ev] || []).push(cb);
      },
      emit: (ev: string, data?: any) => {
        const l = listeners[ev] || [];
        for (const fn of l) fn(data);
      },
    } as any;

    const req = {
      on: (_ev: string, _cb: Function) => {},
      end: () => {},
      abort: () => {},
      removeAllListeners: () => {},
    } as any;

    const httpImpl = {
      request: (_opts: any, cb: Function) => {
        // invoke callback with our mock response
        setTimeout(() => cb(res), 0);
        return req;
      },
    } as any;

    const client = new OpencodeClient({
      port: 1234,
      log: () => {},
      showToast: () => {},
      modalDialogs: {
        selectList: async () => null,
        editTextarea: async () => null,
        confirmTextbox: async () => true,
      },
      render: () => {},
      persistedState: { load: () => ({}), save: () => {}, getPrefix: () => undefined },
      httpImpl: httpImpl,
      spawnImpl: (name: string) => { throw new Error('not used'); },
    } as any);

    // Call the private connectToSSE via any-cast. It takes resolve/reject callbacks.
    const p = new Promise<void>((resolve, reject) => {
      (client as any).connectToSSE('sess1', 'prompt', pane, null, null, resolve, reject, () => {});

      // Emit a normal message chunk, then a [DONE], then an extra chunk after DONE
      setTimeout(() => {
        res.emit('data', Buffer.from('data: {"type":"message.part","properties":{"sessionID":"sess1","part":{"id":"p1","messageID":"m1","type":"text","text":"hello"}}}\n\n'));
      }, 10);

      setTimeout(() => {
        res.emit('data', Buffer.from('data: [DONE]\n\n'));
      }, 20);

      // emit more data after DONE which should be ignored
      setTimeout(() => {
        res.emit('data', Buffer.from('data: {"type":"message.part","properties":{"sessionID":"sess1","part":{"id":"p2","messageID":"m2","type":"text","text":"ignored"}}}\n\n'));
      }, 30);
    });

    await p;

    // Allow any late microtasks to run
    await new Promise(r => setTimeout(r, 20));

    // The pane should contain the first message but not the ignored one
    const content = emitted.join('\n');
    expect(content).toContain('hello');
    expect(content).not.toContain('ignored');
  });
});
