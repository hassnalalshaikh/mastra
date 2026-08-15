import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const toGenerator = (values: string[]) =>
    (async function* () {
      yield values.map((_, index) => [index + 1, index + 2, index + 3]);
    })();

  return {
    embed: vi.fn(toGenerator),
    passageEmbed: vi.fn(toGenerator),
    queryEmbedMany: vi.fn(toGenerator),
  };
});

vi.mock('./model-cache.js', () => ({
  getCachedModel: vi.fn(async () => mocks),
  warmupFastEmbedModels: vi.fn(async () => undefined),
}));

beforeEach(() => {
  mocks.embed.mockClear();
  mocks.passageEmbed.mockClear();
  mocks.queryEmbedMany.mockClear();
});

test('exposes role-specific multilingual E5 Large AI SDK v3 models', async () => {
  const { fastembed } = await import('./index.js');

  const queryResult = await fastembed.multilingualQuery.doEmbed({ values: ['بحث', 'search'] });
  const passageResult = await fastembed.multilingualPassage.doEmbed({ values: ['وثيقة', 'document'] });

  expect(fastembed.multilingualQuery.specificationVersion).toBe('v3');
  expect(fastembed.multilingualQuery.modelId).toBe('multilingual-e5-large-query');
  expect(fastembed.multilingualPassage.specificationVersion).toBe('v3');
  expect(fastembed.multilingualPassage.modelId).toBe('multilingual-e5-large-passage');
  expect(queryResult.embeddings).toEqual([
    [1, 2, 3],
    [2, 3, 4],
  ]);
  expect(passageResult.embeddings).toEqual([
    [1, 2, 3],
    [2, 3, 4],
  ]);
  expect(mocks.queryEmbedMany).toHaveBeenCalledWith(['بحث', 'search']);
  expect(mocks.passageEmbed).toHaveBeenCalledWith(['وثيقة', 'document']);
  expect(mocks.embed).not.toHaveBeenCalled();
});
