import { describe, expect, it } from 'vitest';
import { MessageList } from '../agent/message-list';
import type { MastraDBMessage, MastraToolInvocationPart } from '../agent/message-list/state/types';
import { InMemoryStore } from '../storage/mock';
import { createTestSession } from './test-utils';
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

describe('native tool completion display', () => {
  it.each(['ask_user', 'submit_plan'])(
    'keeps %s in its original row across live updates and history reads',
    async toolName => {
      const input = history();
      const question = input[0]!;
      const part = question.content.parts[1] as MastraToolInvocationPart;
      part.toolInvocation.toolName = toolName;
      const before = structuredClone(input);
      expect(projectCompletedToolMessages(input)).toEqual(input);

      const storage = new InMemoryStore();
      const { controller, session } = await createTestSession({ storage });
      const memory = await storage.getStore('memory');
      await memory!.saveThread({
        thread: { id: 'thread', resourceId: 'test-owner', createdAt: new Date(), updatedAt: new Date(), title: 'Test' },
      });
      await memory!.saveMessages({ messages: input });
      const live: MastraDBMessage[] = [];
      session.subscribe(event => {
        if (event.type === 'message_update') live.push(event.message);
      });
      session.emit({ type: 'message_update', message: question });
      expect(live).toEqual([question]);
      expect(await controller.queryThreadMessages({ threadId: 'thread' })).toEqual(input);
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

  it('uses the same row identity for live events and persisted reads', async () => {
    const storage = new InMemoryStore();
    const { controller, session } = await createTestSession({ storage });
    const memory = await storage.getStore('memory');
    await memory!.saveThread({
      thread: { id: 'thread', resourceId: 'test-owner', createdAt: new Date(), updatedAt: new Date(), title: 'Test' },
    });
    await memory!.saveMessages({ messages: history() });
    const before = await memory!.listMessages({ threadId: 'thread', perPage: false });
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => events.push(event));
    session.emit({ type: 'message_update', message: history()[0]! });
    const live = events.filter(event => event.type === 'message_update').map(event => event.message);
    const loaded = await controller.queryThreadMessages({ threadId: 'thread' });
    expect(loaded.filter(row => row.role === 'assistant')).toEqual(live);
    expect((await memory!.listMessages({ threadId: 'thread', perPage: false })).messages).toEqual(before.messages);
  });

  it('persists native completion metadata while keeping raw model call provenance', () => {
    const list = new MessageList({ threadId: 'thread', resourceId: 'test-owner' });
    const original = history()[0]!;
    const invocation = original.content.parts[1] as MastraToolInvocationPart;
    original.content.parts[1] = {
      type: 'tool-invocation',
      toolInvocation: { state: 'call', toolCallId: 'call-1', toolName: 'any_tool', args: { original: true } },
    };
    list.add(original, 'memory');
    list.updateToolInvocation(invocation);
    const stored = list.get.all.db()[0]!;
    expect(stored.createdAt).toEqual(original.createdAt);
    expect((stored.content.parts[1] as MastraToolInvocationPart).providerMetadata?.mastra?.toolCompletion).toEqual({
      completedAt: stamp,
      runId: 'run-1',
    });
    expect(projectCompletedToolMessages(list.get.all.db())).toHaveLength(2);
    expect(list.get.all.db()).toHaveLength(1);
  });
});

it('completion rows do not replace the current assistant answer', async () => {
  const { session } = await createTestSession();
  const message = history()[0]!;
  session.emit({ type: 'message_end', message });
  expect(session.displayState.get().currentMessage?.id).toBe('old');
  expect(session.displayState.get().currentMessage?.content.parts).toEqual([
    { type: 'text', text: 'Starting the task.' },
  ]);
});
