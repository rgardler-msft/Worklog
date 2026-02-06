import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { EventEmitter } from 'events';
import type { BlessedFactory } from '../../src/tui/types.js';
import { createPluginContext } from '../../src/cli-utils.js';

type TestNode = {
  options: Record<string, any>;
  style?: Record<string, any>;
  key?: () => void;
  on?: () => void;
  emit?: () => void;
  focus?: () => void;
  show?: () => void;
  hide?: () => void;
  setFront?: () => void;
  destroy?: () => void;
  setContent?: () => void;
  select?: () => void;
  setItems?: () => void;
  selected?: number;
  setValue?: () => void;
  getValue?: () => string;
  setScroll?: () => void;
  getContent?: () => string;
  children?: TestNode[];
};

const makeNode = (options: Record<string, any> = {}): TestNode => {
  const emitter = new EventEmitter() as any;
  const node: TestNode = {
    options,
    style: options.style ?? {},
    key: () => undefined,
    on: (...args: any[]) => emitter.on(...args),
    emit: (...args: any[]) => emitter.emit(...args),
    focus: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    setFront: () => undefined,
    destroy: () => undefined,
  };
  return node;
};

const makeBox = (options: Record<string, any> = {}): TestNode => {
  const node = makeNode(options);
  const state = { content: options.content ?? '' };
  return {
    ...node,
    setContent: (value?: string) => {
      state.content = value ?? '';
    },
    setScroll: () => undefined,
    getContent: () => state.content,
    children: [],
  };
};

const makeList = (options: Record<string, any> = {}): TestNode => {
  const node = makeNode(options);
  const state = { items: options.items ?? [], selected: 0 };
  const listNode: TestNode = {
    ...node,
    children: state.items.map((item: string) => ({ getContent: () => item } as TestNode)),
    select: (index?: number) => {
      state.selected = typeof index === 'number' ? index : state.selected;
      listNode.selected = state.selected;
    },
    setItems: (items?: string[]) => {
      state.items = items ?? [];
    },
    selected: state.selected,
  };
  return listNode;
};

const makeTextarea = (options: Record<string, any> = {}): TestNode => {
  const node = makeNode(options);
  const state = { value: options.value ?? '' };
  return {
    ...node,
    setValue: (value?: string) => {
      state.value = value ?? '';
    },
    getValue: () => state.value,
    children: [],
  };
};

const makeScreen = () => {
  const screen = new EventEmitter() as any;
  screen.height = 40;
  screen.width = 120;
  screen.focused = null;
  screen.render = () => undefined;
  screen.append = () => undefined;
  screen.key = () => undefined;
  screen.destroy = () => undefined;
  return screen;
};

const makeBlessed = () => {
  const boxSpy = vi.fn((options: Record<string, any>) => makeBox(options));
  const listSpy = vi.fn((options: Record<string, any>) => makeList(options));
  const textareaSpy = vi.fn((options: Record<string, any>) => makeTextarea(options));
  const screenSpy = vi.fn(() => makeScreen());
  const textSpy = vi.fn((options: Record<string, any>) => makeBox(options));
  const textboxSpy = vi.fn((options: Record<string, any>) => makeBox(options));
  return {
    box: boxSpy,
    list: listSpy,
    textarea: textareaSpy,
    screen: screenSpy,
    text: textSpy,
    textbox: textboxSpy,
  } as unknown as BlessedFactory & {
    box: typeof boxSpy;
    list: typeof listSpy;
    textarea: typeof textareaSpy;
    screen: typeof screenSpy;
    text: typeof textSpy;
    textbox: typeof textboxSpy;
  };
};

describe('next dialog text wrapping', () => {
  it('enables wrapping for the next dialog text', async () => {
    const blessedImpl = makeBlessed();
    const program = new Command();
    program.exitOverride();
    program.opts = () => ({ json: false, verbose: false }) as any;

    const ctx = createPluginContext(program) as any;
    ctx.blessed = blessedImpl;
    ctx.utils.requireInitialized = () => undefined;
    ctx.utils.getDatabase = () => ({
      list: () => [
        {
          id: 'WL-TEST-1',
          title: 'Test Item 1',
          description: 'desc 1',
          status: 'open',
          priority: 'medium',
          parentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: [],
          assignee: '',
          stage: 'idea',
          issueType: 'task',
          createdBy: '',
          deletedBy: '',
          deleteReason: '',
        },
      ],
      get: () => null,
      update: () => ({}),
      remove: () => undefined,
      getCommentsForWorkItem: () => [],
    });

    const register = (await import('../../src/commands/tui.js')).default;
    register(ctx);

    program.parse(['tui'], { from: 'user' });

    const nextDialogTextCall = blessedImpl.box.mock.calls.find(
      (call) => call[0]?.content === 'Evaluating next work item...'
    );

    expect(nextDialogTextCall).toBeTruthy();
    expect(nextDialogTextCall?.[0]?.wrap).toBe(true);
  });
});
