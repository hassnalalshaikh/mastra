import { randomUUID } from 'node:crypto';
import { createEmptyWorkflowSnapshot } from '@mastra/core/storage';
import type { WorkflowRunState } from '@mastra/core/workflows';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresStore } from '../../index';

describe('native checkpoint discovery projection', () => {
  const schemaName = `discovery_proof_${randomUUID().replaceAll('-', '')}`;
  const connectionString = process.env.DB_URL;
  let store: PostgresStore;
  let pool: Pool;

  beforeAll(async () => {
    if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) {
      throw new Error('This isolated test requires a local PostgreSQL connection');
    }
    pool = new Pool({ connectionString });
    store = new PostgresStore({ id: 'discovery-projection-proof', connectionString, schemaName });
    await store.init();
    const workflows = (await store.getStore('workflows'))!;
    for (const [runId, threadId, agentId, status] of [
      ['match', 'target', 'agent-a', 'running'],
      ['wrong-thread', 'other', 'agent-a', 'running'],
      ['wrong-agent', 'target', 'agent-b', 'running'],
      ['finished', 'target', 'agent-a', 'success'],
    ] as const) {
      const snapshot = createEmptyWorkflowSnapshot(runId);
      snapshot.status = status;
      snapshot.context.input = {
        agentId,
        messageListState: { memoryInfo: { threadId, resourceId: 'resource-a', ignored: 'not identity' } },
        requestContextEntries: { largeFixture: 'x'.repeat(8 * 1024 * 1024) },
      } as any;
      await workflows.persistWorkflowSnapshot({
        workflowName: 'durable-agentic-loop',
        runId,
        resourceId: 'resource-a',
        snapshot,
      });
    }
  }, 60000);

  afterAll(async () => {
    await store?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  }, 30000);

  it('returns only ownership and lifecycle fields with exact count and thread filtering', async () => {
    const workflows = (await store.getStore('workflows'))!;
    const listed = await workflows.listWorkflowRuns({
      workflowName: 'durable-agentic-loop',
      status: 'running',
      threadId: 'target',
      resourceId: 'resource-a',
      summary: true,
      page: 0,
      perPage: 1,
    });
    expect(listed.total).toBe(2);
    expect(listed.runs).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(listed))).toBeLessThan(2000);
    const snapshot = listed.runs[0]!.snapshot as WorkflowRunState;
    expect((snapshot.context.input as any).messageListState.memoryInfo).toEqual({
      threadId: 'target',
      resourceId: 'resource-a',
    });
    expect((snapshot.context.input as any).agentId).toMatch(/^agent-[ab]$/);
    expect((snapshot.context.input as any).requestContextEntries).toBeUndefined();
    const next = await workflows.listWorkflowRuns({
      workflowName: 'durable-agentic-loop',
      status: 'running',
      threadId: 'target',
      resourceId: 'resource-a',
      summary: true,
      page: 1,
      perPage: 1,
    });
    expect(next.total).toBe(2);
    expect(next.runs[0]!.runId).not.toBe(listed.runs[0]!.runId);
  });

  it('keeps complete execution state available through the native checkpoint load', async () => {
    const workflows = (await store.getStore('workflows'))!;
    const snapshot = await workflows.loadWorkflowSnapshot({ workflowName: 'durable-agentic-loop', runId: 'match' });
    expect((snapshot!.context.input as any).requestContextEntries.largeFixture.length).toBe(8 * 1024 * 1024);
  });
});
