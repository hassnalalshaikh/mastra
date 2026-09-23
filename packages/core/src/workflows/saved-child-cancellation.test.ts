import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { EventEmitterPubSub } from '../events/event-emitter';
import { Mastra } from '../mastra';
import { MockStore } from '../storage/mock';
import { createWorkflow } from './create';
import { createStep } from './workflow';
import { WorkflowEventProcessor } from './evented/workflow-event-processor';

const instances: Mastra[] = [];
afterEach(async () => {
  for (const mastra of instances.splice(0)) await mastra.shutdown();
});

function tree(storage: MockStore, mode: 'default' | 'evented' | 'mixed', after = vi.fn()) {
  const schema = z.object({ value: z.string() });
  const make = (id: string, evented = mode === 'evented') =>
    createWorkflow({
      id,
      inputSchema: schema,
      outputSchema: z.any(),
      ...(evented ? { schedule: [] } : {}),
    });
  const paused = createStep({
    id: 'pause',
    inputSchema: schema,
    outputSchema: schema,
    execute: async ({ suspend }) => {
      await suspend({ reason: 'test pause' });
      return { value: 'never' };
    },
  });
  const next = createStep({
    id: 'after',
    inputSchema: schema,
    outputSchema: schema,
    execute: async ({ inputData }) => {
      after();
      return inputData;
    },
  });
  const grandchild = make('grandchild').then(paused).then(next).commit();
  const child = make('child').then(grandchild).commit();
  const completed = make('completed')
    .then(
      createStep({
        id: 'done',
        inputSchema: schema,
        outputSchema: schema,
        execute: async ({ inputData }) => inputData,
      }),
    )
    .commit();
  const parent = make('parent', mode !== 'default')
    .parallel([child, completed])
    .commit();
  const unrelated = make('unrelated').then(paused).commit();
  const pubsub = new EventEmitterPubSub();
  const mastra = new Mastra({
    logger: false,
    storage,
    pubsub,
    workflows: { parent, unrelated },
  });
  instances.push(mastra);
  return { mastra, pubsub, parent, child, grandchild, completed, unrelated, after };
}

async function savedFixture(mode: 'default' | 'evented' | 'mixed') {
  const storage = new MockStore();
  const first = tree(storage, mode);
  await first.mastra.startWorkers();
  const parentRun = await first.parent.createRun({ runId: 'parent-run', resourceId: 'owner' });
  expect((await parentRun.start({ inputData: { value: 'input' } })).status).toBe('suspended');
  const unrelatedRun = await first.unrelated.createRun({ runId: 'unrelated-run', resourceId: 'other-owner' });
  expect((await unrelatedRun.start({ inputData: { value: 'unrelated' } })).status).toBe('suspended');
  const store = (await storage.getStore('workflows'))!;
  const parent = (await store.getWorkflowRunById({ workflowName: 'parent', runId: 'parent-run' }))!;
  const parentSnapshot = parent.snapshot as any;
  const childId = parentSnapshot.context.child.metadata?.nestedRunId ?? 'parent-run';
  const child = (await store.getWorkflowRunById({ workflowName: 'child', runId: childId }))!;
  const grandchildId = (child.snapshot as any).context.grandchild.metadata?.nestedRunId ?? childId;
  const completedId = parentSnapshot.context.completed.metadata?.nestedRunId ?? 'parent-run';
  const completedBefore = await store.getWorkflowRunById({ workflowName: 'completed', runId: completedId });
  const unrelatedBefore = await store.getWorkflowRunById({ workflowName: 'unrelated', runId: 'unrelated-run' });
  await first.mastra.shutdown();
  instances.splice(instances.indexOf(first.mastra), 1);
  const second = tree(storage, mode, first.after);
  await second.mastra.startWorkers();
  return { ...second, store, childId, grandchildId, completedId, completedBefore, unrelatedBefore };
}

describe('saved nested cancellation after restart', () => {
  it.each(['default', 'evented', 'mixed'] as const)(
    'cancels the saved %s parent, child and grandchild only',
    async mode => {
      const t = await savedFixture(mode);
      const run = await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' });
      await run.cancel();
      for (const [workflowName, runId] of [
        ['parent', 'parent-run'],
        ['child', t.childId],
        ['grandchild', t.grandchildId],
      ]) {
        expect((await t.store.loadWorkflowSnapshot({ workflowName, runId }))?.status).toBe('canceled');
      }
      expect(await t.store.getWorkflowRunById({ workflowName: 'completed', runId: t.completedId })).toEqual(
        t.completedBefore,
      );
      expect(await t.store.getWorkflowRunById({ workflowName: 'unrelated', runId: 'unrelated-run' })).toEqual(
        t.unrelatedBefore,
      );
      expect(t.after).not.toHaveBeenCalled();
      await Promise.all([run.cancel(), run.cancel()]);
      expect((await t.store.loadWorkflowSnapshot({ workflowName: 'grandchild', runId: t.grandchildId }))?.status).toBe(
        'canceled',
      );
    },
  );

  it('finishes descendant cancellation when the saved parent was already canceled', async () => {
    const t = await savedFixture('mixed');
    await t.store.updateWorkflowState({ workflowName: 'parent', runId: 'parent-run', opts: { status: 'canceled' } });
    await (await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel();
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'child', runId: t.childId }))?.status).toBe('canceled');
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'grandchild', runId: t.grandchildId }))?.status).toBe(
      'canceled',
    );
  });

  it('rejects incomplete child persistence instead of claiming cancellation succeeded', async () => {
    const t = await savedFixture('mixed');
    const update = t.store.updateWorkflowState.bind(t.store);
    vi.spyOn(t.store, 'updateWorkflowState').mockImplementation(async args => {
      if (args.workflowName === 'child' && args.opts.status === 'canceled') throw new Error('storage unavailable');
      return update(args);
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'storage unavailable',
    );
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'child', runId: t.childId }))?.status).toBe('suspended');
  });

  it.each([{ malformed: 123 }, { malformed: '' }, { malformed: ['valid', null] }])(
    'rejects malformed saved links %j',
    async ({ malformed }) => {
      const t = await savedFixture('mixed');
      const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))!;
      (snapshot.context.child as any).metadata = { nestedRunId: malformed };
      await t.store.persistWorkflowSnapshot({
        workflowName: 'parent',
        runId: 'parent-run',
        resourceId: 'owner',
        snapshot,
      });
      await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow();
      expect((await t.store.loadWorkflowSnapshot({ workflowName: 'child', runId: t.childId }))?.status).toBe(
        'suspended',
      );
    },
  );

  it('refuses a saved child owned by another resource', async () => {
    const t = await savedFixture('mixed');
    const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'child', runId: t.childId }))!;
    await t.store.persistWorkflowSnapshot({
      workflowName: 'child',
      runId: t.childId,
      resourceId: 'someone-else',
      snapshot,
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'ownership',
    );
  });

  it.each(['default', 'evented'] as const)('cancels saved foreach children with fresh %s definitions', async mode => {
    const storage = new MockStore();
    const make = (evented: boolean) => {
      const schema = z.object({ value: z.string() });
      const child = createWorkflow({
        id: 'item',
        inputSchema: schema,
        outputSchema: schema,
        ...(evented ? { schedule: [] } : {}),
      })
        .then(
          createStep({
            id: 'pause-item',
            inputSchema: schema,
            outputSchema: schema,
            execute: async ({ suspend }) => suspend({}),
          }),
        )
        .commit();
      const parent = createWorkflow({
        id: 'items',
        inputSchema: z.array(schema),
        outputSchema: z.array(schema),
        ...(evented ? { schedule: [] } : {}),
      })
        .foreach(child, { concurrency: 2 })
        .commit();
      const mastra = new Mastra({ logger: false, storage, pubsub: new EventEmitterPubSub(), workflows: { parent } });
      instances.push(mastra);
      return { mastra, parent };
    };
    const first = make(false);
    await first.mastra.startWorkers();
    const run = await first.parent.createRun({ runId: 'items-run', resourceId: 'owner' });
    expect((await run.start({ inputData: [{ value: 'one' }, { value: 'two' }] })).status).toBe('suspended');
    const store = (await storage.getStore('workflows'))!;
    const before = (await store.loadWorkflowSnapshot({ workflowName: 'items', runId: run.runId }))!;
    const invocations = (before.context.item as any).suspendPayload.__workflow_meta.foreachOutput;
    const ids = invocations.filter(Boolean).map((item: any) => item.metadata.nestedRunId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    await first.mastra.shutdown();
    instances.splice(instances.indexOf(first.mastra), 1);
    const second = make(mode === 'evented');
    await second.mastra.startWorkers();
    await (await second.parent.createRun({ runId: run.runId, resourceId: 'owner' })).cancel();
    for (const runId of ids)
      expect((await store.loadWorkflowSnapshot({ workflowName: 'item', runId }))?.status).toBe('canceled');
  });

  it('rejects a missing saved child without creating a replacement run', async () => {
    const t = await savedFixture('mixed');
    await t.store.deleteWorkflowRunById({ workflowName: 'child', runId: t.childId });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'ownership',
    );
    expect(await t.store.getWorkflowRunById({ workflowName: 'child', runId: t.childId })).toBeNull();
  });

  it('rejects unavailable child reads before claiming a terminal result', async () => {
    const t = await savedFixture('mixed');
    const read = t.store.getWorkflowRunById.bind(t.store);
    vi.spyOn(t.store, 'getWorkflowRunById').mockImplementation(async args => {
      if (args.workflowName === 'child') throw new Error('read unavailable');
      return read(args);
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'read unavailable',
    );
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))?.status).toBe(
      'suspended',
    );
  });

  it('rejects a missing runtime definition rather than following a foreign saved link', async () => {
    const t = await savedFixture('mixed');
    const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))!;
    const graph = snapshot.serializedStepGraph as any;
    graph[0].steps[0].workflowId = 'unrelated';
    await t.store.persistWorkflowSnapshot({
      workflowName: 'parent',
      runId: 'parent-run',
      resourceId: 'owner',
      snapshot,
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'unavailable',
    );
    expect(await t.store.getWorkflowRunById({ workflowName: 'unrelated', runId: 'unrelated-run' })).toEqual(
      t.unrelatedBefore,
    );
  });

  it('reports native event publication failure on a reconstructed run', async () => {
    const t = await savedFixture('evented');
    const publish = t.pubsub.publish.bind(t.pubsub);
    vi.spyOn(t.pubsub, 'publish').mockImplementation(async (topic, event) => {
      if (topic === 'workflows' && event.type === 'workflow.cancel') throw new Error('cancel delivery unavailable');
      return publish(topic, event);
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'cancel delivery unavailable',
    );
  });

  it('delivers one native command for an already canceled parent and repeated concurrent calls', async () => {
    const t = await savedFixture('evented');
    await t.store.updateWorkflowState({ workflowName: 'parent', runId: 'parent-run', opts: { status: 'canceled' } });
    const publish = vi.spyOn(t.pubsub, 'publish');
    const run = await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' });
    await Promise.all([run.cancel(), run.cancel()]);
    await run.cancel();
    const deliveries = publish.mock.calls.filter(
      ([topic, event]) => topic === 'workflows' && event.type === 'workflow.cancel' && event.runId === 'parent-run',
    );
    expect(deliveries).toHaveLength(1);
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'grandchild', runId: t.grandchildId }))?.status).toBe(
      'canceled',
    );
  });

  it('retries failed native delivery only when another explicit cancel is called', async () => {
    const t = await savedFixture('evented');
    const publish = t.pubsub.publish.bind(t.pubsub);
    let deliveries = 0;
    vi.spyOn(t.pubsub, 'publish').mockImplementation(async (topic, event) => {
      if (topic === 'workflows' && event.type === 'workflow.cancel' && event.runId === 'parent-run') {
        deliveries++;
        if (deliveries === 1) throw new Error('delivery failed');
      }
      return publish(topic, event);
    });
    const run = await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' });
    await expect(run.cancel()).rejects.toThrow('delivery failed');
    expect(deliveries).toBe(1);
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: run.runId }))?.status).toBe('canceled');
    await run.cancel();
    expect(deliveries).toBe(2);
    await run.cancel();
    expect(deliveries).toBe(2);
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'grandchild', runId: t.grandchildId }))?.status).toBe(
      'canceled',
    );
  });

  it.each(['default', 'evented'] as const)('preserves terminal skipped and bailed %s runs', async mode => {
    const t = await savedFixture(mode);
    const publish = vi.spyOn(t.pubsub, 'publish');
    for (const status of ['skipped', 'bailed'] as const) {
      await t.store.updateWorkflowState({ workflowName: 'parent', runId: 'parent-run', opts: { status } });
      await (await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel();
      expect((await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))?.status).toBe(
        status,
      );
    }
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'child', runId: t.childId }))?.status).toBe('suspended');
    expect(publish.mock.calls.some(([topic, event]) => topic === 'workflows' && event.type === 'workflow.cancel')).toBe(
      false,
    );
  });

  it('refuses active foreach records with no saved child identity', async () => {
    const t = await savedFixture('mixed');
    const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))!;
    const entry = (snapshot.serializedStepGraph[0] as any).steps[0];
    snapshot.serializedStepGraph = [{ type: 'foreach', step: entry }] as any;
    (snapshot.context.child as any).metadata = {};
    await t.store.persistWorkflowSnapshot({
      workflowName: 'parent',
      runId: 'parent-run',
      resourceId: 'owner',
      snapshot,
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'link is missing',
    );
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))?.status).toBe(
      'suspended',
    );
  });

  it.each([
    ['default', 'skipped'],
    ['default', 'bailed'],
    ['evented', 'skipped'],
    ['evented', 'bailed'],
  ] as const)('cancels active siblings of a %s %s child without a saved run', async (mode, status) => {
    const t = await savedFixture(mode);
    const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))!;
    snapshot.context.completed = { status } as any;
    await t.store.persistWorkflowSnapshot({
      workflowName: 'parent',
      runId: 'parent-run',
      resourceId: 'owner',
      snapshot,
    });
    await t.store.deleteWorkflowRunById({ workflowName: 'completed', runId: t.completedId });
    await (await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel();
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))?.status).toBe(
      'canceled',
    );
    expect((await t.store.loadWorkflowSnapshot({ workflowName: 'grandchild', runId: t.grandchildId }))?.status).toBe(
      'canceled',
    );
    expect(await t.store.getWorkflowRunById({ workflowName: 'completed', runId: t.completedId })).toBeNull();
  });

  it('deduplicates repeated saved child links', async () => {
    const t = await savedFixture('mixed');
    const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'parent', runId: 'parent-run' }))!;
    (snapshot.context.child as any).metadata.nestedRunId = [t.childId, t.childId];
    await t.store.persistWorkflowSnapshot({
      workflowName: 'parent',
      runId: 'parent-run',
      resourceId: 'owner',
      snapshot,
    });
    const update = vi.spyOn(t.store, 'updateWorkflowState');
    await (await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel();
    expect(
      update.mock.calls.filter(([args]) => args.workflowName === 'child' && args.opts.status === 'canceled'),
    ).toHaveLength(1);
  });

  it('rejects cyclic saved child links without recursing forever', async () => {
    const t = await savedFixture('mixed');
    const snapshot = (await t.store.loadWorkflowSnapshot({ workflowName: 'grandchild', runId: t.grandchildId }))!;
    snapshot.serializedStepGraph = [{ type: 'workflow', id: 'parent', workflowId: 'parent' }] as any;
    snapshot.context = { parent: { status: 'suspended', metadata: { nestedRunId: 'parent-run' } } } as any;
    (t.grandchild.steps as any).parent = t.parent;
    await t.store.persistWorkflowSnapshot({
      workflowName: 'grandchild',
      runId: t.grandchildId,
      resourceId: 'owner',
      snapshot,
    });
    await expect((await t.parent.createRun({ runId: 'parent-run', resourceId: 'owner' })).cancel()).rejects.toThrow(
      'Cyclic',
    );
    expect(await t.store.getWorkflowRunById({ workflowName: 'unrelated', runId: 'unrelated-run' })).toEqual(
      t.unrelatedBefore,
    );
  });
});

class CancellationProcessor extends WorkflowEventProcessor {
  cancel(args: any) {
    return this.processWorkflowCancel(args);
  }
}

describe('delayed native cancellation', () => {
  it.each([false, true])(
    'preserves completed storage and avoids false finish events (completion race: %s)',
    async race => {
      const t = await savedFixture('evented');
      const args = {
        workflowId: 'completed',
        runId: t.completedId,
        stepResults: {},
        executionPath: [],
        activeStepsPath: {},
      };
      if (race)
        await t.store.updateWorkflowState({
          workflowName: 'completed',
          runId: t.completedId,
          opts: { status: 'running' },
        });
      const update = t.store.updateWorkflowState.bind(t.store);
      vi.spyOn(t.store, 'updateWorkflowState').mockImplementation(async options => {
        if (race && options.workflowName === 'completed' && options.opts.status === 'canceled') {
          await t.store.persistWorkflowSnapshot({
            workflowName: 'completed',
            runId: t.completedId,
            resourceId: 'owner',
            snapshot: t.completedBefore!.snapshot as any,
          });
        }
        return update(options);
      });
      const publish = vi.spyOn(t.pubsub, 'publish');
      await new CancellationProcessor({ mastra: t.mastra }).cancel(args);
      expect((await t.store.loadWorkflowSnapshot({ workflowName: 'completed', runId: t.completedId }))?.status).toBe(
        'success',
      );
      expect(publish.mock.calls.some(([topic, event]) => topic === 'workflows' && event.type === 'workflow.end')).toBe(
        false,
      );
    },
  );
});
