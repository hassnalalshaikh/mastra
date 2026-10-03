import { describe, expect, it, vi } from 'vitest';
import type { Mastra } from '../mastra';
import { InMemoryDB } from '../storage/domains/inmemory-db';
import type { Schedule } from '../storage/domains/schedules/base';
import { InMemorySchedulesStorage } from '../storage/domains/schedules/inmemory';
import { executeAgentSchedule } from './worker';

function row(maxRuns = 3): Schedule {
  return {
    id: 'agent_limit',
    target: { type: 'agent', agentId: 'a', prompt: 'check' },
    cron: '* * * * *',
    status: 'active',
    nextFireAt: 0,
    createdAt: 1,
    updatedAt: 1,
    maxRuns,
    runCount: 0,
    runClaims: [],
  };
}

describe('agent schedule dispatch budget', () => {
  it('admits exactly the cap across simultaneous claims and preserves it on store recreation', async () => {
    const db = new InMemoryDB();
    const store = new InMemorySchedulesStorage({ db });
    await store.createSchedule(row());
    const claims = await Promise.all(
      Array.from({ length: 30 }, (_, i) => store.claimAgentScheduleRun('agent_limit', `claim-${i}`, true)),
    );
    expect(claims.filter(Boolean)).toHaveLength(3);
    const recreated = new InMemorySchedulesStorage({ db });
    expect(await recreated.getSchedule('agent_limit')).toMatchObject({ runCount: 3, status: 'paused' });
    await recreated.updateSchedule('agent_limit', { status: 'active', metadata: { edited: true } });
    expect(await recreated.claimAgentScheduleRun('agent_limit', 'later', true)).toBe(false);
    await recreated.updateSchedule('agent_limit', { maxRuns: 4, status: 'active' });
    expect(await recreated.claimAgentScheduleRun('agent_limit', 'later', false)).toBe(true);
    expect(await recreated.getSchedule('agent_limit')).toMatchObject({ runCount: 4, status: 'paused' });
  });

  it('rejects duplicate claims and paused automatic fires without consuming a slot', async () => {
    const store = new InMemorySchedulesStorage({ db: new InMemoryDB() });
    await store.createSchedule(row());
    expect(await store.claimAgentScheduleRun('agent_limit', 'same', false)).toBe(true);
    expect(await store.claimAgentScheduleRun('agent_limit', 'same', true)).toBe(false);
    await store.updateSchedule('agent_limit', { status: 'paused' });
    expect(await store.claimAgentScheduleRun('agent_limit', 'paused', false)).toBe(false);
    expect(await store.getSchedule('agent_limit')).toMatchObject({ runCount: 1 });
  });

  it('enforces the cap before agent execution and does not refund failed attempts', async () => {
    const store = new InMemorySchedulesStorage({ db: new InMemoryDB() });
    const schedule = row(2);
    await store.createSchedule(schedule);
    const generate = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const onFinish = vi.fn();
    const mastra = {
      __getScheduleHooks: () => ({ onFinish }),
      getStorage: () => ({ getStore: async () => store }),
      getAgentById: () => ({ generate }),
      getLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
    } as unknown as Mastra;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        executeAgentSchedule(mastra, schedule.id, schedule.target as Extract<Schedule['target'], { type: 'agent' }>, {
          claimId: `run-${i}`,
          triggerKind: 'manual',
        }),
      ),
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(onFinish).toHaveBeenCalledTimes(8);
    expect(onFinish.mock.calls.every(([event]) => event.outcome === 'skipped')).toBe(true);
    expect(await store.getSchedule(schedule.id)).toMatchObject({ runCount: 2, status: 'paused' });
  });
});
