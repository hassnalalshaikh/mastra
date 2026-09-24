/**
 * Tests for `Mastra.restartAllActiveWorkflowRuns()` — boot-time recovery of
 * workflow runs orphaned by a process restart.
 *
 * Pins these behaviors:
 * 1. Any workflow can opt out of generic auto-restart via
 *    `options.autoRestartActiveRuns: false`.
 * 2. Evented workflows (every scheduled workflow) are restarted only when they
 *    opt in with `options.autoRestartActiveRuns: true`; a run left `running`
 *    by a lost process then completes.
 * 3. `optedInOnly` restarts only opted-in workflows; default-engine behavior of
 *    the generic sweep is unchanged.
 * 4. `recovery.workflows: 'auto'` runs the opted-in sweep once workers start.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { EventEmitterPubSub } from '../events/event-emitter';
import type { WorkflowRuns } from '../storage';
import { MockStore } from '../storage/mock';
import { createEmptyWorkflowSnapshot } from '../storage/workflow-snapshot';
import { createWorkflow } from '../workflows';
import type { Workflow, WorkflowRunStatus } from '../workflows';
import { createStep as createEventedStep, createWorkflow as createEventedWorkflow } from '../workflows/evented';
import { Mastra } from './index';

function createWorkflowRun(
  workflowName: string,
  runId: string,
  status: WorkflowRunStatus,
): WorkflowRuns['runs'][number] {
  return {
    workflowName,
    runId,
    snapshot: {
      ...createEmptyWorkflowSnapshot(runId),
      status,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Stub a workflow to report one active run and observe restart attempts. */
function stubActiveRun(workflow: Workflow<any, any, any, any, any, any>, runId: string) {
  const listActiveWorkflowRuns = vi.spyOn(workflow, 'listActiveWorkflowRuns').mockResolvedValue({
    runs: [createWorkflowRun(workflow.id, runId, 'running')],
    total: 1,
  });
  const restart = vi.fn().mockResolvedValue(undefined);
  const createRun = vi.spyOn(workflow, 'createRun').mockResolvedValue({ restart } as any);
  return { listActiveWorkflowRuns, createRun, restart };
}

/** A two-step evented workflow whose step calls are observable. */
function createTwoStepEventedWorkflow(id: string, options?: { autoRestartActiveRuns?: boolean }) {
  const first = vi.fn(async ({ inputData }: any) => ({ value: inputData.value + 10 }));
  const second = vi.fn(async ({ inputData }: any) => ({ value: inputData.value * 2 }));
  const step1 = createEventedStep({
    id: 'step1',
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    execute: first,
  });
  const step2 = createEventedStep({
    id: 'step2',
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    execute: second,
  });
  const workflow = createEventedWorkflow({
    id,
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    ...(options ? { options } : {}),
  })
    .then(step1)
    .then(step2)
    .commit();
  return { workflow, first, second };
}

const MINUTE = 60_000;

/**
 * Persist the snapshot a lost process leaves behind: step1 done, step2 still
 * running. `ageMs` is how long ago the run was created and last updated.
 */
async function persistOrphanedRun(
  mastra: Mastra,
  workflow: Workflow<any, any, any, any, any, any>,
  runId: string,
  ageMs = 0,
) {
  const workflowsStore = await mastra.getStorage()!.getStore('workflows');
  const at = new Date(Date.now() - ageMs);
  await workflowsStore!.persistWorkflowSnapshot({
    workflowName: workflow.id,
    runId,
    createdAt: at,
    updatedAt: at,
    snapshot: {
      runId,
      status: 'running',
      activePaths: [1],
      activeStepsPath: { step2: [1] },
      value: {},
      context: {
        input: { value: 5 },
        step1: {
          payload: { value: 5 },
          startedAt: Date.now(),
          status: 'success',
          output: { value: 15 },
          endedAt: Date.now(),
        },
        step2: {
          payload: { value: 15 },
          startedAt: Date.now(),
          status: 'running',
        },
      } as any,
      serializedStepGraph: (workflow as any).serializedStepGraph,
      suspendedPaths: {},
      waitingPaths: {},
      resumeLabels: {},
      timestamp: Date.now(),
    } as any,
  });
}

async function loadStatus(mastra: Mastra, workflowName: string, runId: string) {
  const workflowsStore = await mastra.getStorage()!.getStore('workflows');
  const snapshot = await workflowsStore!.loadWorkflowSnapshot({ workflowName, runId });
  return snapshot?.status;
}

describe('Mastra.restartAllActiveWorkflowRuns', () => {
  let mastra: Mastra | undefined;

  afterEach(async () => {
    await mastra?.stopWorkers();
    mastra = undefined;
    vi.restoreAllMocks();
  });

  it('skips workflows that opt out via options.autoRestartActiveRuns', async () => {
    const optedOutWorkflow = createWorkflow({
      id: 'opted-out-wf',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      options: { autoRestartActiveRuns: false },
    }).commit();
    const defaultWorkflow = createWorkflow({
      id: 'default-wf',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    }).commit();

    mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      workflows: { optedOutWorkflow, defaultWorkflow },
    });

    const optedOut = stubActiveRun(optedOutWorkflow, 'opted-out-run-1');
    const restarted = stubActiveRun(defaultWorkflow, 'default-run-1');

    await mastra.restartAllActiveWorkflowRuns();

    expect(restarted.createRun).toHaveBeenCalledTimes(1);
    expect(restarted.restart).toHaveBeenCalledTimes(1);

    expect(optedOut.createRun).not.toHaveBeenCalled();
    expect(optedOut.restart).not.toHaveBeenCalled();
  });

  it('includes evented workflows only when they opt in; default-engine workflows are unchanged', async () => {
    const defaultWorkflow = createWorkflow({
      id: 'default-wf',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    }).commit();
    const { workflow: optedIn } = createTwoStepEventedWorkflow('evented-opted-in', { autoRestartActiveRuns: true });
    const { workflow: notOptedIn } = createTwoStepEventedWorkflow('evented-not-opted-in');

    mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      workflows: { defaultWorkflow, optedIn, notOptedIn },
    });

    const defaults = stubActiveRun(defaultWorkflow, 'default-run-1');
    const eventedOptedIn = stubActiveRun(optedIn, 'opted-in-run-1');
    const eventedNotOptedIn = stubActiveRun(notOptedIn, 'not-opted-in-run-1');

    await mastra.restartAllActiveWorkflowRuns();

    expect(defaults.restart).toHaveBeenCalledTimes(1);
    expect(eventedOptedIn.createRun).toHaveBeenCalledWith({ runId: 'opted-in-run-1' });
    expect(eventedOptedIn.restart).toHaveBeenCalledTimes(1);
    expect(eventedNotOptedIn.listActiveWorkflowRuns).not.toHaveBeenCalled();
    expect(eventedNotOptedIn.restart).not.toHaveBeenCalled();

    defaults.restart.mockClear();
    eventedOptedIn.restart.mockClear();

    await mastra.restartAllActiveWorkflowRuns({ optedInOnly: true });

    expect(eventedOptedIn.restart).toHaveBeenCalledTimes(1);
    expect(defaults.restart).not.toHaveBeenCalled();
    expect(eventedNotOptedIn.restart).not.toHaveBeenCalled();
  });

  it('restarts an orphaned evented run of an opted-in workflow to completion and leaves others alone', async () => {
    const optedIn = createTwoStepEventedWorkflow('evented-opted-in', { autoRestartActiveRuns: true });
    const notOptedIn = createTwoStepEventedWorkflow('evented-not-opted-in');

    mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      pubsub: new EventEmitterPubSub(),
      // The evented engine resolves workflows by registration key, so key = id.
      workflows: { 'evented-opted-in': optedIn.workflow, 'evented-not-opted-in': notOptedIn.workflow },
    });
    await mastra.startWorkers();

    await persistOrphanedRun(mastra, optedIn.workflow, 'opted-in-run');
    await persistOrphanedRun(mastra, notOptedIn.workflow, 'not-opted-in-run');

    await mastra.restartAllActiveWorkflowRuns({ optedInOnly: true });

    expect(await loadStatus(mastra, 'evented-opted-in', 'opted-in-run')).toBe('success');
    expect(optedIn.first).not.toHaveBeenCalled();
    expect(optedIn.second).toHaveBeenCalledTimes(1);
    expect(optedIn.second.mock.calls[0]![0].inputData).toEqual({ value: 15 });

    expect(await loadStatus(mastra, 'evented-not-opted-in', 'not-opted-in-run')).toBe('running');
    expect(notOptedIn.first).not.toHaveBeenCalled();
    expect(notOptedIn.second).not.toHaveBeenCalled();
  });

  const autoRecovery = (recovery: Record<string, unknown> = {}) => {
    const optedIn = createTwoStepEventedWorkflow('evented-opted-in', { autoRestartActiveRuns: true });
    const notOptedIn = createTwoStepEventedWorkflow('evented-not-opted-in');
    mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      pubsub: new EventEmitterPubSub(),
      // The evented engine resolves workflows by registration key, so key = id.
      workflows: { 'evented-opted-in': optedIn.workflow, 'evented-not-opted-in': notOptedIn.workflow },
      recovery: { workflows: 'auto', ...recovery },
    });
    return { mastra, optedIn, notOptedIn };
  };

  it("recovery.workflows: 'auto' resumes a stale orphaned run once workers start and leaves others alone", async () => {
    const { mastra, optedIn, notOptedIn } = autoRecovery();

    await persistOrphanedRun(mastra, optedIn.workflow, 'opted-in-run', 30 * MINUTE);
    await persistOrphanedRun(mastra, notOptedIn.workflow, 'not-opted-in-run', 30 * MINUTE);

    await mastra.startWorkers();

    await vi.waitFor(async () => {
      expect(await loadStatus(mastra, 'evented-opted-in', 'opted-in-run')).toBe('success');
    });
    expect(optedIn.second).toHaveBeenCalledTimes(1);
    expect(await loadStatus(mastra, 'evented-not-opted-in', 'not-opted-in-run')).toBe('running');
    expect(notOptedIn.second).not.toHaveBeenCalled();
  });

  it('leaves a run another live process is still executing alone (recently updated)', async () => {
    const { mastra, optedIn } = autoRecovery({ workflowRunSweepIntervalMs: 20 });
    // Created before this process, but its snapshot changed a minute ago: the
    // old container is still driving it (default stale threshold: 20 minutes).
    await persistOrphanedRun(mastra, optedIn.workflow, 'live-elsewhere', MINUTE);
    const sweep = vi.spyOn(mastra, 'restartAllActiveWorkflowRuns');

    await mastra.startWorkers();
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(3));

    expect(await loadStatus(mastra, 'evented-opted-in', 'live-elsewhere')).toBe('running');
    expect(optedIn.second).not.toHaveBeenCalled();
  });

  it('never touches a run created after this process started its workers (a schedule fire at boot)', async () => {
    const { mastra, optedIn } = autoRecovery({ workflowRunStaleAfterMs: 0, workflowRunSweepIntervalMs: 20 });
    const sweep = vi.spyOn(mastra, 'restartAllActiveWorkflowRuns');

    await mastra.startWorkers();
    await new Promise(resolve => setTimeout(resolve, 5));
    // This process's own run, created after boot, looks idle to a zero threshold.
    await persistOrphanedRun(mastra, optedIn.workflow, 'fired-at-boot');
    const callsBefore = sweep.mock.calls.length;
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(callsBefore + 3));

    expect(await loadStatus(mastra, 'evented-opted-in', 'fired-at-boot')).toBe('running');
    expect(optedIn.second).not.toHaveBeenCalled();
  });

  it('resumes a run orphaned by a deploy on a later sweep, once it becomes stale', async () => {
    const { mastra, optedIn } = autoRecovery({ workflowRunStaleAfterMs: 300, workflowRunSweepIntervalMs: 50 });
    // The old container stopped just now: not stale at boot.
    await persistOrphanedRun(mastra, optedIn.workflow, 'just-orphaned');

    // Created strictly before this process starts its workers.
    await new Promise(resolve => setTimeout(resolve, 5));
    await mastra.startWorkers();
    expect(await loadStatus(mastra, 'evented-opted-in', 'just-orphaned')).toBe('running');
    expect(optedIn.second).not.toHaveBeenCalled();

    await vi.waitFor(
      async () => {
        expect(await loadStatus(mastra, 'evented-opted-in', 'just-orphaned')).toBe('success');
      },
      { timeout: 5_000 },
    );
    expect(optedIn.second).toHaveBeenCalledTimes(1);
  });

  it('skips a run whose recovery lease another process holds', async () => {
    const { mastra, optedIn } = autoRecovery({ workflowRunSweepIntervalMs: 0 });
    await persistOrphanedRun(mastra, optedIn.workflow, 'leased-elsewhere', 30 * MINUTE);
    const leaseKey = `mastra:workflow-run-recovery:v1:${JSON.stringify(['evented-opted-in', 'leased-elsewhere'])}`;
    expect((await (mastra.pubsub as any).acquireLease(leaseKey, 'other-process', 60_000)).acquired).toBe(true);

    await mastra.restartAllActiveWorkflowRuns({ optedInOnly: true, staleAfterMs: 0 });

    expect(await loadStatus(mastra, 'evented-opted-in', 'leased-elsewhere')).toBe('running');
    expect(optedIn.second).not.toHaveBeenCalled();
  });

  it('does not restart anything when workers start without recovery.workflows', async () => {
    const optedIn = createTwoStepEventedWorkflow('evented-opted-in', { autoRestartActiveRuns: true });

    mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      pubsub: new EventEmitterPubSub(),
      workflows: { 'evented-opted-in': optedIn.workflow },
    });
    const sweep = vi.spyOn(mastra, 'restartAllActiveWorkflowRuns');

    await persistOrphanedRun(mastra, optedIn.workflow, 'opted-in-run');
    await mastra.startWorkers();

    expect(sweep).not.toHaveBeenCalled();
    expect(await loadStatus(mastra, 'evented-opted-in', 'opted-in-run')).toBe('running');
    expect(optedIn.second).not.toHaveBeenCalled();
  });

  it('never drives the same run twice when two sweeps overlap', async () => {
    const { workflow: optedIn } = createTwoStepEventedWorkflow('evented-opted-in', { autoRestartActiveRuns: true });
    mastra = new Mastra({
      logger: false,
      storage: new MockStore(),
      workflows: { 'evented-opted-in': optedIn },
    });

    let finish: () => void = () => {};
    const restart = vi.fn(() => new Promise<void>(resolve => (finish = resolve)));
    vi.spyOn(optedIn, 'listActiveWorkflowRuns').mockResolvedValue({
      runs: [createWorkflowRun(optedIn.id, 'opted-in-run-1', 'running')],
      total: 1,
    });
    vi.spyOn(optedIn, 'createRun').mockResolvedValue({ restart } as any);

    const first = mastra.restartAllActiveWorkflowRuns({ optedInOnly: true });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    await mastra.restartAllActiveWorkflowRuns();
    finish();
    await first;

    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('finishes a nested foreach run (parallel + nested workflows) orphaned by a lost process', async () => {
    const storage = new MockStore();
    const build = (blockPart?: number) => {
      const inspected: number[] = [];
      const inspect = createEventedStep({
        id: 'inspect-part',
        inputSchema: z.object({ id: z.string(), part: z.number() }),
        outputSchema: z.object({ id: z.string(), part: z.number() }),
        execute: async ({ inputData }) => {
          inspected.push(inputData.part);
          if (inputData.part === blockPart) await new Promise(() => {});
          return inputData;
        },
      });
      const save = createEventedStep({
        id: 'save-item',
        inputSchema: z.array(z.object({ id: z.string(), part: z.number() })),
        outputSchema: z.object({ id: z.string(), total: z.number() }),
        execute: async ({ inputData }) => ({
          id: inputData[0]!.id,
          total: inputData.reduce((sum, row) => sum + row.part, 0),
        }),
      });
      const checkItem = createEventedWorkflow({
        id: 'check-item',
        inputSchema: z.object({ id: z.string(), parts: z.array(z.number()) }),
        outputSchema: z.object({ id: z.string(), total: z.number() }),
      })
        .map(async ({ inputData }) => inputData.parts.map(part => ({ id: inputData.id, part })))
        .foreach(inspect, { concurrency: 1 })
        .then(save)
        .commit();
      const load = createEventedStep({
        id: 'load-items',
        inputSchema: z.object({}),
        outputSchema: z.array(z.object({ id: z.string(), parts: z.array(z.number()) })),
        execute: async () => [
          { id: 'a', parts: [1, 2] },
          { id: 'b', parts: [3, 4] },
          { id: 'c', parts: [5] },
        ],
      });
      const summarize = createEventedStep({
        id: 'summarize',
        inputSchema: z.array(z.object({ id: z.string(), total: z.number() })),
        outputSchema: z.object({ total: z.number() }),
        execute: async ({ inputData }) => ({ total: inputData.reduce((sum, row) => sum + row.total, 0) }),
      });
      const priceCheck = createEventedWorkflow({
        id: 'price-check',
        inputSchema: z.object({}),
        outputSchema: z.object({ total: z.number() }),
      })
        .then(load)
        .foreach(checkItem, { concurrency: 2 })
        .then(summarize)
        .commit();
      const account = createEventedStep({
        id: 'account',
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        execute: async () => ({ ok: true }),
      });
      const finalize = createEventedStep({
        id: 'finalize',
        inputSchema: z.object({
          account: z.object({ ok: z.boolean() }),
          'price-check': z.object({ total: z.number() }),
        }),
        outputSchema: z.object({ total: z.number() }),
        execute: async ({ inputData }) => ({ total: inputData['price-check'].total }),
      });
      const sync = createEventedWorkflow({
        id: 'sync',
        inputSchema: z.object({}),
        outputSchema: z.object({ total: z.number() }),
        options: { autoRestartActiveRuns: true },
      })
        .parallel([account, priceCheck])
        .then(finalize)
        .commit();
      return { sync, inspected };
    };

    // The lost process: part 3 never finishes, then the process goes away.
    const lost = build(3);
    const lostMastra = new Mastra({
      logger: false,
      storage,
      pubsub: new EventEmitterPubSub(),
      workflows: { sync: lost.sync },
    });
    await lostMastra.startWorkers();
    const lostRun = await lost.sync.createRun({ runId: 'orphaned-sync' });
    void lostRun.start({ inputData: {} });
    // Wait until item 'a' finished (its progress is recorded) and item 'b' is stuck on part 3.
    const workflowsStore = await storage.getStore('workflows');
    await vi.waitFor(async () => {
      const sync = await workflowsStore!.loadWorkflowSnapshot({ workflowName: 'sync', runId: 'orphaned-sync' });
      const priceCheckRunId = (sync?.context?.['price-check'] as any)?.metadata?.nestedRunId;
      const priceCheck = await workflowsStore!.loadWorkflowSnapshot({
        workflowName: 'price-check',
        runId: priceCheckRunId,
      });
      expect((priceCheck?.context?.['check-item'] as any)?.output?.[0]).toEqual({ id: 'a', total: 3 });
      expect(lost.inspected).toContain(3);
    });
    await lostMastra.stopWorkers();
    expect(await loadStatus(lostMastra, 'sync', 'orphaned-sync')).toBe('running');

    // The restarted process recovers the run at boot.
    const next = build();
    mastra = new Mastra({
      logger: false,
      storage,
      pubsub: new EventEmitterPubSub(),
      workflows: { sync: next.sync },
      // The lost process stopped moments ago; a test-sized stale threshold.
      recovery: { workflows: 'auto', workflowRunStaleAfterMs: 50, workflowRunSweepIntervalMs: 50 },
    });
    await mastra.startWorkers();

    await vi.waitFor(
      async () => {
        expect(await loadStatus(mastra!, 'sync', 'orphaned-sync')).toBe('success');
      },
      { timeout: 10_000 },
    );
    const snapshot = await workflowsStore!.loadWorkflowSnapshot({ workflowName: 'sync', runId: 'orphaned-sync' });
    expect((snapshot?.context?.finalize as any)?.output).toEqual({ total: 15 });
    // Finished work is kept: item 'a' (parts 1 and 2) is not run again; the
    // in-flight item 'b' and the not-started item 'c' run in the new process.
    expect([...next.inspected].sort()).toEqual([3, 4, 5]);
  });
});
