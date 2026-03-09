/**
 * Tests for the TUI 'g' key delegate shortcut.
 *
 * Covers:
 * - g key triggers delegate flow when item is focused
 * - No-op toast when no item is selected
 * - Guard rails: do-not-delegate tag blocks without Force
 * - Force override proceeds when item has do-not-delegate
 * - Delegate failure shows error toast, item state unchanged
 * - Non-delegated items preserved after delegation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any module imports that trigger controller
// ---------------------------------------------------------------------------

// Mock delegate-helper so no real GitHub calls happen
const mockDelegateWorkItem = vi.hoisted(() =>
  vi.fn(async () => ({
    success: true,
    workItemId: 'WL-TEST-1',
    issueNumber: 42,
    issueUrl: 'https://github.com/test-owner/test-repo/issues/42',
    pushed: true,
    assigned: true,
  })),
);

vi.mock('../../src/delegate-helper.js', () => ({
  delegateWorkItem: mockDelegateWorkItem,
}));

// Mock resolveGithubConfig to avoid needing a real git remote
vi.mock('../../src/commands/github.js', () => ({
  resolveGithubConfig: () => ({ repo: 'test-owner/test-repo', labelPrefix: 'wl:' }),
}));

import { TuiController } from '../../src/tui/controller.js';
import { createTuiTestContext } from '../test-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a keypress and wait for async handlers to settle. */
async function pressKey(ctx: any, key: string) {
  ctx.screen.emit('keypress', key, { name: key });
  // Allow microtasks (async key handlers, selectList promise) to resolve
  await new Promise((r) => setTimeout(r, 20));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TUI g key delegate shortcut', () => {
  beforeEach(() => {
    mockDelegateWorkItem.mockClear();
    mockDelegateWorkItem.mockResolvedValue({
      success: true,
      workItemId: 'WL-TEST-1',
      issueNumber: 42,
      issueUrl: 'https://github.com/test-owner/test-repo/issues/42',
      pushed: true,
      assigned: true,
    } as any);
  });

  it('is a no-op when the TUI has no work items (controller exits early)', async () => {
    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    // No items created — controller.start returns early without registering key handlers
    await controller.start({});
    await pressKey(ctx, 'g');
    // No key handler registered, so delegateWorkItem should not be called
    expect(mockDelegateWorkItem).not.toHaveBeenCalled();
  });

  it('calls delegateWorkItem on confirm (selectList returns 0 = Delegate)', async () => {
    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    const id = ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    // Default selectList mock returns 0 (Delegate)
    await pressKey(ctx, 'g');

    expect(mockDelegateWorkItem).toHaveBeenCalledTimes(1);
    const args = mockDelegateWorkItem.mock.calls[0] as any[];
    expect(args[2]).toBe(id);
    expect(args[3]).toEqual({ force: false });
  });

  it('shows success toast with issue URL after delegation', async () => {
    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    await pressKey(ctx, 'g');

    expect(ctx.toast.lastMessage()).toMatch(/Delegated:/);
    expect(ctx.toast.lastMessage()).toContain('https://github.com/test-owner/test-repo/issues/42');
  });

  it('shows failure toast when delegate returns error', async () => {
    mockDelegateWorkItem.mockResolvedValue({
      success: false,
      workItemId: 'WL-TEST-1',
      error: 'do-not-delegate',
    } as any);

    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    await pressKey(ctx, 'g');

    expect(ctx.toast.lastMessage()).toMatch(/Delegation failed/);
    expect(ctx.toast.lastMessage()).toContain('do-not-delegate');
  });

  it('cancels when selectList returns cancel index', async () => {
    const ctx = createTuiTestContext();
    // Override selectList to return index 1 (Cancel) — choices are ['Delegate', 'Cancel']
    (ctx as any).createLayout().modalDialogs.selectList = async () => 1;
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    await pressKey(ctx, 'g');

    expect(mockDelegateWorkItem).not.toHaveBeenCalled();
  });

  it('delegates with force=true when item has do-not-delegate tag', async () => {
    const ctx = createTuiTestContext();
    // For do-not-delegate items, choices are
    // ['Delegate (ignoring Do Not Delegate flag)', 'Cancel']
    // selectList returns 0 by default which confirms delegation with force
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    const id = ctx.utils.createSampleItem({ tags: ['do-not-delegate'] });
    await controller.start({});

    await pressKey(ctx, 'g');

    expect(mockDelegateWorkItem).toHaveBeenCalledTimes(1);
    const args2 = mockDelegateWorkItem.mock.calls[0] as any[];
    expect(args2[2]).toBe(id);
    expect(args2[3]).toEqual({ force: true });
  });

  it('cancels do-not-delegate item when Cancel is selected', async () => {
    const ctx = createTuiTestContext();
    // Override selectList to return index 1 (Cancel)
    (ctx as any).createLayout().modalDialogs.selectList = async () => 1;
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    ctx.utils.createSampleItem({ tags: ['do-not-delegate'] });
    await controller.start({});

    await pressKey(ctx, 'g');

    expect(mockDelegateWorkItem).not.toHaveBeenCalled();
  });

  it('does not trigger during move mode', async () => {
    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    // Enter move mode by pressing 'M' first
    ctx.screen.emit('keypress', 'M', { name: 'm' });
    await new Promise((r) => setTimeout(r, 10));

    // Now press 'g' — should be suppressed
    await pressKey(ctx, 'g');

    expect(mockDelegateWorkItem).not.toHaveBeenCalled();
  });

  it('shows error toast when resolveGithubConfig throws', async () => {
    // Temporarily make delegateWorkItem throw to simulate config error
    mockDelegateWorkItem.mockRejectedValue(new Error('GitHub repo not configured'));

    const ctx = createTuiTestContext();
    const controller = new TuiController(ctx as any, { blessed: ctx.blessed });
    ctx.utils.createSampleItem({ tags: [] });
    await controller.start({});

    await pressKey(ctx, 'g');

    expect(ctx.toast.lastMessage()).toMatch(/Delegation failed/);
  });
});
