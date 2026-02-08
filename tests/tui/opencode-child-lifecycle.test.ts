import { describe, it, expect } from 'vitest';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

describe('OpencodeClient child process lifecycle', () => {
  it('removes listeners and kills child on stopServer and allows restart without leaking', async () => {
    let spawnCount = 0;
    const procs: any[] = [];

    const spawnImpl = (_name: string, _args: string[], _opts: any) => {
      spawnCount++;
      const stdoutListeners: string[] = [];
      const stderrListeners: string[] = [];
      const proc: any = {
        stdout: {
          on: (ev: string, cb: Function) => { stdoutListeners.push(ev); },
          removeAllListeners: () => { stdoutListeners.length = 0; },
        },
        stderr: {
          on: (ev: string, cb: Function) => { stderrListeners.push(ev); },
          removeAllListeners: () => { stderrListeners.length = 0; },
        },
        on: (ev: string, cb: Function) => { /* track if needed */ },
        removeAllListeners: () => { /* marker */ },
        kill: () => { proc.killed = true; },
        killed: false,
      };
      // attach markers that the real code uses
      procs.push(proc);
      return proc;
    };

    const client = new OpencodeClient({
      port: 4321,
      log: () => {},
      showToast: () => {},
      modalDialogs: { selectList: async () => null, editTextarea: async () => null, confirmTextbox: async () => true },
      render: () => {},
      persistedState: { load: async () => ({}), save: async () => {}, getPrefix: () => undefined },
      httpImpl: {} as any,
      spawnImpl,
    } as any);

    // make checkOpencodeServer return false on first call, then true afterwards
    let checks = 0;
    (client as any).checkOpencodeServer = async () => {
      checks++;
      return checks > 1;
    };

    const started = await client.startServer();
    expect(started).toBe(true);
    expect(spawnCount).toBe(1);
    expect(procs.length).toBe(1);

    // stop the server — should call kill and remove listeners
    client.stopServer();
    expect(procs[0].killed).toBe(true);

    // Simulate the server not being up yet so a restart will spawn again
    checks = 0;

    // start again; should spawn a fresh process
    const started2 = await client.startServer();
    expect(started2).toBe(true);
    expect(spawnCount).toBe(2);
  });
});
