import { Memory } from '@mastra/memory';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../agent';
import { createDurableAgent } from '../agent/durable';
import { globalRunRegistry } from '../agent/durable/run-registry';
import { TOOL_COMPLETION_INDEX_TYPE } from '../agent/message-list/tool-completion-index';
import { Mastra } from '../mastra';
import { InMemoryStore } from '../storage';
import { createTool } from '../tools';
import { AgentController } from './agent-controller';
import { Session } from './session';
import type { AgentControllerEvent } from './types';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function fixture(durable: boolean, waitingFor?: 'user' | 'external') {
  const storage = new InMemoryStore({ id: `wait-${durable}-${waitingFor}` });
  const memory = new Memory({ storage });
  const received: unknown[] = [];
  const prompts: unknown[] = [];
  let modelCalls = 0;
  const model = new MockLanguageModelV3({
    provider: 'openai',
    modelId: 'gpt-4o',
    doStream: async options => {
      prompts.push(options.prompt);
      return {
        stream: simulateReadableStream({
          chunks:
            ++modelCalls === 1
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'wait-1',
                    toolName: 'wait',
                    input: '{}',
                    providerExecuted: false,
                  },
                  {
                    type: 'finish' as const,
                    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
                    usage,
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'done' },
                  { type: 'text-delta' as const, id: 'done', delta: 'Completed.' },
                  { type: 'text-end' as const, id: 'done' },
                  { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage },
                ],
        }),
      };
    },
  });
  const build = () => {
    const base = new Agent({
      id: 'waiting-agent',
      name: 'Waiting agent',
      instructions: 'Use wait once.',
      model,
      memory,
      tools: {
        wait: createTool({
          id: 'wait',
          description: 'Wait for a result.',
          inputSchema: z.object({}),
          suspendSchema: z.object({ message: z.string() }),
          resumeSchema: z.boolean(),
          execute: async (_input, context) => {
            received.push(context?.agent?.resumeData);
            if (context?.agent?.resumeData !== undefined) return { accepted: context.agent.resumeData };
            return context?.agent?.suspend(
              { message: 'Waiting.' },
              waitingFor === undefined ? undefined : { waitingFor },
            );
          },
        }),
      },
      defaultOptions: { maxSteps: 3 },
    });
    const agent = durable ? (createDurableAgent({ agent: base }) as unknown as Agent) : base;
    const controller = new AgentController({
      id: 'waiting-controller',
      agent,
      storage,
      memory,
      modes: [{ id: 'chat', name: 'Chat', metadata: { default: true } }],
      disableBuiltinTools: ['ask_user'],
    });
    const mastra = new Mastra({
      storage,
      agents: { waiting: agent },
      agentControllers: { waiting: controller },
      logger: false,
    });
    return { agent, controller, mastra };
  };
  return { storage, memory, received, build, prompts, modelCalls: () => modelCalls };
}

describe('native suspension waitingFor', () => {
  it.each(
    [false, true].flatMap(durable => [undefined, 'user', 'external'].map(waitingFor => ({ durable, waitingFor }))),
  )(
    'preserves $waitingFor through saved metadata, cold discovery and resume (durable=$durable)',
    async ({ durable, waitingFor }) => {
      const f = fixture(durable, waitingFor as 'user' | 'external' | undefined);
      let runtime = f.build();
      const expected = waitingFor ?? 'user';
      const first = await runtime.agent.stream('Wait.', { memory: { thread: 'wait-thread', resource: 'wait-user' } });
      let suspension: any;
      for await (const chunk of first.fullStream) {
        if (chunk.type === 'tool-call-suspended') {
          suspension = chunk;
          break;
        }
      }
      expect(suspension?.payload.waitingFor).toBe(expected);
      const workflows = (await f.storage.getStore('workflows'))!;
      await vi.waitFor(async () =>
        expect(
          (
            await workflows.loadWorkflowSnapshot({
              workflowName: durable ? 'durable-agentic-loop' : 'agentic-loop',
              runId: first.runId,
            })
          )?.status,
        ).toBe('suspended'),
      );
      const memory = (await f.storage.getStore('memory'))!;
      const { messages } = await memory.listMessages({ threadId: 'wait-thread' });
      const entries = messages.flatMap(message =>
        Object.values(message.content.metadata?.suspendedTools ?? {}),
      ) as any[];
      expect(entries.find(entry => entry.toolCallId === 'wait-1')?.waitingFor).toBe(expected);
      await runtime.mastra.stopEventEngine();
      globalRunRegistry.delete(first.runId);
      runtime = f.build();
      const saved = await runtime.agent.listSuspendedRuns({ threadId: 'wait-thread', resourceId: 'wait-user' });
      expect(saved.runs.flatMap(run => run.toolCalls)).toContainEqual(
        expect.objectContaining({
          toolCallId: 'wait-1',
          requiresApproval: false,
          waitingFor: expected,
        }),
      );
      await runtime.controller.init();
      const reloaded = await runtime.controller.createSession({
        resourceId: 'wait-user',
        threadId: 'wait-thread',
        ownerId: runtime.controller.id,
      });
      await reloaded.thread.ensureSubscription('wait-thread');
      await expect.poll(() => reloaded.displayState.get().pendingSuspensions.get('wait-1')?.waitingFor).toBe(expected);
      expect(reloaded.displayState.get().pendingApproval).toBeNull();
      await reloaded.respondToToolSuspension({ toolCallId: 'wait-1', resumeData: false });
      await expect.poll(() => f.received.length).toBe(2);
      await expect.poll(() => reloaded.displayState.get().pendingSuspensions.size).toBe(0);
      await expect.poll(() => reloaded.run.isRunning()).toBe(false);
      expect(f.received).toEqual([undefined, false]);
      await runtime.mastra.stopEventEngine();
    },
    25_000,
  );

  it.each([false, true])(
    'clears an external wait on native cancellation (durable=%s)',
    async durable => {
      const f = fixture(durable, 'external');
      const runtime = f.build();
      await runtime.controller.init();
      const session = await runtime.controller.createSession({
        resourceId: 'wait-user',
        threadId: 'wait-thread',
        ownerId: runtime.controller.id,
      });
      await session.state.set({ yolo: true });
      const events: AgentControllerEvent[] = [];
      session.subscribe(event => events.push(event));
      await session.sendMessage({ content: 'Wait.' });
      await expect.poll(() => session.displayState.get().pendingSuspensions.get('wait-1')?.waitingFor).toBe('external');
      expect(events).toContainEqual(expect.objectContaining({ type: 'tool_suspended', waitingFor: 'external' }));
      await expect.poll(() => session.run.isRunning()).toBe(false);
      const receipt = session.sendMessageWithReceipt({ content: 'Start a separate task.' });
      await expect(receipt.accepted).resolves.toMatchObject({ action: 'deliver' });
      expect(f.modelCalls()).toBe(1);
      expect(session.displayState.get().pendingSuspensions.get('wait-1')?.waitingFor).toBe('external');
      session.abort();
      await expect.poll(() => session.displayState.get().pendingSuspensions.size).toBe(0);
      expect(f.received).toEqual([undefined]);
      await runtime.mastra.stopEventEngine();
    },
    25_000,
  );

  it('defaults old events to user and cancels only the matching external wait', async () => {
    const session = new Session({ id: 'session', ownerId: 'owner', resourceId: 'resource' });
    session.emit({ type: 'tool_suspended', toolCallId: 'legacy', toolName: 'wait', args: {}, suspendPayload: {} });
    expect(session.displayState.get().pendingSuspensions.get('legacy')?.waitingFor).toBe('user');
    session.emit({
      type: 'tool_suspended',
      toolCallId: 'external',
      toolName: 'wait',
      args: {},
      suspendPayload: {},
      waitingFor: 'external',
    });
    session.emit({ type: 'tool_suspension_cancelled', toolCallId: 'external', toolName: 'wait', reason: 'Cancelled' });
    expect(session.displayState.get().pendingSuspensions.has('external')).toBe(false);
    expect(session.displayState.get().pendingSuspensions.has('legacy')).toBe(true);
  });

  it.each([false, true])(
    'delivers a queued message to the same run only after external resume (durable=%s)',
    async durable => {
      const f = fixture(durable, 'external');
      const runtime = f.build();
      await runtime.controller.init();
      const session = await runtime.controller.createSession({
        resourceId: 'wait-user',
        threadId: 'wait-thread',
        ownerId: runtime.controller.id,
      });
      await session.state.set({ yolo: true });
      const events: AgentControllerEvent[] = [];
      const activeRuns: Array<string | null> = [];
      session.subscribe(event => {
        events.push(event);
        if (event.type === 'agent_start') activeRuns.push(session.getCurrentRunId());
      });
      const first = await session.sendMessageWithReceipt({ content: 'Wait.' }).accepted;
      await expect.poll(() => session.displayState.get().pendingSuspensions.get('wait-1')?.waitingFor).toBe('external');
      await expect.poll(() => session.run.isRunning()).toBe(false);
      const second = await session.sendMessageWithReceipt({ content: 'Also explain the moon.' }).accepted;
      expect(second).toMatchObject({ action: 'deliver', runId: first.runId });
      expect(f.modelCalls()).toBe(1);
      await session.respondToToolSuspension({ toolCallId: 'wait-1', resumeData: true });
      await expect
        .poll(() => events.filter(event => event.type === 'agent_end' && event.reason !== 'suspended').length)
        .toBe(1);
      expect(JSON.stringify(f.prompts.slice(1))).toContain('Also explain the moon.');
      expect(events.filter(event => event.type === 'agent_start')).toHaveLength(2);
      expect(activeRuns).toEqual([first.runId, first.runId]);
      expect(f.modelCalls()).toBe(2);
      await runtime.mastra.stopEventEngine();
    },
    25_000,
  );
});

describe('durable completed output delivery', () => {
  it('commits callback results and the display index before a cold resumed tool_end', async () => {
    const f = fixture(true, 'external');
    let runtime = f.build();
    await runtime.controller.init();
    let session = await runtime.controller.createSession({
      resourceId: 'wait-user',
      threadId: 'wait-thread',
      ownerId: runtime.controller.id,
    });
    await session.state.set({ yolo: true });
    const receipt = await session.sendMessageWithReceipt({ content: 'Wait.' }).accepted;
    await expect.poll(() => session.displayState.get().pendingSuspensions.has('wait-1')).toBe(true);
    await expect.poll(() => session.run.isRunning()).toBe(false);
    const memory = (await f.storage.getStore('memory'))!;
    const initial = (await memory.listMessages({ threadId: 'wait-thread', perPage: false })).messages;
    const original = initial.find(message =>
      message.content.parts.some(
        part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'wait-1',
      ),
    )!;
    expect(original).toBeDefined();
    for (let i = 0; i < 30; i++)
      await session.recordMessage({ id: `later-${i}`, role: 'user', content: `Later voice turn ${i}.` });
    await runtime.mastra.stopEventEngine();
    globalRunRegistry.delete(receipt.runId!);
    runtime = f.build();
    await runtime.controller.init();
    session = await runtime.controller.createSession({
      resourceId: 'wait-user',
      threadId: 'wait-thread',
      ownerId: runtime.controller.id,
    });
    await session.thread.ensureSubscription('wait-thread');
    await expect.poll(() => session.displayState.get().pendingSuspensions.has('wait-1')).toBe(true);
    const threadState = (await f.storage.getStore('threadState'))!;
    const order: string[] = [];
    const save = memory.saveMessages.bind(memory);
    vi.spyOn(memory, 'saveMessages').mockImplementation(async input => {
      const result = await save(input);
      if (
        input.messages.some(message =>
          message.content.parts.some(
            part =>
              part.type === 'tool-invocation' &&
              part.toolInvocation.toolCallId === 'wait-1' &&
              part.toolInvocation.state === 'result',
          ),
        )
      )
        order.push('source');
      return result;
    });
    const set = threadState.setState.bind(threadState);
    vi.spyOn(threadState, 'setState').mockImplementation(async input => {
      await set(input);
      if (input.type === TOOL_COMPLETION_INDEX_TYPE) order.push('index');
    });
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => {
      events.push(event);
      if (event.type === 'tool_end' && event.toolCallId === 'wait-1') order.push('end');
    });
    // This is the same public command used by an external workflow callback.
    await runtime.agent.sendStreamResume({
      threadId: 'wait-thread',
      resourceId: 'wait-user',
      runId: receipt.runId!,
      toolCallId: 'wait-1',
      resumeData: true,
    });
    await expect
      .poll(() => events.filter(event => event.type === 'tool_end' && event.toolCallId === 'wait-1').length)
      .toBe(1);
    expect(order.indexOf('source')).toBeLessThan(order.indexOf('index'));
    expect(order.indexOf('index')).toBeLessThan(order.indexOf('end'));
    expect(events.find(event => event.type === 'tool_end')).toMatchObject({
      runId: receipt.runId,
      messageId: original.id,
      result: { accepted: true },
    });
    const history = await session.thread.listMessages({ threadId: 'wait-thread', limit: 24 });
    const resultRow = history.find(message => message.id === `${original.id}:tool-result:wait-1`)!;
    expect(resultRow).toBeDefined();
    expect(history.indexOf(resultRow)).toBeGreaterThan(history.findIndex(message => message.id === 'later-29'));
    expect(JSON.stringify(history).match(/"accepted":true/g)).toHaveLength(1);
    const raw = (await memory.listMessages({ threadId: 'wait-thread', perPage: false })).messages;
    expect(raw.find(message => message.id === original.id)?.createdAt).toEqual(original.createdAt);
    expect(raw.some(message => message.id.includes(':tool-result:'))).toBe(false);
    await expect.poll(() => f.modelCalls()).toBe(2);
    expect(JSON.stringify(f.prompts.at(-1)).match(/accepted/g)).toHaveLength(1);
    expect(
      raw
        .flatMap(message => message.content.parts)
        .filter(part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'wait-1'),
    ).toHaveLength(1);
    await runtime.mastra.stopEventEngine();
  }, 25_000);
});
