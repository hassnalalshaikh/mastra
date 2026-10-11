import { describe, expect, it, vi } from 'vitest';
import type { MastraBrowser } from '../browser';
import { MockMemory } from '../memory/mock';
import { InMemoryStore } from '../storage/mock';
import { createTestAgent, createTestController } from './test-utils';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function browser() {
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    close,
    retire: vi.fn(() => close()),
    getActivityState: () => ({ activeOperations: 0 }),
  } as unknown as MastraBrowser;
}

async function fixture() {
  const storage = new InMemoryStore();
  const memory = new MockMemory({ storage });
  const agent = createTestAgent({ memory });
  const first = browser();
  const controller = createTestController({ storage, agent, browser: async () => first });
  await controller.init();
  const session = await controller.createSession({ resourceId: 'owner', scope: 'chat', threadId: 'thread' });
  await session.thread.create({ id: 'thread', title: 'Keep' });
  await session.recordMessage({ id: 'original', role: 'user', content: 'Old input', createdAt: new Date(1) });
  await session.recordMessage({ id: 'later', role: 'assistant', content: 'Old answer', createdAt: new Date(2) });
  return { controller, session, memory, agent, first };
}

describe('native browser replacement and saved input revision', () => {
  it('refuses provider replacement while an edit owns history persistence', async () => {
    const { controller, session, memory, first } = await fixture();
    const held = deferred();
    const settled = vi.spyOn(memory, 'settled').mockImplementation(async () => {
      await held.promise;
      throw new Error('edit stopped');
    });
    const edit = session.editMessage({ messageId: 'original', content: 'New input' });
    const rejected = expect(edit).rejects.toThrow('edit stopped');
    const next = vi.fn(async () => browser());
    try {
      await vi.waitFor(() => expect(settled).toHaveBeenCalled());
      await expect(controller.replaceSessionBrowser(session, { browser: next })).rejects.toThrow('active Session');
      expect(first.close).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await rejected;
      await controller.deleteSession({ resourceId: 'owner', scope: 'chat' });
    }
  });

  it('refuses an edit before storage while provider cleanup owns the session', async () => {
    const { controller, session, memory, first } = await fixture();
    const held = deferred();
    vi.mocked(first.close).mockImplementation(() => held.promise);
    const settled = vi.spyOn(memory, 'settled').mockRejectedValue(new Error('edit reached storage'));
    const replacement = controller.replaceSessionBrowser(session, { browser: async () => browser() });
    try {
      await vi.waitFor(() => expect(first.close).toHaveBeenCalled());
      await expect(session.editMessage({ messageId: 'original', content: 'New input' })).rejects.toMatchObject({
        code: 'BUSY',
      });
      expect(settled).not.toHaveBeenCalled();
      expect((await session.thread.listActiveMessages()).map(row => row.id)).toEqual(['original', 'later']);
    } finally {
      held.resolve();
      await replacement;
      await controller.deleteSession({ resourceId: 'owner', scope: 'chat' });
    }
  });

  it('supersedes pending queue startup and releases its edit-busy counter', async () => {
    const { controller, session, memory, agent } = await fixture();
    const held = deferred();
    const prepare = vi.spyOn(session.thread, 'ensureId').mockImplementation(async () => {
      await held.promise;
      return 'thread';
    });
    const dispatch = vi.spyOn(agent, 'queueMessage');
    const pending = session.queueMessage({ content: 'Pending input' });
    const rejected = expect(pending).rejects.toThrow('superseded message startup');
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
      await controller.replaceSessionBrowser(session, { browser: async () => browser() });
      held.resolve();
      await rejected;
      expect(dispatch).not.toHaveBeenCalled();
      expect(session.run.isRunning()).toBe(false);
      const settled = vi.spyOn(memory, 'settled').mockRejectedValue(new Error('idle edit reached storage'));
      await expect(session.editMessage({ messageId: 'original', content: 'New input' })).rejects.toThrow(
        'idle edit reached storage',
      );
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      held.resolve();
      await pending.catch(() => undefined);
      await controller.deleteSession({ resourceId: 'owner', scope: 'chat' });
    }
  });
});
