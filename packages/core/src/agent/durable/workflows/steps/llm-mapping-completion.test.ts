import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockMemory } from '../../../../memory/mock';
import { InMemoryStore } from '../../../../storage/mock';
import { PUBSUB_SYMBOL } from '../../../../workflows/constants';
import { MessageList } from '../../../message-list';
import { withToolCompletionMetadata } from '../../../message-list/tool-completion';
import { TOOL_COMPLETION_INDEX_TYPE } from '../../../message-list/tool-completion-index';
import { SaveQueueManager } from '../../../save-queue';
import { globalRunRegistry } from '../../run-registry';
import { emitChunkEvent } from '../../stream-adapter';
import { createDurableLLMMappingStep } from './llm-mapping';

vi.mock('../../stream-adapter', () => ({ emitChunkEvent: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => {
  globalRunRegistry.delete('run');
  vi.clearAllMocks();
});

async function fixture() {
  const storage = new InMemoryStore();
  await storage.init();
  const memory = new MockMemory({ storage });
  const memoryStore = (await storage.getStore('memory'))!;
  await memoryStore.saveThread({
    thread: { id: 'thread', resourceId: 'owner', title: 'Test', createdAt: new Date(), updatedAt: new Date() },
  });
  const messageList = new MessageList({ threadId: 'thread', resourceId: 'owner' });
  messageList.add(
    {
      id: 'source',
      role: 'assistant',
      createdAt: new Date(1000),
      threadId: 'thread',
      resourceId: 'owner',
      content: {
        format: 2,
        parts: [
          {
            type: 'tool-invocation',
            toolInvocation: { state: 'call', toolCallId: 'call', toolName: 'work', args: { original: true } },
          },
        ],
      },
    },
    'response',
  );
  const saveQueueManager = new SaveQueueManager({ memory });
  globalRunRegistry.set('run', { tools: {}, messageList, memory, saveQueueManager } as any);
  const params = {
    inputData: {
      runId: 'run',
      agentId: 'agent',
      messageId: 'source',
      state: { threadId: 'thread', resourceId: 'owner', threadExists: true },
      llmOutput: { messageListState: messageList.serialize(), stepResult: { isContinued: true } },
      toolResults: [],
    },
    [PUBSUB_SYMBOL]: {},
  };
  const run = async (outcome: object) =>
    (createDurableLLMMappingStep() as any).execute({
      ...params,
      inputData: {
        ...params.inputData,
        toolResults: [{ toolCallId: 'call', toolName: 'work', args: { original: true }, ...outcome }],
      },
    });
  return { run, storage, memoryStore, threadState: (await storage.getStore('threadState'))! };
}

describe('durable outcome commit boundary', () => {
  it.each([
    [{ result: 'Saved' }, 'tool-result', 'result'],
    [{ error: { name: 'Error', message: 'Failed' } }, 'tool-error', 'output-error'],
    [{ result: { error: true }, isError: true }, 'tool-result', 'output-error'],
    [{ approval: { id: 'call', approved: false, reason: 'No' } }, 'tool-output-denied', 'output-denied'],
  ])('commits %j before publishing %s', async (outcome, type, state) => {
    const f = await fixture();
    vi.mocked(emitChunkEvent).mockImplementation(async (_pubsub, _run, chunk) => {
      if (chunk.type !== type) return;
      const saved = (await f.memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages;
      expect(saved[0]!.content.parts[0]).toMatchObject({
        toolInvocation: { state },
        providerMetadata: { mastra: { toolCompletion: { runId: 'run' } } },
      });
      expect(await f.threadState.getState({ threadId: 'thread', type: TOOL_COMPLETION_INDEX_TYPE })).toEqual([
        expect.objectContaining({ messageId: 'source' }),
      ]);
      expect(chunk.payload).toMatchObject({ messageId: 'source' });
    });
    await f.run(outcome as object);
    expect(emitChunkEvent).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'index'])('does not publish completion after a failed %s write', async target => {
    const f = await fixture();
    if (target === 'source') vi.spyOn(f.memoryStore, 'saveMessages').mockRejectedValueOnce(new Error('source failure'));
    else vi.spyOn(f.threadState, 'setState').mockRejectedValueOnce(new Error('index failure'));
    await expect(f.run({ result: 'Saved' })).rejects.toThrow(`${target} failure`);
    expect(emitChunkEvent).not.toHaveBeenCalled();
    await f.run({ result: 'Saved' });
    expect(emitChunkEvent).toHaveBeenCalledTimes(1);
    expect((await f.memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages).toHaveLength(1);
  });

  it('keeps dispatch acknowledgement preliminary without a completion index', async () => {
    const f = await fixture();
    await f.run({ result: 'Background task started.', preliminary: true });
    expect(emitChunkEvent).toHaveBeenCalledWith(
      expect.anything(),
      'run',
      expect.objectContaining({ type: 'tool-result', payload: expect.objectContaining({ preliminary: true }) }),
    );
    expect(await f.threadState.getState({ threadId: 'thread', type: TOOL_COMPLETION_INDEX_TYPE })).toBeUndefined();
    const saved = (await f.memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages;
    expect((saved[0]!.content.parts[0] as any).providerMetadata.mastra.toolCompletion).toBeUndefined();
  });

  it('preserves a background result committed before its dispatch acknowledgement is mapped', async () => {
    const f = await fixture();
    const entry = globalRunRegistry.get('run')!;
    entry.messageList!.updateToolInvocation({
      type: 'tool-invocation',
      providerMetadata: withToolCompletionMetadata(undefined, 'run'),
      toolInvocation: {
        state: 'result',
        toolCallId: 'call',
        toolName: 'work',
        args: { original: true },
        result: 'Already completed',
      },
    });
    await entry.saveQueueManager!.flushMessages(entry.messageList!, 'thread');
    await f.run({ result: 'Background task started.', preliminary: true });
    expect(emitChunkEvent).not.toHaveBeenCalled();
    const saved = (await f.memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages;
    expect(saved[0]!.content.parts[0]).toMatchObject({ toolInvocation: { result: 'Already completed' } });
  });

  it('does not publish or persist an aborted call as a completed result', async () => {
    const f = await fixture();
    await f.run({ aborted: true });
    expect(emitChunkEvent).not.toHaveBeenCalled();
    expect(await f.threadState.getState({ threadId: 'thread', type: TOOL_COMPLETION_INDEX_TYPE })).toBeUndefined();
  });
});
