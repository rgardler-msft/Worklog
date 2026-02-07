import { describe, it, expect, vi } from 'vitest';
import { SseParser } from '../../src/tui/opencode-sse.js';
import { OpencodeClient } from '../../src/tui/opencode-client.js';

describe('SseParser', () => {
  it('parses a single data event', () => {
    const parser = new SseParser();
    const events = parser.push('data: {"type":"message"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"type":"message"}');
  });

  it('joins multiline data fields', () => {
    const parser = new SseParser();
    expect(parser.push('data: first line\n')).toHaveLength(0);
    const events = parser.push('data: second line\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('first line\nsecond line');
  });

  it('ignores keepalive comments', () => {
    const parser = new SseParser();
    const events = parser.push(': keepalive\n\n');
    expect(events).toHaveLength(0);
  });

  it('returns [DONE] payloads', () => {
    const parser = new SseParser();
    const events = parser.push('data: [DONE]\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('[DONE]');
  });

  it('handles chunked payloads', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":1')).toHaveLength(0);
    const events = parser.push('}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('{"a":1}');
  });
});

describe('OpencodeClient SSE event handling', () => {
  const makeClient = () => new OpencodeClient({
    port: 1234,
    log: () => {},
    showToast: () => {},
    modalDialogs: { selectList: async () => null, editTextarea: async () => null, confirmTextbox: async () => true },
    render: () => {},
    persistedState: { load: () => ({}), save: () => {}, getPrefix: () => undefined },
    httpImpl: {} as any,
    spawnImpl: () => { throw new Error('not used'); },
  } as any);

  const makeHandlers = () => ({
    onTextDelta: vi.fn(),
    onTextReset: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onPermissionRequest: vi.fn(),
    onQuestionAsked: vi.fn(),
    onInputRequest: vi.fn(),
    onSessionEnd: vi.fn(),
  });

  it('routes text/tool events and input requests', () => {
    const client = makeClient();
    const handlers = makeHandlers();
    const partTextById = new Map<string, string>();
    const messageRoleById = new Map<string, string>();

    (client as any).handleSseEvent({
      data: {
        type: 'message.part',
        properties: { sessionID: 'sess1', part: { id: 'p1', messageID: 'm1', type: 'text', text: 'hello' } },
      },
      sessionId: 'sess1',
      partTextById,
      messageRoleById,
      lastUserMessageId: null,
      prompt: '',
      handlers,
      setLastUserMessageId: () => {},
      waitingForInput: false,
      setWaitingForInput: () => {},
    });

    (client as any).handleSseEvent({
      data: {
        type: 'message.part',
        properties: { sessionID: 'sess1', part: { id: 'p2', messageID: 'm2', type: 'tool-use', tool: { name: 'bash' } } },
      },
      sessionId: 'sess1',
      partTextById,
      messageRoleById,
      lastUserMessageId: null,
      prompt: '',
      handlers,
      setLastUserMessageId: () => {},
      waitingForInput: false,
      setWaitingForInput: () => {},
    });

    (client as any).handleSseEvent({
      data: {
        type: 'message.part',
        properties: { sessionID: 'sess1', part: { id: 'p3', messageID: 'm3', type: 'tool-result', content: 'ok' } },
      },
      sessionId: 'sess1',
      partTextById,
      messageRoleById,
      lastUserMessageId: null,
      prompt: '',
      handlers,
      setLastUserMessageId: () => {},
      waitingForInput: false,
      setWaitingForInput: () => {},
    });

    (client as any).handleSseEvent({
      data: {
        type: 'input.request',
        properties: { sessionID: 'sess1', type: 'text', prompt: 'Enter value' },
      },
      sessionId: 'sess1',
      partTextById,
      messageRoleById,
      lastUserMessageId: null,
      prompt: '',
      handlers,
      setLastUserMessageId: () => {},
      waitingForInput: false,
      setWaitingForInput: () => {},
    });

    expect(handlers.onTextDelta).toHaveBeenCalledWith('hello');
    expect(handlers.onToolUse).toHaveBeenCalledWith('bash', undefined);
    expect(handlers.onToolResult).toHaveBeenCalledWith('ok');
    expect(handlers.onInputRequest).toHaveBeenCalledWith({ type: 'text', prompt: 'Enter value' });
  });
});
