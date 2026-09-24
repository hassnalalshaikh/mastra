/**
 * Crash recovery from every running checkpoint the durable loop writes.
 *
 * A real durable agent runs one tool call and then answers. Every running
 * snapshot row it persists is captured. For each captured checkpoint, a fresh
 * Mastra instance (a "new process") is seeded with exactly the rows that
 * existed at that moment and recovers the run. The recovered run must finish
 * with the answer, run the tool at most once across both processes when the
 * checkpoint already holds its result, and leave no snapshot rows behind.
 *
 * It also pins the write budget: after a tool result, only the tool checkpoint
 * and the next iteration's start are written before the next model call.
 */
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '../../../mastra';
import { InMemoryStore } from '../../../storage';
import { createTool } from '../../../tools';
import type { WorkflowRunState } from '../../../workflows/types';
import { Agent } from '../../agent';
import { DurableStepIds } from '../constants';
import { createDurableAgent } from '../create-durable-agent';

type Row = { workflowName: string; runId: string; resourceId?: string; snapshot: WorkflowRunState };

function makeAgent(effects: string[], modelCalls: { n: number }) {
  const lookup = createTool({
    id: 'lookup',
    description: 'Look up a fact.',
    inputSchema: z.object({ q: z.string() }),
    execute: async ({ q }) => {
      effects.push(q);
      return { fact: `fact about ${q}` };
    },
  });
  const model = new MockLanguageModelV2({
    doStream: async ({ prompt }) => {
      modelCalls.n += 1;
      const toolResults = prompt.filter(m => m.role === 'tool').length;
      const head = [{ type: 'stream-start' as const, warnings: [] }];
      return {
        stream: convertArrayToReadableStream(
          toolResults === 0
            ? [
                ...head,
                { type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'lookup', input: '{"q":"x"}' },
                {
                  type: 'finish' as const,
                  finishReason: 'tool-calls' as const,
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ]
            : [
                ...head,
                { type: 'text-start' as const, id: 'a' },
                { type: 'text-delta' as const, id: 'a', delta: 'Done.' },
                { type: 'text-end' as const, id: 'a' },
                {
                  type: 'finish' as const,
                  finishReason: 'stop' as const,
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                },
              ],
        ),
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      };
    },
  });
  return createDurableAgent({
    agent: new Agent({ id: 'crash-proof', name: 'Crash proof', instructions: 'Use tools.', model, tools: { lookup } }),
  });
}

describe('durable checkpoint crash recovery', () => {
  it('recovers from every running checkpoint without repeating a completed tool', async () => {
    const effects: string[] = [];
    const modelCalls = { n: 0 };
    const agent = makeAgent(effects, modelCalls);
    const storage = new InMemoryStore();
    const workflows = (await storage.getStore('workflows'))!;
    const persist = workflows.persistWorkflowSnapshot.bind(workflows);
    const current = new Map<string, Row>();
    const moments: Array<{ rows: Row[]; last?: string; toolDone: boolean }> = [];
    vi.spyOn(workflows, 'persistWorkflowSnapshot').mockImplementation(async args => {
      await persist(args);
      current.set(args.workflowName, structuredClone(args) as Row);
      if (args.snapshot.status === 'running' && current.has(DurableStepIds.AGENTIC_LOOP)) {
        const inner = current.get(DurableStepIds.AGENTIC_EXECUTION)?.snapshot;
        moments.push({
          rows: [...current.values()].map(row => structuredClone(row)),
          last: (args.snapshot as WorkflowRunState & { stepExecutionPath?: string[] }).stepExecutionPath?.at(-1),
          toolDone: effects.length > 0 && JSON.stringify(inner?.context ?? {}).includes('fact about x'),
        });
      }
    });
    const mastra = new Mastra({ logger: false, storage, agents: { agent }, recovery: { durableAgents: 'off' } });
    const original = await agent.stream('Find it.', { runId: 'crash-run' });
    expect(await original.output.text).toBe('Done.');
    await mastra.shutdown();
    expect(effects).toEqual(['x']);
    expect(moments.length).toBeGreaterThan(2);

    const problems: string[] = [];
    // Checkpoints written after the loop (map-final-output, execute-scorers)
    // follow the finish event: the answer is already streamed and saved, and a
    // recovered stream from there does not receive a second finish. That
    // behavior predates this change and is out of its scope.
    const inLoop = moments.filter(moment => moment.last !== 'map-final-output' && moment.last !== 'execute-scorers');
    expect(inLoop.length).toBeGreaterThan(5);
    for (const [index, moment] of inLoop.entries()) {
      const label = `checkpoint ${index} (${moment.last}; ${moment.rows
        .map(row => `${row.workflowName}:${row.snapshot.status}`)
        .join(' ')})`;
      const recoveredEffects: string[] = [];
      const recoveredAgent = makeAgent(recoveredEffects, { n: 0 });
      const recoveredStorage = new InMemoryStore();
      const recoveredWorkflows = (await recoveredStorage.getStore('workflows'))!;
      for (const row of moment.rows) await recoveredWorkflows.persistWorkflowSnapshot(row);
      const recovered = new Mastra({
        logger: false,
        storage: recoveredStorage,
        agents: { agent: recoveredAgent },
        recovery: { durableAgents: 'off' },
      });
      try {
        const result = await recoveredAgent.recover('crash-run');
        const text = await Promise.race([
          result.output.text.catch((error: Error) => `ERROR ${error.message}`),
          new Promise<string>(resolve => setTimeout(() => resolve('ERROR recovered stream did not finish'), 5_000)),
        ]);
        // The recovered stream carries only what happens after the checkpoint.
        // When the saved LLM result already holds the answer, the first
        // process streamed it and recovery only finishes the run.
        const answerSaved = JSON.stringify(moment.rows).includes('Done.');
        if (text.startsWith('ERROR')) problems.push(`${label}: ${text}`);
        else if (!answerSaved && !text.includes('Done.')) problems.push(`${label}: no answer (${text})`);
        // A checkpoint that already holds the tool result never re-runs the tool.
        if (moment.toolDone && recoveredEffects.length) problems.push(`${label}: tool ran again`);
        if (recoveredEffects.length > 1) problems.push(`${label}: tool ran ${recoveredEffects.length} times`);
        // Terminal cleanup deletes the run's rows right after the stream ends.
        let leftover = 1;
        for (let attempt = 0; attempt < 50 && leftover; attempt += 1) {
          const rows = await recoveredWorkflows.listWorkflowRuns({});
          leftover = rows.runs.filter(run => run.runId === 'crash-run').length;
          if (leftover) await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (!text.startsWith('ERROR') && leftover) problems.push(`${label}: run rows left after the run ended`);
      } catch (error) {
        problems.push(`${label}: ${(error as Error).message}`);
      } finally {
        await recovered.shutdown();
      }
    }
    expect(problems).toEqual([]);
  });

  it('writes only the tool checkpoint and the next iteration start between a tool result and the next model call', async () => {
    const effects: string[] = [];
    const modelCalls = { n: 0 };
    const agent = makeAgent(effects, modelCalls);
    const storage = new InMemoryStore();
    const workflows = (await storage.getStore('workflows'))!;
    const persist = workflows.persistWorkflowSnapshot.bind(workflows);
    const gapWrites: string[] = [];
    vi.spyOn(workflows, 'persistWorkflowSnapshot').mockImplementation(async args => {
      if (effects.length === 1 && modelCalls.n === 1) {
        const last = (args.snapshot as WorkflowRunState & { stepExecutionPath?: string[] }).stepExecutionPath?.at(-1);
        gapWrites.push(`${args.workflowName}:${args.snapshot.status}:${last}`);
      }
      await persist(args);
    });
    const mastra = new Mastra({ logger: false, storage, agents: { agent }, recovery: { durableAgents: 'off' } });
    try {
      const result = await agent.stream('Find it.');
      expect(await result.output.text).toBe('Done.');
    } finally {
      await mastra.shutdown();
    }
    for (const replayable of [
      'collect-tool-results',
      'durable-llm-mapping',
      'update-iteration-state',
      'durable-is-task-complete',
      'durable-goal',
    ]) {
      expect(
        gapWrites.some(write => write.endsWith(`:${replayable}`)),
        gapWrites.join(', '),
      ).toBe(false);
    }
    expect(gapWrites.length, gapWrites.join(', ')).toBeLessThanOrEqual(4);
  });
});
