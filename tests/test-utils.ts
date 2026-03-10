/**
 * Test utilities and helpers
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Create a temporary directory for test files
 */
export function createTempDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-test-'));
  return tmpDir;
}

/**
 * Clean up a temporary directory.
 * On Windows, SQLite may hold file locks briefly after the connection
 * object goes out of scope; retry a few times to handle EPERM.
 */
export function cleanupTempDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  const maxRetries = process.platform === 'win32' ? 5 : 0;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (attempt < maxRetries && (err.code === 'EPERM' || err.code === 'EBUSY')) {
        // brief spin-wait to let the OS release the file lock
        const delay = 200 * (attempt + 1);
        const until = Date.now() + delay;
        while (Date.now() < until) { /* wait */ }
        continue;
      }
      throw err;
    }
  }
}

/**
 * Create a temporary JSONL file path in a temp directory
 */
export function createTempJsonlPath(dir: string): string {
  return path.join(dir, 'test-data.jsonl');
}

/**
 * Create a temporary database path in a temp directory
 */
export function createTempDbPath(dir: string): string {
  return path.join(dir, 'test.db');
}

/**
 * Wait for a specified number of milliseconds
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a minimal TUI test context used by a few TUI-focused tests.
 * This provides a lightweight in-memory database, toast collector, and a
 * `createLayout` factory so tests can instantiate `TuiController` without
 * depending on the real terminal environment.
 */
export function createTuiTestContext() {
  let nextId = 1;
  const items = new Map<string, any>();

  const utils = {
    createSampleItem: ({ tags = [] } = {}) => {
      const id = `WL-TEST-${nextId++}`;
      const now = new Date().toISOString();
    const item = {
      id,
      title: 'Sample',
      description: '',
      status: 'open',
      priority: 'medium',
      sortIndex: 0,
      parentId: null,
      createdAt: now,
      updatedAt: now,
      tags,
      assignee: '',
      stage: '',
      issueType: 'task',
      createdBy: '',
      deletedBy: '',
      deleteReason: '',
      risk: '',
      effort: '',
      needsProducerReview: false,
    };
      items.set(id, item);
      return id;
    },
    db: {
      get: (id: string) => items.get(id),
      update: (id: string, updates: any) => {
        const cur = items.get(id);
        if (!cur) return false;
        const next = Object.assign({}, cur, updates);
        items.set(id, next);
        return next;
      },
    },
    requireInitialized: () => {},
    getDatabase: (prefix?: string) => ({
      list: (query?: any) => Array.from(items.values()),
      getPrefix: () => undefined,
      getCommentsForWorkItem: (id: string) => [],
      update: (id: string, updates: any) => {
        const cur = items.get(id);
        if (!cur) return false;
        const next = Object.assign({}, cur, updates);
        items.set(id, next);
        return next;
      },
      createComment: (_: any) => ({}),
      get: (id: string) => items.get(id),
    }),
  } as any;

  const toast = {
    _last: '',
    show: (m: string) => { toast._last = m; },
    lastMessage: () => toast._last,
  } as any;

  // Minimal box/screen factories used by the layout mocks
  const makeBox = () => {
    let _content = '';
    let _items: string[] = [];
    const obj: any = {
      hidden: true,
      width: 0,
      height: 0,
      selected: 0,
      childBase: 0,
    };
    obj.show = () => { obj.hidden = false; };
    obj.hide = () => { obj.hidden = true; };
    obj.focus = () => { screen.focused = obj; };
    obj.setFront = () => {};
    obj.setContent = (s: string) => { _content = s; };
    obj.getContent = () => _content;
    obj.setScroll = (_n: number) => {};
    obj.setScrollPerc = (_n: number) => {};
    obj.pushLine = (_s: string) => {};
    obj.setItems = (next: string[]) => { _items = next.slice(); };
    obj.select = (idx: number) => { obj.selected = idx; };
    obj.getItem = (idx: number) => { const v = _items[idx]; return v ? { getContent: () => v } : undefined; };
    obj.on = (_ev: string, _cb?: any) => {};
    obj.key = (_keys: any, _cb?: any) => {};
    obj.setLabel = (_s: string) => {};
    obj.clearValue = () => {};
    obj.setValue = (_v: string) => {};
    obj.destroy = () => {};
    obj.removeAllListeners = () => {};
    obj.removeListener = (_ev: string, _cb?: any) => {};
    return obj as any;
  };

  // Simple screen that allows registering keypress handlers and
  // exposing `emit('keypress', ch, key)` to simulate key events.
  const rawKeyHandlers: Array<(...args: any[]) => void> = [];
  const keyBindings: Array<{ keys: string[]; handler: (...args: any[]) => void }> = [];

  const screen: any = {
    height: 40,
    width: 100,
    focused: null,
    render: () => {},
    destroy: () => {},
    // raw keypress listeners
    on: (ev: string, cb: (...args: any[]) => void) => { if (ev === 'keypress') rawKeyHandlers.push(cb); },
    // register a key binding (blessed semantics expect this)
    key: (keys: any, cb: (...args: any[]) => void) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const normalized = list.map((k: any) => String(k).toLowerCase());
      keyBindings.push({ keys: normalized, handler: cb });
    },
    // emit a raw keypress: invoke raw handlers and matching key bindings
    emit: (ev: string, ch: any, key: any) => {
      if (ev !== 'keypress') return;
      // call raw listeners
      rawKeyHandlers.forEach(h => { try { h(ch, key); } catch (_) {} });
      // call bindings that match the key name (case-insensitive)
      const name = (key && key.name) ? String(key.name).toLowerCase() : String(key || '').toLowerCase();
      keyBindings.forEach(({ keys, handler }) => {
        try {
          if (keys.includes(name)) handler(ch, key);
        } catch (_) {}
      });
    },
  };

  // Minimal blessed-compatible factory used by createLayout
  const blessedImpl: any = {
    screen: (_opts?: any) => screen,
    box: (_opts?: any) => makeBox(),
    list: (_opts?: any) => makeBox(),
    textarea: (_opts?: any) => makeBox(),
    button: (_opts?: any) => makeBox(),
    text: (_opts?: any) => makeBox(),
  };

  const layout = {
    screen,
    // Use consistent instances so focus/selected are shared
    listComponent: { getList: (() => { const b = makeBox(); return () => b; })(), getFooter: (() => { const b = makeBox(); return () => b; })() },
    detailComponent: { getDetail: (() => { const b = makeBox(); return () => b; })(), getCopyIdButton: (() => { const b = makeBox(); return () => b; })() },
    toastComponent: { show: (m: string) => toast.show(m) },
    overlaysComponent: { detailOverlay: makeBox(), closeOverlay: makeBox(), updateOverlay: makeBox() },
    dialogsComponent: {
      detailModal: makeBox(), detailClose: makeBox(), closeDialog: makeBox(), closeDialogText: makeBox(), closeDialogOptions: makeBox(),
      updateDialog: makeBox(), updateDialogText: makeBox(), updateDialogOptions: makeBox(), updateDialogStageOptions: makeBox(), updateDialogStatusOptions: makeBox(), updateDialogPriorityOptions: makeBox(), updateDialogComment: makeBox(),
    },
    helpMenu: { isVisible: () => false, show: () => {}, hide: () => {} },
    modalDialogs: { selectList: async () => 0, editTextarea: async () => null, confirmTextbox: async () => false, forceCleanup: () => {}, messageBox: () => ({ update: () => {}, close: () => {} }) },
    opencodeUi: { serverStatusBox: makeBox(), dialog: makeBox(), textarea: makeBox(), suggestionHint: makeBox(), sendButton: makeBox(), cancelButton: makeBox(), ensureResponsePane: () => makeBox() },
    nextDialog: { overlay: makeBox(), dialog: makeBox(), close: makeBox(), text: makeBox(), options: makeBox() },
  };

  const program = { opts: () => ({ verbose: false, format: undefined, json: false }) } as any;

  // Minimal command registry so CLI command modules can register commands
  // and tests can invoke them via `ctx.runCli([...])`.
  program._commands = new Map();
  program.command = (spec: string) => {
    const name = String(spec).split(' ')[0];
    const builder: any = {
      description: (_d: string) => builder,
      option: (_opt: string, _desc?: string) => builder,
      action: (fn: (...args: any[]) => any) => {
        program._commands.set(name, fn);
        return builder;
      }
    };
    return builder;
  };

  // Simple runner that invokes a registered command handler with a
  // parsed `options` object. Supports long-form flags like
  // `--do-not-delegate true` and converts kebab-case to camelCase to
  // match commander behaviour in the real code.
  function kebabToCamel(s: string) {
    return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  async function runCli(args: string[]): Promise<any> {
    const cmd = args[0];
    const id = args[1];
    let value: string | undefined;
    const rest: string[] = [];
    if (args.length > 2) {
      const maybeValue = args[2];
      if (maybeValue && !String(maybeValue).startsWith('-')) {
        value = maybeValue;
        rest.push(...args.slice(3));
      } else {
        rest.push(...args.slice(2));
      }
    }
    const handler = program._commands.get(cmd);
    if (!handler) throw new Error(`Command not registered: ${cmd}`);
    const options: Record<string, any> = {};
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (!token) continue;
      if (token.startsWith('--')) {
        const key = kebabToCamel(token.replace(/^--+/, ''));
        const next = rest[i + 1];
        if (next !== undefined && !String(next).startsWith('-')) {
          options[key] = next;
          i++;
        } else {
          options[key] = true;
        }
      } else if (token.startsWith('-')) {
        // ignore short flags for tests (not needed currently)
      }
    }

    if (value !== undefined) {
      return await Promise.resolve(handler(id, value, options));
    }
    return await Promise.resolve(handler(id, options));
  }

  // Expose a tiny CLI test context built on top of the TUI helpers so
  // tests that register commands can run them in-process.
  return {
    program,
    utils: Object.assign({}, utils, {
      // Commander-like helpers used by CLI commands under test
      normalizeCliId: (id: string, _prefix?: string) => id,
      getConfig: () => ({}),
      isJsonMode: () => false,
      db: {
        get: (id: string) => items.get(id),
      }
    }),
    toast,
    blessed: blessedImpl,
    screen,
    createLayout: () => layout,
    runCli,
  } as any;
}

// Back-compat alias for CLI command tests.
export const createTestContext = createTuiTestContext;
