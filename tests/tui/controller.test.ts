import { describe, it, expect, vi } from 'vitest';
import { TuiController } from '../../src/tui/controller.js';

const makeBox = () => ({
  hidden: true,
  width: 0,
  height: 0,
  style: { border: {}, label: {}, selected: {} },
  show: vi.fn(function() { (this as any).hidden = false; }),
  hide: vi.fn(function() { (this as any).hidden = true; }),
  focus: vi.fn(),
  setFront: vi.fn(),
  setContent: vi.fn(),
  getContent: vi.fn(() => ''),
  setLabel: vi.fn(),
  setItems: vi.fn(),
  select: vi.fn(),
  getItem: vi.fn(() => undefined),
  on: vi.fn(),
  key: vi.fn(),
  setScroll: vi.fn(),
  setScrollPerc: vi.fn(),
  getScroll: vi.fn(() => 0),
  pushLine: vi.fn(),
  clearValue: vi.fn(),
  setValue: vi.fn(),
  getValue: vi.fn(() => ''),
  moveCursor: vi.fn(),
});

const makeList = () => {
  const list = makeBox() as any;
  let selected = 0;
  let items: string[] = [];
  list.setItems = vi.fn((next: string[]) => {
    items = next.slice();
    list.items = items.map(value => ({ getContent: () => value }));
  });
  list.select = vi.fn((idx: number) => { selected = idx; });
  Object.defineProperty(list, 'selected', {
    get: () => selected,
    set: (value: number) => { selected = value; },
  });
  list.getItem = vi.fn((idx: number) => {
    const value = items[idx];
    return value ? { getContent: () => value } : undefined;
  });
  list.items = [] as any[];
  return list;
};

const makeScreen = () => {
  const screen: any = {
    height: 40,
    width: 120,
    focused: null,
    render: vi.fn(),
    destroy: vi.fn(),
    key: vi.fn(),
    on: vi.fn(),
  };
  return screen;
};

describe('TuiController', () => {
  it('starts with injected deps and layout', async () => {
    const screen = makeScreen();
    const list = makeList();
    const footer = makeBox();
    const detail = makeBox();
    const copyIdButton = makeBox();
    const toastBox = { show: vi.fn() } as any;

    const overlays = {
      detailOverlay: makeBox(),
      closeOverlay: makeBox(),
      updateOverlay: makeBox(),
    };
    const dialogs = {
      detailModal: makeBox(),
      detailClose: makeBox(),
      closeDialog: makeBox(),
      closeDialogText: makeBox(),
      closeDialogOptions: makeList(),
      updateDialog: makeBox(),
      updateDialogText: makeBox(),
      updateDialogOptions: makeList(),
      updateDialogStageOptions: makeList(),
      updateDialogStatusOptions: makeList(),
      updateDialogPriorityOptions: makeList(),
      updateDialogComment: makeBox(),
    };
    const helpMenu = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };
    const modalDialogs = {
      selectList: vi.fn(async () => 0),
      editTextarea: vi.fn(async () => null),
      confirmTextbox: vi.fn(async () => false),
      forceCleanup: vi.fn(),
    };
    const opencodeUi = {
      serverStatusBox: makeBox(),
      dialog: makeBox(),
      textarea: makeBox(),
      suggestionHint: makeBox(),
      sendButton: makeBox(),
      cancelButton: makeBox(),
      ensureResponsePane: vi.fn(() => makeBox()),
    };
    const layout = {
      screen,
      listComponent: { getList: () => list, getFooter: () => footer },
      detailComponent: { getDetail: () => detail, getCopyIdButton: () => copyIdButton },
      toastComponent: toastBox,
      overlaysComponent: overlays,
      dialogsComponent: dialogs,
      helpMenu,
      modalDialogs,
      opencodeUi,
      nextDialog: {
        overlay: makeBox(),
        dialog: makeBox(),
        close: makeBox(),
        text: makeBox(),
        options: makeList(),
      },
    };

    const createLayout = vi.fn(() => layout) as unknown as (options?: any) => any;
    const opencodeCtorCalls: any[] = [];
    class FakeOpencodeClient {
      constructor(options: any) {
        opencodeCtorCalls.push(options);
      }
      getStatus() { return { status: 'stopped', port: 9999 }; }
      startServer() { return Promise.resolve(true); }
      stopServer() { return undefined; }
      sendPrompt() { return Promise.resolve(); }
    }

    const program = { opts: () => ({ verbose: false }) } as any;
    const ctx = {
      program,
      utils: {
        requireInitialized: vi.fn(),
        getDatabase: vi.fn(() => ({
          list: () => [
            {
              id: 'WL-TEST-1',
              title: 'Test',
              description: '',
              status: 'open',
              priority: 'medium',
              sortIndex: 0,
              parentId: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              tags: [],
              assignee: '',
              stage: '',
              issueType: 'task',
              createdBy: '',
              deletedBy: '',
              deleteReason: '',
              risk: '',
              effort: '',
            },
          ],
          getPrefix: () => undefined,
          getCommentsForWorkItem: () => [],
          update: () => ({}),
          createComment: () => ({}),
          get: () => null,
        })),
      },
    } as any;

    const controller = new TuiController(ctx, {
      createLayout: createLayout as any,
      OpencodeClient: FakeOpencodeClient as any,
      resolveWorklogDir: () => '/tmp',
      createPersistence: () => ({
        loadPersistedState: async () => null,
        savePersistedState: async () => undefined,
        statePath: '/tmp/tui-state.json',
      }),
    });

    await controller.start({});

    expect(createLayout).toHaveBeenCalled();
    expect(opencodeCtorCalls.length).toBe(1);
    expect(opencodeCtorCalls[0].port).toBe(9999);
  });
});
