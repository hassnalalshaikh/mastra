import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import { createDurableAgent } from '../../agent/durable';
import { InMemoryServerCache } from '../../cache';
import { EventEmitterPubSub } from '../../events/event-emitter';
import { Mastra } from '../../mastra';
import { InMemoryStore } from '../../storage/mock';
import { AgentController } from '../agent-controller';
import type { AgentControllerEvent } from '../types';

/** A model whose runs stay open until the test closes their stream; records each prompt and abort. */
function makeHeldRuns(id: string) {
  const prompts: unknown[] = [];
  const aborted: number[] = [];
  const sources: ReadableStreamDefaultController<any>[] = [];
  const agent = new Agent({
    id,
    name: 'Stop queued run test',
    instructions: 'Reply briefly.',
    model: new MockLanguageModelV2({
      doStream: async ({ prompt, abortSignal }) => {
        const index = prompts.length;
        prompts.push(prompt);
        abortSignal?.addEventListener('abort', () => aborted.push(index), { once: true });
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
          stream: new ReadableStream({
            start(source) {
              sources[index] = source;
              source.enqueue({ type: 'stream-start', warnings: [] });
              source.enqueue({ type: 'text-start', id: `text-${index}` });
              source.enqueue({ type: 'text-delta', id: `text-${index}`, delta: `Run ${index} waiting` });
            },
          }),
        };
      },
    }),
  });
  const finish = (index: number) => {
    sources[index]!.enqueue({ type: 'text-end', id: `text-${index}` });
    sources[index]!.enqueue({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    sources[index]!.close();
  };
  return { agent, prompts, aborted, finish };
}

const occurrences = (prompt: unknown, text: string) => JSON.stringify(prompt).split(text).length - 1;

/**
 * A Session whose first turn is running and whose follow-up was queued behind it,
 * then handed by the Agent queue to the next run when the first turn ended.
 */
async function startQueueDrainedRun(id: string, durable: boolean) {
  const runs = makeHeldRuns(id);
  const storage = new InMemoryStore();
  const pubsub = new EventEmitterPubSub();
  const cache = new InMemoryServerCache();
  let agent: Agent = runs.agent;
  if (durable) {
    const durableAgent = createDurableAgent({ agent: runs.agent, cache, pubsub });
    const mastra = new Mastra({ agents: { agent: durableAgent as any }, storage, cache, pubsub, logger: false });
    agent = mastra.getAgent('agent') as Agent;
  }
  const controller = new AgentController({
    id: `${id}-controller`,
    storage,
    pubsub,
    modes: [{ id: 'default', name: 'Default', default: true, agent }],
  });
  await controller.init();
  const session = await controller.createSession({ resourceId: `${id}-owner` });
  const events: AgentControllerEvent[] = [];
  session.subscribe(event => {
    events.push(event);
  });
  const first = session.sendMessage({ content: 'Hold the first instruction.' });
  void first.catch(() => {});
  await vi.waitFor(() => {
    expect(runs.prompts).toHaveLength(1);
    expect(session.displayState.get().isRunning).toBe(true);
  });
  await session.followUp({ content: 'Write the long queued answer.' });
  expect(session.displayState.get().queuedFollowUpItems).toHaveLength(1);
  // The first turn ends; the Agent queue starts the follow-up's run on its own.
  runs.finish(0);
  await first;
  await vi.waitFor(() => expect(runs.prompts).toHaveLength(2));
  expect(occurrences(runs.prompts[1], 'Write the long queued answer.')).toBe(1);
  await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(true));
  return { ...runs, controller, session, events };
}

describe.each([{ durable: false }, { durable: true }])(
  'a run the follow-up queue started (durable=$durable)',
  ({ durable }) => {
    it('stops on Stop: the model call is aborted and the session settles as aborted', async () => {
      const { controller, session, aborted, prompts, events } = await startQueueDrainedRun(
        `stop-queued-${durable}`,
        durable,
      );
      try {
        session.abort();
        await vi.waitFor(() => expect(aborted).toContain(1));
        await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
        expect(events.some(event => event.type === 'agent_end' && (event as any).reason === 'aborted')).toBe(true);
        expect(prompts).toHaveLength(2);
      } finally {
        await controller.destroy();
      }
    }, 20_000);

    it('is cut by Send now: the queued run is aborted and the steered message runs next', async () => {
      const { controller, session, aborted, prompts, finish } = await startQueueDrainedRun(
        `steer-queued-${durable}`,
        durable,
      );
      try {
        await session.followUp({ content: 'Answer this one right now.' });
        const [item] = session.displayState.get().queuedFollowUpItems;
        const result = session.steerFollowUp({ id: item!.id });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        void result.delivery.catch(() => {});
        await vi.waitFor(() => expect(aborted).toContain(1));
        await vi.waitFor(() => expect(prompts).toHaveLength(3));
        expect(occurrences(prompts[2], 'Answer this one right now.')).toBe(1);
        finish(2);
        await result.delivery;
        await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
        expect(prompts).toHaveLength(3);
      } finally {
        await controller.destroy();
      }
    }, 20_000);
  },
);
