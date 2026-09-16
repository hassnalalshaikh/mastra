import { describe, expect, it, vi } from 'vitest';
import { AgentController } from '../../agent-controller/agent-controller';
import { createTestController } from '../../agent-controller/test-utils';
import { MockMemory } from '../../memory/mock';
import { InMemoryStore } from '../../storage/mock';
import { MessageList } from '../message-list';
import type { MastraDBMessage } from '../message-list/state/types';
import {
  indexToolCompletions,
  TOOL_COMPLETION_INDEX_LIMIT,
  TOOL_COMPLETION_INDEX_TYPE,
} from '../message-list/tool-completion-index';
import { SaveQueueManager } from './index';

const completedAt = '2026-09-16T12:00:20.000Z';
function source(): MastraDBMessage {
  return {
    id: 'source',
    role: 'assistant',
    threadId: 'thread',
    resourceId: 'owner',
    createdAt: new Date('2026-09-16T12:00:00Z'),
    content: {
      format: 2,
      parts: [
        {
          type: 'tool-invocation',
          toolInvocation: { state: 'result', toolCallId: 'call', toolName: 'work', args: {}, result: 'Saved result' },
          providerMetadata: { mastra: { toolCompletion: { completedAt, runId: 'run' } } },
        },
      ],
    },
  };
}

async function setup() {
  const storage = new InMemoryStore();
  await storage.init();
  const memory = new MockMemory({ storage });
  const memoryStore = await storage.getStore('memory');
  await memoryStore!.saveThread({
    thread: { id: 'thread', resourceId: 'owner', title: 'Test', createdAt: new Date(), updatedAt: new Date() },
  });
  const list = new MessageList({ threadId: 'thread', resourceId: 'owner' });
  list.add(source(), 'response');
  const queue = new SaveQueueManager({ memory });
  const threadState = (await storage.getStore('threadState'))!;
  return { storage, memoryStore: memoryStore!, threadState, list, queue };
}

describe('native recent tool completion index', () => {
  it('cold reopen finds an old call outside the normal window with bounded reads', async () => {
    const { storage, queue, list, memoryStore } = await setup();
    const later: MastraDBMessage[] = Array.from({ length: 30 }, (_, i) => ({
      id: `later-${i}`,
      role: 'user',
      threadId: 'thread',
      resourceId: 'owner',
      createdAt: new Date(Date.parse('2026-09-16T12:00:01Z') + i * 100),
      content: { format: 2, parts: [{ type: 'text', text: `Later ${i}` }] },
    }));
    await Promise.all([queue.flushMessages(list, 'thread'), memoryStore.saveMessages({ messages: later })]);
    const cold = createTestController({ storage });
    await cold.init();
    const reads = vi.spyOn(memoryStore, 'listMessages');
    const rows = await cold.queryThreadMessages({ threadId: 'thread', limit: 5 });
    expect(rows.at(-1)?.id).toBe('source:tool-result:call');
    expect(rows).toHaveLength(5);
    expect(reads).toHaveBeenCalledWith(
      expect.objectContaining({
        perPage: 5,
        include: [{ id: 'source', threadId: 'thread', withPreviousMessages: 0, withNextMessages: 0 }],
      }),
    );
    expect(reads).not.toHaveBeenCalledWith(expect.objectContaining({ perPage: false }));
    const raw = (await memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages;
    expect(raw).toHaveLength(31);
    expect(raw.filter(row => JSON.stringify(row.content).includes('Saved result'))).toHaveLength(1);
  });

  it('index failure rejects persistence and explicit retry restores the missing index without duplicating output', async () => {
    const { queue, list, threadState, memoryStore } = await setup();
    const fail = vi.spyOn(threadState, 'setState').mockRejectedValueOnce(new Error('index write failed'));
    await expect(queue.flushMessages(list, 'thread')).rejects.toThrow('index write failed');
    expect((await memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages).toHaveLength(1);
    await queue.flushMessages(list, 'thread');
    expect(await threadState.getState({ threadId: 'thread', type: TOOL_COMPLETION_INDEX_TYPE })).toEqual([
      { messageId: 'source', completedAt },
    ]);
    expect((await memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages).toHaveLength(1);
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it('does not write an index for a failed source write', async () => {
    const { queue, list, threadState, memoryStore } = await setup();
    vi.spyOn(memoryStore, 'saveMessages').mockRejectedValueOnce(new Error('source failed'));
    const indexWrite = vi.spyOn(threadState, 'setState');
    await expect(queue.flushMessages(list, 'thread')).rejects.toThrow('source failed');
    expect(indexWrite).not.toHaveBeenCalled();
  });

  it('repeated results keep one bounded source index entry and explicit large history remains available', async () => {
    const { threadState, storage } = await setup();
    const messages = Array.from({ length: TOOL_COMPLETION_INDEX_LIMIT + 2 }, (_, i) => {
      const msg = source();
      msg.id = `source-${i}`;
      return msg;
    });
    await indexToolCompletions(threadState, messages);
    const write = vi.spyOn(threadState, 'setState');
    await indexToolCompletions(threadState, [messages[0]!]);
    expect(
      await threadState.getState<unknown[]>({ threadId: 'thread', type: TOOL_COMPLETION_INDEX_TYPE }),
    ).toHaveLength(TOOL_COMPLETION_INDEX_LIMIT);
    expect(write).not.toHaveBeenCalled();
    const controller: AgentController = createTestController({ storage });
    await expect(
      controller.queryThreadMessages({ threadId: 'thread', limit: TOOL_COMPLETION_INDEX_LIMIT + 1 }),
    ).resolves.toEqual([]);
  });
});
