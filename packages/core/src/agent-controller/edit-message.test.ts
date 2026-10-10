import { describe, expect, it, vi } from 'vitest';
import { MockMemory } from '../memory/mock';
import { InMemoryStore } from '../storage/mock';
import { createTestAgent, createTestController } from './test-utils';

async function fixture() {
  const storage = new InMemoryStore();
  const memory = new MockMemory({ storage });
  const agent = createTestAgent({ memory });
  const controller = createTestController({ storage, agent, resourceId: 'owner' });
  await controller.init();
  const session = await controller.createSession({ id: 'session', ownerId: 'owner' });
  await session.thread.create({ id: 'thread', title: 'Keep' });
  await session.recordMessage({ id: 'original', role: 'user', content: 'Old input', createdAt: new Date(1) });
  await session.recordMessage({ id: 'later', role: 'assistant', content: 'Old answer', createdAt: new Date(2) });
  return { session, agent, memory, storage };
}
describe('Session.editMessage', () => {
  it('refuses a pending notification startup before rewriting', async () => {
    const { session } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const opening = vi.spyOn(session.thread, 'ensureId').mockImplementation(async () => {
      await held;
      throw new Error('setup stopped');
    });
    const notification = session.sendNotificationSignal({ source: 'test', kind: 'test', summary: 'Pending' });
    const rejected = expect(notification).rejects.toThrow('setup stopped');
    await vi.waitFor(() => expect(opening).toHaveBeenCalled());
    await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    release();
    await rejected;
    expect((await session.thread.listActiveMessages()).map(row => row.id)).toEqual(['original', 'later']);
  });
  it('refuses saved parked runs before rewriting', async () => {
    const { session, agent } = await fixture();
    vi.spyOn(agent, 'listSuspendedRuns').mockResolvedValue({ runs: [{ runId: 'parked' }] } as any);
    await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    expect(await session.thread.listActiveMessages()).toHaveLength(2);
  });
  it('saves new input before dispatch, retains it after delivery failure, and keeps the thread', async () => {
    const { session } = await fixture();
    const send = vi.spyOn(session, 'sendSignal').mockImplementation(input => {
      return { id: input.id!, type: 'user', accepted: Promise.reject(new Error('private provider information')) };
    });
    const result = await session.editMessage({ messageId: 'original', content: 'Corrected' });
    expect(result).toMatchObject({
      saved: true,
      accepted: false,
      threadId: 'thread',
      removedMessageIds: ['original', 'later'],
    });
    expect(result.deliveryError).not.toContain('private');
    expect(send).toHaveBeenCalledOnce();
    expect(session.thread.getId()).toBe('thread');
    const rows = await session.thread.listActiveMessages();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.messageId);
    expect(rows[0]!.content.parts).toEqual([{ type: 'text', text: 'Corrected' }]);
  });
  it('blocks duplicate edit, send, thread and resource switches during persistence', async () => {
    const { session, memory } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const settled = vi.spyOn(memory, 'settled').mockReturnValue(held);
    vi.spyOn(session, 'sendSignal').mockReturnValue({
      id: 'signal',
      type: 'user',
      accepted: Promise.resolve({ accepted: true, action: 'wake' }),
    });
    const edit = session.editMessage({ messageId: 'original', content: 'New' });
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    await expect(session.editMessage({ messageId: 'original', content: 'Duplicate' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    // The spy replaced the send boundary, so use the prototype to exercise its real gate.
    expect(() => Object.getPrototypeOf(session).sendSignal.call(session, { content: 'Concurrent' })).toThrow(
      'edit is in progress',
    );
    await expect(session.thread.switch({ threadId: 'other' })).rejects.toMatchObject({ code: 'BUSY' });
    expect(() => session.identity.setResourceId({ resourceId: 'other' })).toThrow('edit is in progress');
    release();
    expect(await edit).toMatchObject({ saved: true, accepted: true });
  });
  it('refuses a pending native send startup before rewriting', async () => {
    const { session } = await fixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const build = vi.spyOn(session.machinery, 'buildStreamOptions').mockImplementation(async () => {
      await held;
      throw new Error('setup stopped');
    });
    const send = session.sendSignal({ content: 'Pending' }, { requireDelivery: true });
    const rejection = expect(send.accepted).rejects.toThrow('setup stopped');
    await vi.waitFor(() => expect(build).toHaveBeenCalled());
    await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    expect((await session.thread.listActiveMessages()).map(row => row.id)).toEqual(['original', 'later']);
    release();
    await rejection;
  });
  it('refuses a pending thread transition before rewriting', async () => {
    const { session } = await fixture();
    session.beginMessageBinding();
    await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    session.endMessageBinding();
  });
  it('refuses another native thread owner and protects a held edit from native sends', async () => {
    const { session, agent } = await fixture();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const reservation = agent.withIdleThreadMutation({ threadId: 'thread', resourceId: 'owner' }, async () => {
      started();
      await held;
    });
    await ready;
    await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
      code: 'BUSY',
    });
    expect(() =>
      agent.sendSignal({ type: 'user', contents: 'Other' }, { threadId: 'thread', resourceId: 'owner' }),
    ).toThrow('edit is in progress');
    expect(() => agent.queueMessage('Other', { threadId: 'thread', resourceId: 'owner' })).toThrow(
      'edit is in progress',
    );
    release();
    await reservation;
    expect((await session.thread.listActiveMessages()).map(row => row.id)).toEqual(['original', 'later']);
  });
  it('fails closed for unsupported stores and non-user inputs', async () => {
    const { session, storage } = await fixture();
    await expect(session.editMessage({ messageId: 'later', content: 'New' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const store = (await storage.getStore('memory'))!;
    Object.defineProperty(store, 'supportsThreadMessageRevision', { value: false });
    await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    expect(await session.thread.listActiveMessages()).toHaveLength(2);
  });
  it.each(['denied', 'error', 'lost'])(
    'refuses %s native lease before saving and releases its reservation',
    async kind => {
      const { session, agent } = await fixture();
      let owner: string | undefined;
      const releaseLease = vi.fn(async (_key: string, value: string) => {
        if (owner === value) owner = undefined;
      });
      const provider = {
        acquireLease: vi.fn(async (_key: string, value: string) => {
          if (kind === 'error') throw new Error('offline');
          if (kind === 'denied') return { acquired: false, owner: 'remote' };
          owner = value;
          return { acquired: true, owner: value };
        }),
        getLeaseOwner: vi.fn(async () => (kind === 'lost' ? 'remote' : owner)),
        releaseLease,
        renewLease: vi.fn(async () => true),
        transferLease: vi.fn(async () => false),
      };
      const pubsub = agent.getPubSub();
      vi.spyOn(agent, 'getPubSub').mockReturnValue(
        Object.assign(Object.create(pubsub!), { getLeaseProvider: () => provider }),
      );
      await expect(session.editMessage({ messageId: 'original', content: 'New' })).rejects.toMatchObject({
        code: 'BUSY',
      });
      await vi.waitFor(() => expect(releaseLease).toHaveBeenCalled());
      expect(agent.getActiveThreadRunId({ threadId: 'thread', resourceId: 'owner' })).toBeUndefined();
      expect((await session.thread.listActiveMessages()).map(row => row.id)).toEqual(['original', 'later']);
    },
  );
});
