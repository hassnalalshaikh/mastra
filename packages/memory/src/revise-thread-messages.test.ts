import { createSignal } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import type { MastraVector } from '@mastra/core/vector';
import { describe, expect, it, vi } from 'vitest';
import { Memory } from './index';
import { ObservationalMemory } from './processors/observational-memory/observational-memory';
import { BufferingCoordinator } from './processors/observational-memory/buffering-coordinator';

async function fixture() {
  const storage = new InMemoryStore();
  const deleteVectors = vi.fn().mockResolvedValue(undefined);
  const vector = {
    isSelfEmbedding: true,
    indexSeparator: '_',
    listIndexes: vi.fn().mockResolvedValue(['memory_messages', 'memory_observations_1536', 'unrelated']),
    deleteVectors,
  } as unknown as MastraVector;
  const memory = new Memory({ storage, vector, options: { semanticRecall: { topK: 3, messageRange: 1 } } });
  const store = (await storage.getStore('memory'))!;
  await store.saveThread({
    thread: { id: 'thread', resourceId: 'owner', title: 'Keep', createdAt: new Date(), updatedAt: new Date() },
  });
  const target = createSignal({ type: 'user', contents: 'Old' }).toDBMessage({
    threadId: 'thread',
    resourceId: 'owner',
  });
  await store.saveMessages({ messages: [target] });
  const replacement = createSignal({ type: 'user', contents: 'New' }).toDBMessage({
    threadId: 'thread',
    resourceId: 'owner',
  });
  return {
    memory,
    store,
    deleteVectors,
    input: { threadId: 'thread', resourceId: 'owner', fromMessageId: target.id, replacement },
  };
}
describe('strict correction recall cleanup', () => {
  it('cleans affected-thread message and observation indexes before committing', async () => {
    const { memory, store, deleteVectors, input } = await fixture();
    deleteVectors.mockImplementation(async () => {
      expect((await store.listMessagesById({ messageIds: [input.fromMessageId] })).messages).toHaveLength(1);
    });
    await memory.reviseThreadMessages(input);
    expect(deleteVectors.mock.calls).toEqual([
      [{ indexName: 'memory_messages', filter: { thread_id: 'thread' } }],
      [{ indexName: 'memory_observations_1536', filter: { thread_id: 'thread' } }],
    ]);
    expect((await store.listMessagesById({ messageIds: [input.fromMessageId] })).messages).toHaveLength(0);
    expect((await store.listMessagesById({ messageIds: [input.replacement.id] })).messages).toHaveLength(1);
  });
  it('propagates cleanup failure and leaves saved history unchanged', async () => {
    const { memory, store, deleteVectors, input } = await fixture();
    deleteVectors.mockRejectedValue(new Error('vector unavailable'));
    await expect(memory.reviseThreadMessages(input)).rejects.toThrow('vector unavailable');
    expect((await store.listMessagesById({ messageIds: [input.fromMessageId] })).messages).toHaveLength(1);
    expect((await store.listMessagesById({ messageIds: [input.replacement.id] })).messages).toHaveLength(0);
  });
  it('validates ownership before deleting any vector', async () => {
    const { memory, deleteVectors, input } = await fixture();
    await expect(memory.reviseThreadMessages({ ...input, resourceId: 'other' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(deleteVectors).not.toHaveBeenCalled();
  });
  it('checks native ownership after slow vector cleanup and before transcript commit', async () => {
    const { memory, store, deleteVectors, input } = await fixture();
    const beforeCommit = vi.fn(async () => {
      throw new Error('lease lost');
    });
    await expect(memory.reviseThreadMessages(input, { beforeCommit })).rejects.toThrow('lease lost');
    expect(deleteVectors).toHaveBeenCalledTimes(2);
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect((await store.listMessagesById({ messageIds: [input.fromMessageId] })).messages).toHaveLength(1);
  });
  it.each(['thread', 'resource'] as const)('resets only thread-derived buffering state for %s scope', async scope => {
    const { store } = await fixture();
    const engine = new ObservationalMemory({
      storage: store,
      scope,
      observation: { bufferTokens: false },
      reflection: { bufferActivation: false },
    });
    const keys = ['obs:thread:thread', 'refl:thread:thread', 'obs:thread:other', 'obs:resource:owner'];
    for (const key of keys) BufferingCoordinator.lastBufferedBoundary.set(key, 100);
    try {
      engine.resetThreadRevisionState('thread', 'owner');
      expect(BufferingCoordinator.lastBufferedBoundary.has(keys[0]!)).toBe(scope === 'resource');
      expect(BufferingCoordinator.lastBufferedBoundary.has(keys[1]!)).toBe(scope === 'resource');
      expect(BufferingCoordinator.lastBufferedBoundary.has(keys[2]!)).toBe(true);
      expect(BufferingCoordinator.lastBufferedBoundary.has(keys[3]!)).toBe(true);
    } finally {
      for (const key of keys) BufferingCoordinator.lastBufferedBoundary.delete(key);
    }
  });
  it('refuses unfinished thread buffering without clearing it or another thread', async () => {
    const { store } = await fixture();
    const engine = new ObservationalMemory({ storage: store, scope: 'thread' });
    const key = 'obs:thread:thread';
    BufferingCoordinator.asyncBufferingOps.set(key, new Promise(() => {}));
    try {
      expect(() => engine.assertThreadRevisionIdle('thread')).toThrow('Memory work must finish');
      expect(() => engine.assertThreadRevisionIdle('other')).not.toThrow();
      expect(BufferingCoordinator.asyncBufferingOps.has(key)).toBe(true);
    } finally {
      BufferingCoordinator.asyncBufferingOps.delete(key);
    }
  });
  it('refuses enabled shared observations before touching vectors or history', async () => {
    const { memory, store, deleteVectors, input } = await fixture();
    const shared = new Memory({
      storage: memory.storage,
      options: { observationalMemory: { scope: 'resource', observation: { bufferTokens: false } } },
    });
    await expect(shared.reviseThreadMessages(input)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(deleteVectors).not.toHaveBeenCalled();
    expect((await store.listMessagesById({ messageIds: [input.fromMessageId] })).messages).toHaveLength(1);
  });
});
