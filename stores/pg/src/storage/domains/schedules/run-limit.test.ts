import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulesPG } from './index';

// Uses only a unique private schema on a loopback test database.
describe('persistent schedule run limit', () => {
  const schemaName = `heartbeat_test_${randomUUID().replaceAll('-', '')}`;
  const config = {
    host: '127.0.0.1',
    port: Number(process.env.POSTGRES_PORT || 5434),
    database: 'postgres',
    user: 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
  };
  let pool = new Pool(config);
  let store: SchedulesPG;
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schemaName}"`);
    store = new SchedulesPG({ pool, schemaName });
    await store.init();
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.end();
  });
  it('atomically caps concurrent attempts and keeps the budget after reconnect and edits', async () => {
    await store.createSchedule({
      id: 'agent_limit',
      target: { type: 'agent', agentId: 'a', prompt: 'check' },
      cron: '* * * * *',
      status: 'active',
      nextFireAt: 0,
      createdAt: 1,
      updatedAt: 1,
      maxRuns: 3,
    });
    const accepted = await Promise.all(
      Array.from({ length: 30 }, (_, i) => store.claimAgentScheduleRun('agent_limit', `claim-${i}`, true)),
    );
    expect(accepted.filter(Boolean)).toHaveLength(3);
    await pool.end();
    pool = new Pool(config);
    store = new SchedulesPG({ pool, schemaName });
    await store.init();
    expect(await store.getSchedule('agent_limit')).toMatchObject({ runCount: 3, maxRuns: 3, status: 'paused' });
    await store.updateSchedule('agent_limit', { status: 'active', metadata: { changed: true } });
    expect(await store.claimAgentScheduleRun('agent_limit', 'late', true)).toBe(false);
    await store.updateSchedule('agent_limit', { maxRuns: 4, status: 'active' });
    expect(await store.claimAgentScheduleRun('agent_limit', 'claim-0', true)).toBe(false);
    expect(await store.claimAgentScheduleRun('agent_limit', 'late', false)).toBe(true);
    expect(await store.getSchedule('agent_limit')).toMatchObject({ runCount: 4, status: 'paused' });
    await store.deleteSchedule('agent_limit');
    expect(await store.claimAgentScheduleRun('agent_limit', 'deleted', true)).toBe(false);
  });
});
