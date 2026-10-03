import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { Agent } from '../../agent';
import { MockMemory } from '../../memory/mock';
import { InMemoryStore } from '../../storage/mock';
import { createTool } from '../../tools/tool';
import { MessageList } from '../message-list';
import type { MastraToolInvocationPart } from '../message-list/state/types';
import { TOOL_COMPLETION_INDEX_TYPE } from '../message-list/tool-completion-index';
import { SaveQueueManager } from './index';

function toolThenAnswer() {
  let step = 0;
  return new MockLanguageModelV2({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        ...(step++ === 0
          ? [{ type: 'tool-call' as const, toolCallId: 'call-real', toolName: 'work', input: '{}' }]
          : [
              { type: 'text-start' as const, id: 'text' },
              { type: 'text-delta' as const, id: 'text', delta: 'Done' },
              { type: 'text-end' as const, id: 'text' },
            ]),
        {
          type: 'finish',
          finishReason: step === 1 ? 'tool-calls' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    }),
  });
}

describe('native tool completion record', () => {
  it.each([false, true])('publishes exactly the completion the transcript stores (tool fails=%s)', async fails => {
    const storage = new InMemoryStore();
    const memory = new MockMemory({ storage });
    const agent = new Agent({
      id: 'completion-proof',
      name: 'Completion proof',
      instructions: 'Test',
      model: toolThenAnswer(),
      memory,
      tools: {
        work: createTool({
          id: 'work',
          description: 'Work',
          inputSchema: z.object({}),
          execute: async () => {
            if (fails) throw new Error('Work failed');
            return 'Actual result';
          },
        }),
      },
    });
    const stream = await agent.stream('Run', { memory: { thread: 'completion-thread', resource: 'owner' } });
    const chunks: any[] = [];
    for await (const chunk of stream.fullStream) chunks.push(chunk);

    const outcome = chunks.find(chunk => chunk.type === (fails ? 'tool-error' : 'tool-result'));
    const published = outcome?.payload.providerMetadata?.mastra?.toolCompletion;
    expect(published).toEqual({ completedAt: expect.any(String) });

    const { messages } = await (await storage.getStore('memory'))!.listMessages({
      threadId: 'completion-thread',
      perPage: false,
    });
    const source = messages.find(message =>
      message.content.parts.some(
        candidate => candidate.type === 'tool-invocation' && candidate.toolInvocation.toolCallId === 'call-real',
      ),
    )!;
    const part = source.content.parts.find(
      candidate => candidate.type === 'tool-invocation' && candidate.toolInvocation.toolCallId === 'call-real',
    ) as MastraToolInvocationPart;
    expect(part.toolInvocation.state).toBe(fails ? 'output-error' : 'result');
    expect(part.providerMetadata?.mastra?.toolCompletion).toEqual(published);
  });

  it('indexes saved completions per thread, with the latest completion of each source message', async () => {
    const storage = new InMemoryStore();
    const memory = new MockMemory({ storage });
    const manager = new SaveQueueManager({ memory });
    const list = new MessageList({ threadId: 'index-thread', resourceId: 'owner' });
    const call = (toolCallId: string) => ({
      type: 'tool-invocation' as const,
      toolInvocation: { state: 'call' as const, toolCallId, toolName: 'work', args: {} },
    });
    list.add(
      {
        id: 'source',
        role: 'assistant',
        threadId: 'index-thread',
        resourceId: 'owner',
        createdAt: new Date('2026-09-16T12:00:00Z'),
        content: { format: 2, parts: [call('a'), call('b')] },
      },
      'memory',
    );
    const complete = (toolCallId: string, updatedAt: number) =>
      list.updateToolInvocation({
        type: 'tool-invocation',
        toolInvocation: { state: 'result', toolCallId, toolName: 'work', args: {}, result: toolCallId },
        updatedAt,
      });
    complete('a', Date.parse('2026-09-16T12:00:20Z'));
    await manager.flushMessages(list, 'index-thread');
    complete('b', Date.parse('2026-09-16T12:00:30Z'));
    await manager.flushMessages(list, 'index-thread');

    const threadState = (await storage.getStore('threadState'))!;
    expect(await threadState.getState({ threadId: 'index-thread', type: TOOL_COMPLETION_INDEX_TYPE })).toEqual([
      { messageId: 'source', completedAt: '2026-09-16T12:00:30.000Z' },
    ]);
  });

  it('does not write the index when nothing completed', async () => {
    const storage = new InMemoryStore();
    const manager = new SaveQueueManager({ memory: new MockMemory({ storage }) });
    const list = new MessageList({ threadId: 'quiet-thread', resourceId: 'owner' });
    list.add({ role: 'user', content: 'Hello' }, 'input');
    await manager.flushMessages(list, 'quiet-thread');
    const threadState = (await storage.getStore('threadState'))!;
    expect(await threadState.getState({ threadId: 'quiet-thread', type: TOOL_COMPLETION_INDEX_TYPE })).toBeUndefined();
  });
});
