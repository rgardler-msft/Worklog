import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the helper (helper dynamically imports
// child_process at runtime, but mocking here ensures we control exec)
const execMock = vi.fn();
vi.mock('child_process', () => ({ exec: execMock }));

import openUrlInBrowser from '../../src/utils/open-url.js';

describe('openUrlInBrowser', () => {
  const url = 'https://example.com/foo';
  const origPlatform = process.platform;

  beforeEach(() => {
    execMock.mockReset();
  });

  afterEach(() => {
    // restore platform
    try {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    } catch (_) {}
  });

  function setPlatform(value: string) {
    // process.platform is read-only, replace via defineProperty
    Object.defineProperty(process, 'platform', { value });
  }

  it('uses xdg-open on native linux and succeeds when exec returns ok', async () => {
    setPlatform('linux');
    // fsImpl that throws to simulate no /proc/version available (non-WSL)
    const fsImpl = { readFileSync: () => { throw new Error('no /proc/version'); } } as any;

    execMock.mockImplementation((cmd: string, cb: any) => { cb(null); return {}; });

    const ok = await openUrlInBrowser(url, fsImpl);
    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][0]).toContain('xdg-open');
    expect(execMock.mock.calls[0][0]).toContain(url);
  });

  it('on WSL prefers wslview then explorer then xdg-open and succeeds on wslview', async () => {
    setPlatform('linux');
    const fsImpl = { readFileSync: () => 'Linux version ... Microsoft ...' } as any;

    execMock.mockImplementation((cmd: string, cb: any) => { cb(null); return {}; });

    const ok = await openUrlInBrowser(url, fsImpl);
    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalled();
    expect(execMock.mock.calls[0][0]).toContain('wslview');
    expect(execMock.mock.calls[0][0]).toContain(url);
  });

  it('on WSL falls back to explorer if wslview fails', async () => {
    setPlatform('linux');
    const fsImpl = { readFileSync: () => 'Linux version ... Microsoft ...' } as any;

    // First call (wslview) fails, second (explorer.exe) succeeds
    execMock.mockImplementationOnce((cmd: string, cb: any) => { cb(new Error('not found')); return {}; })
      .mockImplementationOnce((cmd: string, cb: any) => { cb(null); return {}; });

    const ok = await openUrlInBrowser(url, fsImpl);
    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[1][0]).toContain('explorer.exe');
    expect(execMock.mock.calls[1][0]).toContain(url);
  });

  it('returns false if all candidates fail', async () => {
    setPlatform('linux');
    const fsImpl = { readFileSync: () => 'Linux version ... Microsoft ...' } as any;

    // Make all attempts fail
    execMock.mockImplementation((cmd: string, cb: any) => { cb(new Error('fail')); return {}; });

    const ok = await openUrlInBrowser(url, fsImpl);
    expect(ok).toBe(false);
    // Called for wslview, explorer.exe, and xdg-open (3 calls)
    expect(execMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
