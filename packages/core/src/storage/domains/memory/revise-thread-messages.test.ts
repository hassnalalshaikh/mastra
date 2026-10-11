import { describe, expect, it } from 'vitest';
import { createSignal } from '../../../agent/signals';
import type { MastraDBMessage } from '../../../memory/types';
import { InMemoryDB } from '../inmemory-db';
import { InMemoryMemory } from './inmemory';

const message = (id: string, minute: number, role: MastraDBMessage['role'] = 'user'): MastraDBMessage => ({
  id,
  threadId: 'thread',
  resourceId: 'owner',
  role,
  type: 'v2',
  createdAt: new Date(minute * 60000),
  content: { format: 2, parts: [{ type: 'text', text: id }] },
});
async function fixture(count = 130) {
  const db = new InMemoryDB();
  const memory = new InMemoryMemory({ db });
  await memory.saveThread({
    thread: {
      id: 'thread',
      resourceId: 'owner',
      title: 'Keep title',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { workingMemory: 'stale', preference: true },
    },
  });
  await memory.saveMessages({
    messages: Array.from({ length: count }, (_, index) => message(`m${String(index).padStart(3, '0')}`, index)),
  });
  db.resources.set('owner', {
    id: 'owner',
    workingMemory: 'Keep resource',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await memory.initializeObservationalMemory({ threadId: 'thread', resourceId: 'owner', scope: 'thread' });
  await memory.initializeObservationalMemory({ threadId: null, resourceId: 'owner', scope: 'resource' });
  return { db, memory };
}
describe('atomic saved input revision', () => {
  it('accepts native legacy user-message signals and refuses system signals', async () => {
    const { memory } = await fixture(0);
    const target = {
      ...message('legacy', 1, 'signal'),
      content: {
        format: 2 as const,
        parts: [{ type: 'text' as const, text: 'Legacy' }],
        metadata: { signal: { type: 'user-message' } },
      },
    };
    await memory.saveMessages({ messages: [target] });
    await expect(
      memory.reviseThreadMessages({
        threadId: 'thread',
        resourceId: 'owner',
        fromMessageId: 'legacy',
        replacement: message('new', 2),
      }),
    ).resolves.toEqual({ removedMessageIds: ['legacy'] });
    await memory.saveMessages({
      messages: [
        { ...target, id: 'system', content: { ...target.content, metadata: { signal: { type: 'system-reminder' } } } },
      ],
    });
    await expect(
      memory.reviseThreadMessages({
        threadId: 'thread',
        resourceId: 'owner',
        fromMessageId: 'system',
        replacement: message('other', 3),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it.each([0, 65, 129])('revises the full 130-row suffix from %i without cloning', async index => {
    const { db, memory } = await fixture();
    const replacement = createSignal({
      type: 'user',
      contents: [
        { type: 'text', text: 'Corrected' },
        { type: 'file', data: 'data:text/plain;base64,QQ==', mediaType: 'text/plain', filename: 'a.txt' },
      ],
    }).toDBMessage({ threadId: 'thread', resourceId: 'owner' });
    const result = await memory.reviseThreadMessages({
      threadId: 'thread',
      resourceId: 'owner',
      fromMessageId: `m${String(index).padStart(3, '0')}`,
      replacement,
    });
    expect(result.removedMessageIds).toHaveLength(130 - index);
    expect(db.messages.size).toBe(index + 1);
    expect(db.threads.size).toBe(1);
    expect(db.threads.get('thread')).toMatchObject({ title: 'Keep title', metadata: { preference: true } });
    expect(db.threads.get('thread')!.metadata).not.toHaveProperty('workingMemory');
    expect(db.resources.get('owner')!.workingMemory).toBe('Keep resource');
    expect(await memory.getObservationalMemory('thread', 'owner')).toBeNull();
    expect(await memory.getObservationalMemory(null, 'owner')).not.toBeNull();
    expect((await memory.listMessagesById({ messageIds: [replacement.id] })).messages[0]!.content.parts).toEqual(
      replacement.content.parts,
    );
  });
  it('uses id ordering to break timestamp ties', async () => {
    const { db, memory } = await fixture(0);
    await memory.saveMessages({ messages: ['c', 'a', 'b'].map(id => message(id, 1)) });
    await memory.reviseThreadMessages({
      threadId: 'thread',
      resourceId: 'owner',
      fromMessageId: 'b',
      replacement: message('new', 2),
    });
    expect([...db.messages.keys()].sort()).toEqual(['a', 'new']);
  });
  it.each(['wrong-owner', 'wrong-thread', 'non-user', 'collision', 'missing'])(
    'rejects %s without partial mutation',
    async failure => {
      const { db, memory } = await fixture(3);
      if (failure === 'non-user') await memory.saveMessages({ messages: [message('m001', 1, 'assistant')] });
      const before = JSON.stringify([...db.messages]);
      await expect(
        memory.reviseThreadMessages({
          threadId: failure === 'wrong-thread' ? 'other' : 'thread',
          resourceId: failure === 'wrong-owner' ? 'other' : 'owner',
          fromMessageId: failure === 'missing' ? 'absent' : 'm001',
          replacement: message(failure === 'collision' ? 'm000' : 'new', 4),
        }),
      ).rejects.toThrow();
      expect(JSON.stringify([...db.messages])).toBe(before);
      expect(db.threads.get('thread')!.metadata!.workingMemory).toBe('stale');
    },
  );
});
