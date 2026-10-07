import { describe, expect, it, vi } from 'vitest';
import { PromptBlocksPG } from '.';
import type { DbClient } from '../../db';

describe('prompt initial-create cleanup ownership', () => {
  it('does not delete the winner when two requests create the same draft', async () => {
    let inserts = 0;
    const none = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) {
        if (inserts++) throw new Error('duplicate key value');
      } else if (sql.startsWith('DELETE')) throw new Error('Loser tried to delete winner');
    });
    const store = new PromptBlocksPG({ client: { none } as unknown as DbClient });
    vi.spyOn(store, 'createVersion').mockImplementation(async version => ({ ...version, createdAt: new Date() }));
    const results = await Promise.allSettled([0, 1].map(() => store.create({
      promptBlock: { id: 'shared', name: 'Shared', content: 'Keep winner' },
    })));
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(none.mock.calls.filter(([sql]) => sql.startsWith('DELETE'))).toHaveLength(0);
  });

  it('still cleans up its own thin draft if initial version creation fails', async () => {
    const none = vi.fn(async (_sql: string) => {});
    const store = new PromptBlocksPG({ client: { none } as unknown as DbClient });
    vi.spyOn(store, 'createVersion').mockRejectedValue(new Error('Version failed'));
    await expect(store.create({ promptBlock: { id: 'own', name: 'Own', content: 'Draft' } })).rejects.toThrow();
    expect(none).toHaveBeenCalledTimes(2);
    expect(none.mock.calls[1][0]).toContain('DELETE FROM');
  });

  it('cleans up its own draft when the actual native version write wraps the database failure', async () => {
    const none = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO') && sql.includes('mastra_prompt_block_versions')) {
        throw new Error('Version database write failed');
      }
    });
    const store = new PromptBlocksPG({ client: { none } as unknown as DbClient });
    await expect(store.create({ promptBlock: { id: 'wrapped', name: 'Wrapped', content: 'Draft' } })).rejects.toThrow();
    expect(none).toHaveBeenCalledTimes(3);
    expect(none.mock.calls[2][0]).toContain('DELETE FROM');
  });
});
