import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from '@mastra/core/agent';
import type { MastraDBMessage } from '@mastra/core/memory';
import { PostgresStore } from '.';

const schema = `edit_${Math.random().toString(36).slice(2, 10)}`;
const store = new PostgresStore({
  id: 'edit-proof',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT) || 5434,
  database: process.env.POSTGRES_DB || 'postgres',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  schemaName: schema,
});
const row = (id: string, at: number, role: MastraDBMessage['role'] = 'user'): MastraDBMessage => ({
  id,
  role,
  threadId: 'thread',
  resourceId: 'owner',
  type: 'v2',
  createdAt: new Date(at),
  content: { format: 2, parts: [{ type: 'text', text: id }] },
});
const memory = store.stores.memory!;
async function seed(count = 130) {
  await memory.saveThread({
    thread: {
      id: 'thread',
      resourceId: 'owner',
      title: 'Keep',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: { workingMemory: 'old', setting: true },
    },
  });
  await memory.saveMessages({
    messages: Array.from({ length: count }, (_, i) => row(`m${String(i).padStart(3, '0')}`, i * 1000)),
  });
  await memory.saveResource({
    resource: { id: 'owner', workingMemory: 'Keep resource', createdAt: new Date(), updatedAt: new Date() },
  });
  await memory.initializeObservationalMemory({ threadId: 'thread', resourceId: 'owner', scope: 'thread', config: {} });
  await memory.initializeObservationalMemory({ threadId: null, resourceId: 'owner', scope: 'resource', config: {} });
}
const edit = (fromMessageId: string, replacement = row('new', 200000), resourceId = 'owner') =>
  memory.reviseThreadMessages({ threadId: 'thread', resourceId, fromMessageId, replacement });

describe('Postgres atomic input revision', () => {
  it('preserves the baseline refusal to save messages without a saved thread', async () => {
    await expect(memory.saveMessages({ messages: [row('missing-thread', 1000)] })).rejects.toThrow('Thread thread not found');
  });
  beforeAll(async () => {
    await store.init();
  }, 30000);
  beforeEach(async () => {
    await memory.dangerouslyClearAll();
  });
  afterAll(async () => {
    try { await store.db.none(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await store.close(); }
  });
  it.each([0, 65, 129])('rewrites full 130-row suffix at %i and retains resource memory', async i => {
    await seed();
    const replacement = createSignal({
      type: 'user',
      contents: [
        { type: 'text', text: 'New' },
        { type: 'file', mediaType: 'text/plain', filename: 'a.txt', data: 'data:text/plain;base64,QQ==' },
      ],
    }).toDBMessage({ threadId: 'thread', resourceId: 'owner' });
    expect((await edit(`m${String(i).padStart(3, '0')}`, replacement)).removedMessageIds).toHaveLength(130 - i);
    expect((await memory.listMessages({ threadId: 'thread', perPage: false })).messages).toHaveLength(i + 1);
    expect(await memory.getThreadById({ threadId: 'thread' })).toMatchObject({
      title: 'Keep',
      metadata: { setting: true },
    });
    expect((await memory.getThreadById({ threadId: 'thread' }))!.metadata).not.toHaveProperty('workingMemory');
    expect((await memory.getResourceById({ resourceId: 'owner' }))!.workingMemory).toBe('Keep resource');
    expect(await memory.getObservationalMemory('thread', 'owner')).toBeNull();
    expect(await memory.getObservationalMemory(null, 'owner')).not.toBeNull();
    expect((await memory.listMessagesById({ messageIds: [replacement.id] })).messages[0]!.content.parts).toEqual(
      replacement.content.parts,
    );
  });
  it('matches current history order at equal timestamps', async () => {
    await seed(0);
    await memory.saveMessages({ messages: ['c', 'A', 'b', 'a'].map(id => row(id, 1000)) });
    const before = (await memory.listMessages({ threadId: 'thread', perPage: false })).messages.map(m => m.id);
    const selected = before[1]!;
    const result = await edit(selected);
    expect(result.removedMessageIds.sort()).toEqual(before.slice(1).sort());
  });
  it.each(['owner', 'thread', 'non-user', 'collision', 'missing'])(
    'rejects %s without changing history',
    async kind => {
      await seed(3);
      if (kind === 'non-user') await memory.saveMessages({ messages: [row('m001', 1000, 'assistant')] });
      const before = await memory.listMessages({ threadId: 'thread', perPage: false });
      const revision =
        kind === 'thread'
          ? memory.reviseThreadMessages({
              threadId: 'other',
              resourceId: 'owner',
              fromMessageId: 'm001',
              replacement: row('new', 200000),
            })
          : edit(
              kind === 'missing' ? 'absent' : 'm001',
              row(kind === 'collision' ? 'm000' : 'new', 200000),
              kind === 'owner' ? 'other' : 'owner',
            );
      await expect(revision).rejects.toThrow();
      expect((await memory.listMessages({ threadId: 'thread', perPage: false })).messages).toEqual(before.messages);
    },
  );
  it('rolls back deletes when replacement insert fails', async () => {
    await seed(3);
    await store.db.none(`ALTER TABLE ${schema}.mastra_messages ADD CONSTRAINT reject_new CHECK (id <> 'new')`);
    try {
      await expect(edit('m001')).rejects.toThrow();
      expect((await memory.listMessages({ threadId: 'thread', perPage: false })).messages.map(m => m.id)).toEqual([
        'm000',
        'm001',
        'm002',
      ]);
      expect((await memory.getThreadById({ threadId: 'thread' }))!.metadata!.workingMemory).toBe('old');
    } finally {
      await store.db.none(`ALTER TABLE ${schema}.mastra_messages DROP CONSTRAINT reject_new`);
    }
  });
  it('waits for a pending native save on the same thread and includes its suffix', async () => {
    await seed(3);
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const locked = new Promise<void>(resolve => {
      ready = resolve;
    });
    const tx = store.db.tx.bind(store.db);
    let intercept = true;
    const spy = vi.spyOn(store.db, 'tx').mockImplementation((async (callback: any) =>
      tx(async transaction => {
        if (intercept) {
          intercept = false;
          const one = transaction.one.bind(transaction);
          transaction.one = (async (sql: string, params: any) => {
            const result = await one(sql, params);
            if (sql.includes('mastra_threads') && sql.includes('FOR UPDATE')) {
              ready();
              await held;
            }
            return result;
          }) as typeof transaction.one;
        }
        return callback(transaction);
      })) as typeof store.db.tx);
    const pending = memory.saveMessages({ messages: [row('pending', 3000, 'assistant')] });
    try {
      await locked;
      const revision = edit('m001');
      release();
      await pending;
      expect((await revision).removedMessageIds.sort()).toEqual(['m001', 'm002', 'pending']);
    } finally {
      release();
      spy.mockRestore();
      await pending;
    }
  });
});
