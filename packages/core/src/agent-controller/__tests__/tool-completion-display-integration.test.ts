/**
 * End-to-end completion display: a tool outcome that settles during a real
 * run must reach live subscribers as the same row (same id, same completion
 * time) a stored display read returns afterwards.
 */
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import { Agent } from '../../agent';
import { createDurableAgent } from '../../agent/durable';
import type { MastraDBMessage } from '../../agent/message-list/state/types';
import { InMemoryServerCache } from '../../cache';
import { EventEmitterPubSub } from '../../events';
import { Mastra } from '../../mastra';
import { MockMemory } from '../../memory/mock';
import { InMemoryStore } from '../../storage/mock';
import { createTool } from '../../tools/tool';
import { AgentController } from '../agent-controller';
import { createMockWorkspace } from '../test-utils';
import type { AgentControllerEvent } from '../types';

function toolThenAnswer() {
  let step = 0;
  return new MockLanguageModelV2({
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: `id-${step}`, modelId: 'mock-model-id', timestamp: new Date(0) },
        ...(step++ === 0
          ? [{ type: 'tool-call' as const, toolCallId: 'call-real', toolName: 'work', input: '{}' }]
          : [
              { type: 'text-start' as const, id: 'text-1' },
              { type: 'text-delta' as const, id: 'text-1', delta: 'Done.' },
              { type: 'text-end' as const, id: 'text-1' },
            ]),
        {
          type: 'finish' as const,
          finishReason: step === 1 ? ('tool-calls' as const) : ('stop' as const),
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    }),
  });
}

describe('tool completion display over a real run', () => {
  it('shows the settled outcome under the row id and time a stored read returns', async () => {
    const storage = new InMemoryStore();
    const agent = new Agent({
      id: 'test-agent',
      name: 'test-agent',
      model: toolThenAnswer(),
      instructions: 'You are a test agent.',
      memory: new MockMemory({ storage }),
      tools: {
        work: createTool({
          id: 'work',
          description: 'Work',
          inputSchema: z.object({}),
          execute: async () => 'Actual result',
        }),
      },
    });
    const controller = new AgentController({
      workspace: createMockWorkspace(),
      id: 'test-controller',
      storage,
      resourceId: 'test-resource',
      modes: [{ id: 'build', agent }],
      defaultModeId: 'build',
    });

    await controller.init();
    const session = await controller.createSession({ id: 'test-session', ownerId: 'test-owner' });
    await controller.getMastra()?.startWorkers();
    await session.state.set({ yolo: true });
    await session.thread.create();
    const threadId = session.thread.requireId();

    const events: AgentControllerEvent[] = [];
    session.subscribe(event => {
      events.push(event);
    });

    await session.sendMessage({ content: 'Run the work' });

    const liveStarts = events.flatMap(event =>
      event.type === 'message_start' && event.message.role === 'assistant' ? [event.message] : [],
    );
    const liveCompletion = liveStarts.find(message => message.id.endsWith(':tool-result:call-real'));
    expect(liveCompletion).toBeDefined();
    expect(events).toContainEqual({ type: 'message_end', id: liveCompletion!.id });

    const stored = await session.thread.listMessages({ threadId });
    const storedCompletion = stored.find(message => message.id === liveCompletion!.id);
    expect(storedCompletion).toBeDefined();
    expect(new Date(storedCompletion!.createdAt).toISOString()).toBe(new Date(liveCompletion!.createdAt).toISOString());

    const source = stored.find(message => message.id === liveCompletion!.id.split(':tool-result:')[0]);
    expect(source).toBeDefined();
    expect(
      source!.content.parts.some(
        part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'call-real',
      ),
    ).toBe(false);
    // Exactly one row shows the outcome, live and stored.
    const showsOutcome = (message: MastraDBMessage) =>
      message.content.parts.some(part => part.type === 'tool-invocation' && part.toolInvocation.state === 'result');
    expect(stored.filter(showsOutcome).map(message => message.id)).toEqual([liveCompletion!.id]);
  }, 30000);
});

describe('tool completion display over a durable run', () => {
  it('publishes the same completion row live that the committed transcript returns', async () => {
    const storage = new InMemoryStore();
    const baseAgent = new Agent({
      id: 'durable-completion-agent',
      name: 'Durable completion agent',
      instructions: 'Run the work.',
      model: toolThenAnswer(),
      memory: new MockMemory({ storage }),
      tools: {
        work: createTool({
          id: 'work',
          description: 'Work',
          inputSchema: z.object({}),
          execute: async () => 'Actual result',
        }),
      },
    });
    const cache = new InMemoryServerCache();
    const pubsub = new EventEmitterPubSub();
    const agent = createDurableAgent({ agent: baseAgent, cache, pubsub });
    const mastra = new Mastra({ agents: { agent: agent as any }, storage, cache, pubsub, logger: false });
    const controller = new AgentController({
      id: 'durable-completion-controller',
      agent: mastra.getAgent('agent'),
      pubsub,
      workspace: createMockWorkspace(),
      storage,
      initialState: { yolo: true } as any,
      modes: [{ id: 'default', default: true }],
    });
    await controller.init();
    const session = await controller.createSession({
      resourceId: 'completion-user',
      scope: 'thread:completion-thread',
      threadId: 'completion-thread',
    });
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => {
      events.push(event);
    });

    await session.sendMessage({ content: 'Run the work' });
    await vi.waitFor(() => expect(session.run.isRunning()).toBe(false), { timeout: 20_000 });
    await new Promise(resolve => setTimeout(resolve, 300));

    const liveCompletion = events
      .flatMap(event => (event.type === 'message_start' ? [event.message] : []))
      .find(message => message.id.endsWith(':tool-result:call-real'));
    expect(liveCompletion).toBeDefined();

    const stored = await session.thread.listMessages({ threadId: 'completion-thread' });
    const storedCompletion = stored.find(message => message.id === liveCompletion!.id);
    expect(storedCompletion).toBeDefined();
    expect(new Date(storedCompletion!.createdAt).toISOString()).toBe(new Date(liveCompletion!.createdAt).toISOString());
    const showsOutcome = (message: MastraDBMessage) =>
      message.content.parts.some(part => part.type === 'tool-invocation' && part.toolInvocation.state === 'result');
    expect(stored.filter(showsOutcome).map(message => message.id)).toEqual([liveCompletion!.id]);
  }, 30000);
});
