import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { Mastra } from '../mastra';
import { InMemoryStore } from '../storage';
import { createEventedWorkflow, createWorkflow } from './create';
import { getSuspensionWaitingFor } from './step';
import { createStep } from './workflow';

describe('workflow suspension waitingFor', () => {
  it.each(
    [false, true].flatMap(evented =>
      [false, true].flatMap(nested =>
        [undefined, 'user', 'external'].map(waitingFor => ({ evented, nested, waitingFor })),
      ),
    ),
  )(
    'persists $waitingFor through reload and clears it on resume (evented=$evented, nested=$nested)',
    async ({ evented, nested, waitingFor }) => {
      const storage = new InMemoryStore({ id: `workflow-wait-${evented}-${waitingFor}` });
      const seen: unknown[] = [];
      const build = () => {
        const step = createStep({
          id: 'wait',
          inputSchema: z.object({}),
          outputSchema: z.object({ accepted: z.boolean() }),
          suspendSchema: z.object({ message: z.string() }),
          resumeSchema: z.boolean(),
          execute: async ({ suspend, resumeData, suspendData }) => {
            if (resumeData === undefined) {
              await suspend(
                { message: 'Waiting.' },
                { resumeLabel: 'finish', waitingFor: waitingFor as 'user' | 'external' | undefined },
              );
              return { accepted: false };
            }
            seen.push(suspendData);
            return { accepted: resumeData };
          },
        });
        const child = (evented ? createEventedWorkflow : createWorkflow)({
          id: nested ? 'workflow-child' : 'workflow-wait',
          inputSchema: z.object({}),
          outputSchema: z.object({ accepted: z.boolean() }),
          steps: [step],
        })
          .then(step)
          .commit();
        const workflow = nested
          ? (evented ? createEventedWorkflow : createWorkflow)({
              id: 'workflow-wait',
              inputSchema: z.object({}),
              outputSchema: z.object({ accepted: z.boolean() }),
            })
              .then(child)
              .commit()
          : child;
        const mastra = new Mastra({
          storage,
          workflows: { 'workflow-wait': workflow, ...(nested ? { 'workflow-child': child } : {}) },
          logger: false,
        });
        return { workflow, mastra };
      };
      let runtime = build();
      if (evented) await runtime.mastra.startEventEngine();
      const run = await runtime.workflow.createRun();
      const result = await run.start({ inputData: {} });
      expect(result.status).toBe('suspended');
      expect(result.steps[nested ? 'workflow-child' : 'wait']).toMatchObject({
        status: 'suspended',
        waitingFor: waitingFor ?? 'user',
      });
      const store = (await storage.getStore('workflows'))!;
      const snapshot = await store.loadWorkflowSnapshot({ workflowName: 'workflow-wait', runId: run.runId });
      expect(snapshot?.context[nested ? 'workflow-child' : 'wait']).toMatchObject({
        status: 'suspended',
        waitingFor: waitingFor ?? 'user',
      });
      await runtime.mastra.stopEventEngine();
      runtime = build();
      if (evented) await runtime.mastra.startEventEngine();
      const restored = await runtime.workflow.createRun({ runId: run.runId });
      const resumed = await restored.resume({ label: 'finish', resumeData: false });
      expect(resumed.status).toBe('success');
      expect(seen).toEqual([{ message: 'Waiting.' }]);
      expect(resumed.steps[nested ? 'workflow-child' : 'wait']).not.toHaveProperty('waitingFor');
      await runtime.mastra.stopEventEngine();
    },
    25_000,
  );

  it('rejects unknown waitingFor values at the shared suspension boundary', () => {
    expect(() => getSuspensionWaitingFor({ waitingFor: 'guess' as 'external' })).toThrow('Suspension waitingFor');
    expect(getSuspensionWaitingFor()).toBe('user');
  });
});
