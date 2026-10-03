import { describe, expect, it } from 'vitest';
import z from 'zod';
// Exercise real persisted approval history without adding a Core -> Memory dependency cycle.
import { Memory } from '../../../../memory/src';
import { Agent } from '../../agent';
import { createDurableAgent } from '../../agent/durable';
import { Mastra } from '../../mastra';
import { InMemoryStore } from '../../storage';
import { MastraLanguageModelV2Mock } from '../../test-utils/llm-mock';
import { createTool } from '../../tools';
import { AgentController } from '../agent-controller';

// P15 follow-up (Khayalek audit 2026-10-04): a thread that holds two runs parked
// on approval (for example a chat run and a scheduled run) must still open after
// a restart. Each saved run's approval is restored as its own gate and answered
// by its own toolCallId; the tool of each run executes exactly once.

const RESOURCE = 'resource-multiple-saved';
const THREAD = 'thread-multiple-saved';

function scriptedModel() {
  let calls = 0;
  return new MastraLanguageModelV2Mock({
    doStream: async ({ prompt }) => {
      const answering = prompt.at(-1)?.role === 'tool';
      const step = answering ? 0 : ++calls;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (answering) {
              controller.enqueue({ type: 'text-start', id: 'text' });
              controller.enqueue({ type: 'text-delta', id: 'text', delta: 'Paid.' });
              controller.enqueue({ type: 'text-end', id: 'text' });
            } else {
              controller.enqueue({ type: 'tool-call', toolCallId: `pay-${step}`, toolName: 'pay', input: JSON.stringify({ amount: step }) });
            }
            controller.enqueue({
              type: 'finish',
              finishReason: answering ? 'stop' : 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
          },
        }),
      };
    },
  });
}

async function spine(storage: InMemoryStore) {
  const paid: number[] = [];
  const memory = new Memory({ storage });
  const pay = createTool({
    id: 'pay',
    description: 'Pay an amount.',
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      paid.push(amount);
      return { paid: amount };
    },
  });
  const agent = createDurableAgent({
    agent: new Agent({ id: 'saved-approvals', name: 'Saved approvals', instructions: 'Pay when asked.', model: scriptedModel(), memory, tools: { pay } }),
  }) as unknown as Agent;
  const controller = new AgentController({
    id: 'saved-approvals',
    agent,
    storage,
    memory,
    modes: [{ id: 'web', name: 'Web', metadata: { default: true } }],
  });
  const mastra = new Mastra({ agents: { savedApprovals: agent }, agentControllers: { savedApprovals: controller }, storage, logger: false });
  await controller.init();
  const durable = agent as unknown as {
    stream: (message: string, options: Record<string, unknown>) => Promise<{ fullStream: AsyncIterable<unknown> }>;
    listSuspendedRuns: (filter: { threadId: string; resourceId: string }) => Promise<{ runs: unknown[] }>;
  };
  return {
    mastra,
    paid,
    open: () => controller.createSession({ resourceId: RESOURCE, threadId: THREAD, ownerId: controller.id }),
    park: async (content: string) => {
      const result = await durable.stream(content, {
        memory: { thread: THREAD, resource: RESOURCE },
        requireToolApproval: true,
        closeOnSuspend: true,
      });
      for await (const _chunk of result.fullStream) {
        // Drain to the suspension.
      }
    },
    saved: async () => (await durable.listSuspendedRuns({ threadId: THREAD, resourceId: RESOURCE })).runs.length,
  };
}

describe('Session restore with several saved runs parked on approval', () => {
  it('opens the thread after a restart, shows one card per run and runs each tool once', async () => {
    const storage = new InMemoryStore({ id: 'multiple-saved-approvals' });
    const before = await spine(storage);
    await before.park('Pay one.');
    await before.park('Pay two.');
    await expect.poll(() => before.saved(), { timeout: 5_000 }).toBe(2);
    await before.mastra.shutdown();

    const after = await spine(storage);
    const session = await after.open();
    const cards = () => [...session.displayState.get().pendingApprovals.keys()].sort();
    await expect.poll(cards, { timeout: 5_000 }).toEqual(['pay-1', 'pay-2']);
    expect(after.paid).toEqual([]);

    for (const toolCallId of cards()) {
      expect(session.respondToToolApproval({ decision: 'approve', toolCallId })).toEqual({ accepted: true });
    }
    await expect.poll(() => [...after.paid].sort(), { timeout: 10_000 }).toEqual([1, 2]);
    await expect.poll(cards, { timeout: 5_000 }).toEqual([]);
    await expect.poll(() => after.saved(), { timeout: 5_000 }).toBe(0);
    await after.mastra.shutdown();
  }, 30_000);
});
