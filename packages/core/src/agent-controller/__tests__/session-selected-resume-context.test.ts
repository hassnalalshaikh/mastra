import type { LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../../agent/agent';
import { createDurableAgent } from '../../agent/durable';
import { Mastra } from '../../mastra';
import { MockMemory } from '../../memory/mock';
import { RequestContext, MASTRA_AUTH_TOKEN_KEY } from '../../request-context';
import { InMemoryStore } from '../../storage';
import { createTool } from '../../tools';
import { AgentController } from '../agent-controller';

it('a recreated public Controller approves the saved binding with fresh scope exactly once', async () => {
  const storage = new InMemoryStore();
  const observed: unknown[] = [];
  const instances: Mastra[] = [];
  const spine = async () => {
    const memory = new MockMemory({ storage });
    const model = new MockLanguageModelV2({
      doStream: async ({ prompt }) => {
        const answering = prompt.at(-1)?.role === 'tool';
        return {
          stream: convertArrayToReadableStream<LanguageModelV2StreamPart>([
            { type: 'stream-start', warnings: [] },
            ...(answering
              ? [
                  { type: 'text-start' as const, id: 'text' },
                  { type: 'text-delta' as const, id: 'text', delta: 'Done.' },
                  { type: 'text-end' as const, id: 'text' },
                ]
              : [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'saved-call',
                    toolName: 'checked',
                    input: '{}',
                    toolCallType: 'function' as const,
                  },
                ]),
            {
              type: 'finish',
              finishReason: answering ? 'stop' : 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]),
          warnings: [],
        };
      },
    });
    const tool = createTool({
      id: 'checked',
      description: 'Checked',
      inputSchema: z.object({}),
      requireApproval: true,
      execute: async (_input, { requestContext }) => {
        observed.push({
          binding: requestContext.get('binding'),
          user: requestContext.get('user'),
          allowed: requestContext.get('allowed'),
          token: requestContext.get(MASTRA_AUTH_TOKEN_KEY),
          controller: !!requestContext.get('controller'),
        });
        return { ok: true };
      },
    });
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'selected-controller',
        name: 'Selected controller',
        instructions: 'Use checked.',
        memory,
        tools: { checked: tool },
        model: ({ requestContext }) => {
          expect(requestContext.get('binding')).toEqual({ model: 'A', price: 2 });
          return model;
        },
        defaultOptions: ({ requestContext }) => {
          expect(requestContext.get('binding')).toEqual({ model: 'A', price: 2 });
          return {};
        },
      }),
      resumeRequestContextKeys: ['binding'],
      resumeRequestContextSchema: z.object({ binding: z.object({ model: z.literal('A'), price: z.literal(2) }) }),
      cleanupTimeoutMs: 0,
    });
    const controller = new AgentController({
      id: 'selected-controller',
      agent: agent as unknown as Agent,
      storage,
      memory,
      modes: [{ id: 'web', name: 'Web', metadata: { default: true } }],
    });
    const mastra = new Mastra({ agents: { agent }, agentControllers: { controller }, storage, logger: false });
    instances.push(mastra);
    await controller.init();
    return { agent, controller, mastra };
  };
  try {
    const before = await spine();
    const first = await before.agent.stream('Use checked.', {
      requestContext: new RequestContext([
        ['binding', { model: 'A', price: 2 }],
        ['user', 'old-user'],
        ['allowed', true],
        [MASTRA_AUTH_TOKEN_KEY, 'old-token'],
      ]),
      memory: { thread: 'saved-thread', resource: 'saved-resource' },
      closeOnSuspend: true,
    });
    for await (const _chunk of first.fullStream) {
      /* Drain to the actual native parked boundary. */
    }
    expect(observed).toEqual([]);
    first.cleanup();
    await before.mastra.shutdown();
    const after = await spine();
    const session = await after.controller.createSession({
      resourceId: 'saved-resource',
      threadId: 'saved-thread',
      ownerId: after.controller.id,
    });
    const fresh = new RequestContext([
      ['binding', { model: 'B', price: 999 }],
      ['user', 'new-user'],
      [MASTRA_AUTH_TOKEN_KEY, 'new-token'],
    ]);
    await expect(
      session.approveToolCall({
        runId: first.runId,
        toolCallId: 'saved-call',
        threadId: 'saved-thread',
        resourceId: 'foreign-resource',
        requestContext: fresh,
      }),
    ).rejects.toThrow();
    expect(observed).toEqual([]);
    await session.approveToolCall({
      runId: first.runId,
      toolCallId: 'saved-call',
      threadId: 'saved-thread',
      resourceId: 'saved-resource',
      requestContext: fresh,
    });
    await vi.waitFor(() =>
      expect(observed).toEqual([
        {
          binding: { model: 'A', price: 2 },
          user: 'new-user',
          allowed: undefined,
          token: 'new-token',
          controller: true,
        },
      ]),
    );
    await expect(
      session.approveToolCall({
        runId: first.runId,
        toolCallId: 'saved-call',
        threadId: 'saved-thread',
        resourceId: 'saved-resource',
        requestContext: fresh,
      }),
    ).rejects.toThrow();
    expect(observed).toHaveLength(1);
  } finally {
    for (const instance of instances.reverse()) await instance.shutdown();
  }
}, 15_000);
