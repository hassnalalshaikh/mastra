import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { Mastra } from '../../../mastra';
import { MockMemory } from '../../../memory/mock';
import { InMemoryStore } from '../../../storage';
import { Agent } from '../../agent';
import { createDurableAgent } from '../create-durable-agent';

describe('durable completion checkpoint round trips', () => {
  it.each([
    { delayMs: 0, withMemory: false },
    { delayMs: 100, withMemory: false },
    { delayMs: 0, withMemory: true },
    { delayMs: 100, withMemory: true },
  ])('reuses acknowledged results with $delayMs ms latency and memory=$withMemory', async ({ delayMs, withMemory }) => {
    const storage = new InMemoryStore();
    const workflows = (await storage.getStore('workflows'))!;
    const persist = workflows.persistWorkflowSnapshot.bind(workflows);
    let completionStartedAt = 0;
    let completionFinishedAt = 0;
    let completionStarted = false;
    let completionFinished = false;
    const writes: Array<{ at: number; last?: string; steps: Array<[string, string]> }> = [];
    vi.spyOn(workflows, 'persistWorkflowSnapshot').mockImplementation(async args => {
      if (completionStarted && !completionFinished)
        writes.push({
          at: performance.now(),
          last: args.snapshot.stepExecutionPath?.at(-1),
          steps: Object.entries(args.snapshot.context).map(([id, value]) => [id, value?.status]),
        });
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      await persist(args);
    });
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: 'Ready.' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
        warnings: [],
      }),
    });
    const base = new Agent({
      id: 'checkpoint-proof',
      name: 'Checkpoint proof',
      instructions: 'Answer.',
      model,
      memory: withMemory ? new MockMemory() : undefined,
      outputProcessors: [
        {
          id: 'observer',
          processOutputStep: args => {
            completionStarted = true;
            completionStartedAt = performance.now();
            return args.messages;
          },
          processOutputResult: args => {
            completionFinished = true;
            completionFinishedAt = performance.now();
            return args.messages;
          },
        },
      ],
    });
    const agent = createDurableAgent({ agent: base });
    const mastra = new Mastra({ logger: false, storage, agents: { agent }, recovery: { durableAgents: 'off' } });
    try {
      const result = await agent.stream(
        'Answer.',
        withMemory ? { memory: { thread: 'checkpoint-thread', resource: 'owner' } } : undefined,
      );
      expect(await result.output.text).toBe('Ready.');
      expect(completionFinished).toBe(true);
      process.stdout.write(
        JSON.stringify({
          delayMs,
          withMemory,
          completionWrites: writes.length,
          completionMs: completionFinishedAt - completionStartedAt,
        }) + '\n',
      );
      // Only material checkpoints are written after the answer: replayable
      // mapping/routing/evaluation steps are re-derived on restart from the
      // saved LLM result, so they add no running writes of their own.
      expect(writes.length).toBeLessThanOrEqual(3);
      for (const replayable of [
        'durable-llm-mapping',
        'update-iteration-state',
        'durable-is-task-complete',
        'durable-goal',
      ])
        expect(writes.map(w => w.last)).not.toContain(replayable);
      const completions = new Set(
        writes.flatMap(w => w.steps.filter(([, status]) => status === 'success').map(([id]) => id)),
      );
      expect(completions.has('durable-llm-execution')).toBe(true);
    } finally {
      await mastra.shutdown();
    }
  });
});
