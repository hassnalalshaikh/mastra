import { describe, expect, it } from 'vitest';
import { MessageList } from '../agent/message-list';
import type { MastraDBMessage, MastraToolInvocationPart } from '../agent/message-list/state/types';
import { TOOL_COMPLETION_INDEX_TYPE } from '../agent/message-list/tool-completion-index';
import { InMemoryStore } from '../storage/mock';
import { createTestController, createTestSession } from './test-utils';
import { projectCompletedToolMessages } from './tool-completion-display';
import type { AgentControllerEvent } from './types';

const stamp = '2026-09-16T12:00:20.000Z';
function history(): MastraDBMessage[] {
  return [
    {
      id: 'old',
      type: 'text',
      role: 'assistant',
      createdAt: new Date('2026-09-16T12:00:00Z'),
      threadId: 'thread',
      resourceId: 'test-owner',
      content: {
        format: 2,
        parts: [
          { type: 'text', text: 'Starting the task.' },
          {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'call-1',
              toolName: 'any_tool',
              args: { original: true },
              result: { url: 'https://example.test/result' },
            },
            providerMetadata: { mastra: { toolCompletion: { completedAt: stamp, runId: 'run-1' } } },
          },
        ],
      },
    },
    {
      id: 'later',
      type: 'text',
      role: 'user',
      createdAt: new Date('2026-09-16T12:00:10Z'),
      threadId: 'thread',
      resourceId: 'test-owner',
      content: { format: 2, parts: [{ type: 'text', text: 'Another question.' }] },
    },
  ];
}

async function storedSession() {
  const storage = new InMemoryStore();
  const controller = createTestController({ storage });
  await controller.init();
  const session = await controller.createSession({
    id: 'test-session',
    ownerId: 'test-owner',
    resourceId: 'test-owner',
  });
  const memory = (await storage.getStore('memory'))!;
  await memory.saveThread({
    thread: { id: 'thread', resourceId: 'test-owner', createdAt: new Date(), updatedAt: new Date(), title: 'Test' },
  });
  return { storage, controller, session, memory };
}

function messageEvents(events: AgentControllerEvent[]) {
  return events.filter(
    (event): event is Extract<AgentControllerEvent, { type: 'message_start' | 'message_update' | 'message_end' }> =>
      event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end',
  );
}

describe('native tool completion display', () => {
  it.each(['result', 'output-error', 'output-denied'] as const)(
    'keeps a user-suspended tool in place for %s without relying on its name',
    state => {
      const input = history();
      const part = input[0]!.content.parts[1] as MastraToolInvocationPart;
      part.toolInvocation = { ...part.toolInvocation, state } as MastraToolInvocationPart['toolInvocation'];
      part.providerMetadata!.mastra!.toolSuspensionWaitingFor = 'user';
      expect(projectCompletedToolMessages(input)).toEqual(input);
    },
  );

  it.each(['ask_user', 'submit_plan'])(
    'keeps %s in its original row across live events and history reads',
    async name => {
      const input = history();
      const question = input[0]!;
      (question.content.parts[1] as MastraToolInvocationPart).toolInvocation.toolName = name;
      const before = structuredClone(input);
      expect(projectCompletedToolMessages(input)).toEqual(input);

      const { session, memory } = await storedSession();
      await memory.saveMessages({ messages: input });
      const live: MastraDBMessage[] = [];
      session.subscribe(event => {
        if (event.type === 'message_start') live.push(event.message);
      });
      session.emit({ type: 'message_start', message: question });
      expect(live).toEqual([question]);
      expect(await session.thread.listMessages({ threadId: 'thread' })).toEqual(input);
      expect(input).toEqual(before);
    },
  );

  it('keeps a question in place while moving a generation from the same message to its completion time', () => {
    const input = history();
    const question = structuredClone(input[0]!.content.parts[1]) as MastraToolInvocationPart;
    question.toolInvocation.toolName = 'ask_user';
    question.toolInvocation.toolCallId = 'question-1';
    input[0]!.content.parts.unshift(question);
    const rows = projectCompletedToolMessages(input);
    expect(rows.map(row => row.id)).toEqual(['old', 'later', 'old:tool-result:call-1']);
    expect(rows[0]!.content.parts[0]).toEqual(question);
    expect(rows[2]!.content.parts).toEqual([input[0]!.content.parts[2]]);
    expect(projectCompletedToolMessages(rows)).toEqual(rows);
  });

  it('places exactly one result after later conversation without changing stored inputs', () => {
    const input = history();
    const before = structuredClone(input);
    const rows = projectCompletedToolMessages(input);
    expect(rows.map(row => row.id)).toEqual(['old', 'later', 'old:tool-result:call-1']);
    expect(rows[0]!.content.parts).toEqual([{ type: 'text', text: 'Starting the task.' }]);
    expect(rows[2]!.createdAt.toISOString()).toBe(stamp);
    expect((rows[2]!.content.parts[0] as MastraToolInvocationPart).toolInvocation.args).toEqual({ original: true });
    expect(input).toEqual(before);
    expect(projectCompletedToolMessages(rows)).toEqual(rows);
    expect(JSON.stringify(rows).match(/https:\/\/example.test\/result/g)).toHaveLength(1);
  });

  it('leaves rows without a completion record untouched and in stored order', () => {
    const input = history();
    delete (input[0]!.content.parts[1] as MastraToolInvocationPart).providerMetadata;
    const reversed = [input[1]!, input[0]!];
    expect(projectCompletedToolMessages(reversed)).toEqual(reversed);
  });

  it('uses the same row identity for live events and stored reads', async () => {
    const { session, memory } = await storedSession();
    await memory.saveMessages({ messages: history() });
    const before = await memory.listMessages({ threadId: 'thread', perPage: false });
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => events.push(event));
    session.emit({ type: 'message_start', message: history()[0]! });
    const live = messageEvents(events).flatMap(event => (event.type === 'message_start' ? [event.message] : []));
    const loaded = await session.thread.listMessages({ threadId: 'thread' });
    expect(loaded.filter(row => row.role === 'assistant')).toEqual(live);
    expect(messageEvents(events).map(event => [event.type, 'message' in event ? event.message.id : event.id])).toEqual([
      ['message_start', 'old'],
      ['message_start', 'old:tool-result:call-1'],
      ['message_end', 'old:tool-result:call-1'],
    ]);
    expect((await memory.listMessages({ threadId: 'thread', perPage: false })).messages).toEqual(before.messages);
  });

  it('completion rows do not replace the current assistant answer', async () => {
    const { session } = await createTestSession();
    session.emit({ type: 'message_start', message: history()[0]! });
    expect(session.displayState.get().currentMessage?.id).toBe('old');
    expect(session.displayState.get().currentMessage?.content.parts).toEqual([
      { type: 'text', text: 'Starting the task.' },
    ]);
  });
});

describe('live completion deltas', () => {
  const call = (state: 'call' | 'result', completedAt?: string): MastraToolInvocationPart =>
    ({
      type: 'tool-invocation',
      toolInvocation: {
        state,
        toolCallId: 'call-1',
        toolName: 'generate_image',
        args: { prompt: 'cat' },
        ...(state === 'result' ? { result: { url: 'https://example.test/cat.png' } } : {}),
      },
      ...(completedAt ? { providerMetadata: { mastra: { toolCompletion: { completedAt } } } } : {}),
    }) as MastraToolInvocationPart;

  function streamingMessage(): MastraDBMessage {
    return {
      id: 'live',
      role: 'assistant',
      threadId: 'thread',
      createdAt: new Date('2026-09-16T12:00:00Z'),
      content: { format: 2, parts: [] },
    };
  }

  it('moves a call that completes mid-stream and re-indexes later deltas of its source row', async () => {
    const { session } = await createTestSession();
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => events.push(event));

    session.emit({ type: 'message_start', message: streamingMessage() });
    session.emit({ type: 'message_update', id: 'live', event: { type: 'part', index: 0, part: call('call') } });
    session.emit({
      type: 'message_update',
      id: 'live',
      event: { type: 'part', index: 0, part: call('result', stamp) },
    });
    session.emit({
      type: 'message_update',
      id: 'live',
      event: { type: 'part', index: 1, part: { type: 'reasoning', reasoning: '', details: [] } },
    });
    session.emit({ type: 'message_update', id: 'live', event: { type: 'reasoning-delta', index: 1, delta: 'Think' } });
    session.emit({ type: 'message_update', id: 'live', event: { type: 'text-delta', delta: 'Here it is.' } });
    session.emit({ type: 'message_end', id: 'live' });

    const wire = messageEvents(events).map(event =>
      event.type === 'message_start'
        ? ['start', event.message.id, event.message.content.parts.map(part => part.type)]
        : event.type === 'message_update'
          ? ['update', event.id, event.event.type, 'index' in event.event ? event.event.index : undefined]
          : ['end', event.id],
    );
    expect(wire).toEqual([
      ['start', 'live', []],
      ['update', 'live', 'part', 0],
      // The call completed: the source row is re-snapshotted without it and the
      // outcome settles as its own row.
      ['start', 'live', []],
      ['start', 'live:tool-result:call-1', ['tool-invocation']],
      ['end', 'live:tool-result:call-1'],
      // Later parts of the source row shift past the moved call.
      ['update', 'live', 'part', 0],
      ['update', 'live', 'reasoning-delta', 0],
      ['update', 'live', 'text-delta', undefined],
      ['end', 'live'],
    ]);
    expect(session.displayState.get().currentMessage?.content.parts).toEqual([
      { type: 'reasoning', reasoning: 'Think', details: [{ type: 'text', text: 'Think' }] },
      { type: 'text', text: 'Here it is.' },
    ]);
  });

  it('keeps a question answered mid-stream in its row', async () => {
    const { session } = await createTestSession();
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => events.push(event));
    const answered = call('result', stamp);
    answered.providerMetadata!.mastra!.toolSuspensionWaitingFor = 'user';
    const update = {
      type: 'message_update' as const,
      id: 'live',
      event: { type: 'part' as const, index: 0, part: answered },
    };
    session.emit({ type: 'message_start', message: streamingMessage() });
    session.emit(update);
    expect(messageEvents(events)).toEqual([{ type: 'message_start', message: streamingMessage() }, update]);
    expect(session.displayState.get().currentMessage?.content.parts).toEqual([answered]);
  });

  it('passes deltas through unchanged while nothing has completed', async () => {
    const { session } = await createTestSession();
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => events.push(event));
    const update = {
      type: 'message_update' as const,
      id: 'live',
      event: { type: 'part' as const, index: 0, part: call('call') },
    };
    session.emit({ type: 'message_start', message: streamingMessage() });
    session.emit(update);
    expect(messageEvents(events)).toEqual([{ type: 'message_start', message: streamingMessage() }, update]);
  });
});

describe('stored completion records', () => {
  it('stamps the first terminal commit from the part clock and keeps raw call provenance', () => {
    const list = new MessageList({ threadId: 'thread', resourceId: 'test-owner' });
    const original = history()[0]!;
    original.content.parts[1] = {
      type: 'tool-invocation',
      toolInvocation: { state: 'call', toolCallId: 'call-1', toolName: 'any_tool', args: { original: true } },
    };
    list.add(original, 'memory');
    list.updateToolInvocation({
      type: 'tool-invocation',
      toolInvocation: { state: 'result', toolCallId: 'call-1', toolName: 'any_tool', args: {}, result: 'done' },
    });
    const part = list.get.all.db()[0]!.content.parts[1] as MastraToolInvocationPart;
    const completion = part.providerMetadata?.mastra?.toolCompletion as { completedAt: string };
    expect(completion.completedAt).toBe(new Date(part.updatedAt!).toISOString());
    expect(part.toolInvocation.args).toEqual({ original: true });

    // A later re-merge (processor redaction) never moves the completion.
    list.updateToolInvocation({
      type: 'tool-invocation',
      toolInvocation: { state: 'result', toolCallId: 'call-1', toolName: 'any_tool', args: {}, result: 'redacted' },
      updatedAt: Date.parse(completion.completedAt) + 5_000,
    });
    const redacted = list.get.all.db()[0]!.content.parts[1] as MastraToolInvocationPart;
    expect(redacted.providerMetadata?.mastra?.toolCompletion).toEqual(completion);
    expect(projectCompletedToolMessages(list.get.all.db())).toHaveLength(2);
    expect(list.get.all.db()).toHaveLength(1);
  });

  it.each([
    ['a running background placeholder', { backgroundTask: { taskId: 'task-1', status: 'running' } }],
    ['a pending execution', { toolExecutionPending: true }],
  ])('does not stamp %s', (_label, mastra) => {
    const list = new MessageList({ threadId: 'thread', resourceId: 'test-owner' });
    const original = history()[0]!;
    original.content.parts[1] = {
      type: 'tool-invocation',
      toolInvocation: { state: 'call', toolCallId: 'call-1', toolName: 'any_tool', args: {} },
    };
    list.add(original, 'memory');
    list.updateToolInvocation({
      type: 'tool-invocation',
      toolInvocation: { state: 'result', toolCallId: 'call-1', toolName: 'any_tool', args: {}, result: 'started' },
      providerMetadata: { mastra } as MastraToolInvocationPart['providerMetadata'],
    });
    const part = list.get.all.db()[0]!.content.parts[1] as MastraToolInvocationPart;
    expect(part.providerMetadata?.mastra?.toolCompletion).toBeUndefined();
  });

  it('does not stamp a provider-executed call', () => {
    const list = new MessageList({ threadId: 'thread', resourceId: 'test-owner' });
    const original = history()[0]!;
    original.content.parts[1] = {
      type: 'tool-invocation',
      toolInvocation: { state: 'call', toolCallId: 'call-1', toolName: 'web_search', args: {} },
      providerExecuted: true,
    } as MastraToolInvocationPart;
    list.add(original, 'memory');
    list.updateToolInvocation({
      type: 'tool-invocation',
      toolInvocation: { state: 'result', toolCallId: 'call-1', toolName: 'web_search', args: {}, result: 'found' },
    });
    const part = list.get.all.db()[0]!.content.parts[1] as MastraToolInvocationPart;
    expect(part.providerMetadata?.mastra?.toolCompletion).toBeUndefined();
  });

  it('shows a recent completion in a bounded window even when its call is older than the window', async () => {
    const { storage, session, memory } = await storedSession();
    const [source, firstFollowUp] = history();
    const later = Array.from({ length: 30 }, (_, index) => ({
      ...structuredClone(firstFollowUp!),
      id: `later-${index}`,
      createdAt: new Date(Date.parse('2026-09-16T12:00:01Z') + index * 100),
    }));
    // The completion lands after every later turn.
    (source!.content.parts[1] as MastraToolInvocationPart).providerMetadata = {
      mastra: { toolCompletion: { completedAt: '2026-09-16T12:01:00.000Z' } },
    };
    await memory.saveMessages({ messages: [source!, ...later] });
    const threadState = (await storage.getStore('threadState'))!;

    const withoutIndex = await session.thread.listMessages({ threadId: 'thread', limit: 10 });
    expect(withoutIndex.some(row => row.id.startsWith('old'))).toBe(false);

    await threadState.setState({
      threadId: 'thread',
      type: TOOL_COMPLETION_INDEX_TYPE,
      value: [{ messageId: 'old', completedAt: '2026-09-16T12:01:00.000Z' }],
    });
    const windowed = await session.thread.listMessages({ threadId: 'thread', limit: 10 });
    expect(windowed).toHaveLength(10);
    expect(windowed.at(-1)!.id).toBe('old:tool-result:call-1');
    expect(windowed.slice(0, -1).map(row => row.id)).toEqual(later.slice(-9).map(row => row.id));
  });

  it('projects the full history for a window wider than the completion index', async () => {
    const { session, memory } = await storedSession();
    await memory.saveMessages({ messages: history() });
    const rows = await session.thread.listMessages({ threadId: 'thread', limit: 2000 });
    expect(rows.map(row => row.id)).toEqual(['old', 'later', 'old:tool-result:call-1']);
  });

  it('returns no rows for an empty display window', async () => {
    const { controller, memory } = await storedSession();
    await memory.saveMessages({ messages: history() });
    const result = await controller.queryThreadDisplayMessages({ threadId: 'thread', limit: 0 });
    expect(result.messages).toEqual([]);
  });
});
