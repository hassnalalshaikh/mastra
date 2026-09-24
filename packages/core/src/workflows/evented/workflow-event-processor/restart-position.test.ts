import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createStep, createWorkflow } from '..';
import { FOREACH_QUEUED } from './loop';
import { resolveEventedRestartPosition } from './restart-position';

const step = (id: string) =>
  createStep({ id, inputSchema: z.any(), outputSchema: z.any(), execute: async ({ inputData }) => inputData });

const restartOf = (stepResults: Record<string, any>, extra: Record<string, any> = {}) => ({
  activePaths: [],
  activeStepsPath: {},
  stepResults,
  state: {},
  ...extra,
});

describe('resolveEventedRestartPosition', () => {
  it('keeps a recorded position unchanged', () => {
    const workflow = createWorkflow({ id: 'kept', inputSchema: z.any(), outputSchema: z.any() })
      .then(step('a'))
      .commit();
    const restart = restartOf({ input: 1 }, { activePaths: [0], activeStepsPath: { a: [0] } });
    expect(resolveEventedRestartPosition({ stepGraph: workflow.stepGraph, restart })).toBe(restart);
  });

  it('resumes at the first unfinished step with the previous output as its input', () => {
    const workflow = createWorkflow({ id: 'seq', inputSchema: z.any(), outputSchema: z.any() })
      .then(step('a'))
      .then(step('b'))
      .then(step('c'))
      .commit();
    const resolved = resolveEventedRestartPosition({
      stepGraph: workflow.stepGraph,
      restart: restartOf({ input: 1, a: { status: 'success', output: 2, payload: 1 } }),
    });
    expect(resolved.activePaths).toEqual([1]);
    expect(resolved.activeStepsPath).toEqual({ b: [1] });
    expect(resolved.stepResults.b).toMatchObject({ status: 'running', payload: 2 });
  });

  const progress = (statuses: string[]) => ({
    __workflow_meta: { foreachOutput: statuses.map(status => (status ? { status } : null)) },
  });

  it('queues the foreach iterations that were in flight and keeps finished ones', () => {
    const workflow = createWorkflow({ id: 'loop', inputSchema: z.any(), outputSchema: z.any() })
      .foreach(step('item'), { concurrency: 2 })
      .commit();
    const resolved = resolveEventedRestartPosition({
      stepGraph: workflow.stepGraph,
      restart: restartOf({
        input: [1, 2, 3],
        item: { status: 'success', output: [1, null], payload: [1, 2, 3], suspendPayload: progress(['success']) },
      }),
    });
    expect(resolved.activePaths).toEqual([0]);
    expect(resolved.stepResults.item.output).toEqual([1, { [FOREACH_QUEUED]: true }]);
    expect(resolved.stepResults.item.payload).toEqual([1, 2, 3]);
  });

  it('decides foreach completion from iteration status when the step returns nothing', () => {
    const workflow = createWorkflow({ id: 'void-loop', inputSchema: z.any(), outputSchema: z.any() })
      .foreach(step('item'), { concurrency: 2 })
      .then(step('after'))
      .commit();
    // Every iteration finished with no output (stored as null): the foreach is done.
    const finished = resolveEventedRestartPosition({
      stepGraph: workflow.stepGraph,
      restart: restartOf({
        input: [1, 2],
        item: {
          status: 'success',
          output: [null, null],
          payload: [1, 2],
          suspendPayload: progress(['success', 'success']),
        },
      }),
    });
    expect(finished.activePaths).toEqual([1]);
    expect(finished.stepResults.after).toMatchObject({ status: 'running', payload: [null, null] });

    // Same output values, but the second iteration never finished: only it is queued again.
    const inFlight = resolveEventedRestartPosition({
      stepGraph: workflow.stepGraph,
      restart: restartOf({
        input: [1, 2],
        item: { status: 'success', output: [null, null], payload: [1, 2], suspendPayload: progress(['success']) },
      }),
    });
    expect(inFlight.activePaths).toEqual([0]);
    expect(inFlight.stepResults.item.output).toEqual([null, { [FOREACH_QUEUED]: true }]);
  });

  it('refuses positions it cannot recover', () => {
    const workflow = createWorkflow({ id: 'branch', inputSchema: z.any(), outputSchema: z.any() })
      .branch([[async () => true, step('a')]])
      .commit();
    expect(() =>
      resolveEventedRestartPosition({ stepGraph: workflow.stepGraph, restart: restartOf({ input: 1 }) }),
    ).toThrow(/conditional/);

    const done = createWorkflow({ id: 'done', inputSchema: z.any(), outputSchema: z.any() }).then(step('a')).commit();
    expect(() =>
      resolveEventedRestartPosition({
        stepGraph: done.stepGraph,
        restart: restartOf({ input: 1, a: { status: 'success', output: 1 } }),
      }),
    ).toThrow(/every step already finished/);
  });
});
