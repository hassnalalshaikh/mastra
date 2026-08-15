import { InMemoryStore } from '@mastra/core/storage';
import { expect, test, vi } from 'vitest';
import { Memory } from './index';

const embedMany = vi.hoisted(() =>
  vi.fn(
    async ({
      model,
      values,
    }: {
      model: { doEmbed: (input: { values: string[] }) => Promise<any> };
      values: string[];
    }) => {
      const result = await model.doEmbed({ values });
      return { embeddings: result.embeddings, usage: result.usage };
    },
  ),
);

vi.mock('@internal/ai-v6', () => ({ embedMany }));
vi.mock('@internal/ai-sdk-v5', () => ({ embedMany }));
vi.mock('@internal/ai-sdk-v4', () => ({ embedMany }));

test('uses passage embeddings for stored messages and query embeddings for recall', async () => {
  const passageEmbedder = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'passage-model',
    doEmbed: vi.fn(async () => ({ embeddings: [[1, 0]], warnings: [] })),
  } as any;
  const queryEmbedder = {
    specificationVersion: 'v3',
    provider: 'test',
    modelId: 'query-model',
    doEmbed: vi.fn(async () => ({ embeddings: [[0, 1]], warnings: [] })),
  } as any;
  const vector = {
    id: 'test-vector',
    createIndex: vi.fn().mockResolvedValue(undefined),
    upsert: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
  } as any;
  const memory = new Memory({
    storage: new InMemoryStore(),
    vector,
    embedder: passageEmbedder,
    queryEmbedder,
    options: { semanticRecall: { scope: 'thread' } },
  });
  const threadId = 'role-aware-thread';
  const resourceId = 'role-aware-resource';
  const content = 'the same text exercises role-aware cache keys';

  await memory.saveThread({
    thread: {
      id: threadId,
      resourceId,
      title: 'Role-aware retrieval',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await memory.saveMessages({
    messages: [
      {
        id: 'role-aware-message',
        role: 'user',
        threadId,
        resourceId,
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: 'text', text: content }] },
      },
    ],
  });
  await memory.recall({ threadId, resourceId, vectorSearchString: content });

  expect(passageEmbedder.doEmbed).toHaveBeenCalledWith({ values: [content] });
  expect(queryEmbedder.doEmbed).toHaveBeenCalledWith({ values: [content] });
  expect(vector.upsert).toHaveBeenCalledWith(expect.objectContaining({ vectors: [[1, 0]] }));
  expect(vector.query).toHaveBeenCalledWith(expect.objectContaining({ queryVector: [0, 1] }));
});
