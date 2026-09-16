import { anthropic } from '@ai-sdk/anthropic-v5';
import { Memory } from '@mastra/memory';
import { MockLanguageModelV3 } from 'ai/test';
import { expect, it, vi } from 'vitest';
import { Agent } from '../agent';
import { createDurableAgent } from '../agent/durable';
import { TOOL_COMPLETION_INDEX_TYPE } from '../agent/message-list/tool-completion-index';
import { Mastra } from '../mastra';
import { InMemoryStore } from '../storage';
import { AgentController } from './agent-controller';
import type { AgentControllerEvent } from './types';

it.each([false, true].flatMap(durable => [false, true].map(nullResult => ({ durable, nullResult }))))(
  'commits a provider tool before announcing completion while later text is still pending (durable=$durable, null=$nullResult)',
  async ({ durable, nullResult }) => {
    const storage = new InMemoryStore();
    const memory = new Memory({ storage });
    let allowRemainingText!: () => void;
    const remainingText = new Promise<void>(resolve => {
      allowRemainingText = resolve;
    });
    let allowFinalResult!: () => void;
    const finalResult = new Promise<void>(resolve => {
      allowFinalResult = resolve;
    });
    const order: string[] = [];
    let calls = 0;
    const model = new MockLanguageModelV3({
      provider: 'anthropic',
      modelId: 'claude-test',
      doStream: async () => {
        calls++;
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: 'text-start', id: 'before' });
              controller.enqueue({ type: 'text-delta', id: 'before', delta: 'Checking. ' });
              controller.enqueue({ type: 'text-end', id: 'before' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'search-1',
                toolName: 'web_search',
                input: '{}',
                providerExecuted: true,
              });
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: { progress: 'Searching' },
                providerExecuted: true,
                preliminary: true,
              });
              await finalResult;
              order.push('provider-result');
              controller.enqueue({
                type: 'tool-result',
                toolCallId: 'search-1',
                toolName: 'web_search',
                result: nullResult ? null : { found: 'Saved fact' },
                providerExecuted: true,
              });
              await remainingText;
              order.push('later-text');
              controller.enqueue({ type: 'text-start', id: 'after' });
              controller.enqueue({ type: 'text-delta', id: 'after', delta: 'Here is the answer.' });
              controller.enqueue({ type: 'text-end', id: 'after' });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        };
      },
    });
    const base = new Agent({
      id: 'provider-agent',
      name: 'Provider agent',
      instructions: 'Search.',
      model,
      memory,
      tools: { web_search: anthropic.tools.webSearch_20250305({}) },
    });
    const agent = durable ? (createDurableAgent({ agent: base }) as unknown as Agent) : base;
    const controller = new AgentController({
      id: 'provider-controller',
      agent,
      memory,
      storage,
      modes: [{ id: 'chat', name: 'Chat', metadata: { default: true } }],
      disableBuiltinTools: ['ask_user'],
    });
    const mastra = new Mastra({
      storage,
      agents: { provider: agent },
      agentControllers: { provider: controller },
      logger: false,
    });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'owner', threadId: 'thread', ownerId: controller.id });
    await session.state.set({ yolo: true });
    const memoryStore = (await storage.getStore('memory'))!;
    const threadState = (await storage.getStore('threadState'))!;
    const save = memoryStore.saveMessages.bind(memoryStore);
    vi.spyOn(memoryStore, 'saveMessages').mockImplementation(async input => {
      const value = await save(input);
      if (
        input.messages.some(message =>
          message.content.parts.some(
            part =>
              part.type === 'tool-invocation' &&
              part.toolInvocation.state === 'result' &&
              part.providerMetadata?.mastra?.toolCompletion,
          ),
        )
      )
        order.push('source');
      return value;
    });
    const set = threadState.setState.bind(threadState);
    vi.spyOn(threadState, 'setState').mockImplementation(async input => {
      await set(input);
      if (input.type === TOOL_COMPLETION_INDEX_TYPE) order.push('index');
    });
    const events: AgentControllerEvent[] = [];
    session.subscribe(event => {
      events.push(event);
      if (event.type === 'tool_end' && event.toolCallId === 'search-1') {
        order.push('end');
        allowRemainingText();
      }
    });
    try {
      await session.sendMessageWithReceipt({ content: 'Search now.' }).accepted;
      await expect.poll(() => events.some(event => event.type === 'tool_update' && event.preliminary)).toBe(true);
      expect(events.some(event => event.type === 'tool_end')).toBe(false);
      expect(await threadState.getState({ threadId: 'thread', type: TOOL_COMPLETION_INDEX_TYPE })).toBeUndefined();
      const pending = await session.thread.listMessages({ threadId: 'thread', limit: 24 });
      expect(pending.some(message => message.id.includes(':tool-result:'))).toBe(false);
      allowFinalResult();
      await expect.poll(() => events.some(event => event.type === 'agent_end')).toBe(true);
      expect(events.filter(event => event.type === 'tool_end' && event.toolCallId === 'search-1')).toHaveLength(1);
      expect(order.indexOf('provider-result')).toBeLessThan(order.indexOf('source'));
      expect(order.indexOf('source')).toBeLessThan(order.indexOf('index'));
      expect(order.indexOf('index')).toBeLessThan(order.indexOf('end'));
      expect(order.indexOf('end')).toBeLessThan(order.indexOf('later-text'));
      expect(
        events
          .filter(event => event.type === 'text_delta')
          .map(event => event.textDelta)
          .join(''),
      ).toBe('Checking. Here is the answer.');
      const raw = (await memoryStore.listMessages({ threadId: 'thread', perPage: false })).messages;
      expect(
        raw
          .flatMap(message => message.content.parts)
          .filter(part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === 'search-1'),
      ).toHaveLength(1);
      const rawText = raw
        .flatMap(message => message.content.parts)
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
      expect(rawText.match(/Checking\./g)).toHaveLength(1);
      expect(rawText.match(/Here is the answer\./g)).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      allowFinalResult();
      allowRemainingText();
      await mastra.stopEventEngine();
    }
  },
  25000,
);
