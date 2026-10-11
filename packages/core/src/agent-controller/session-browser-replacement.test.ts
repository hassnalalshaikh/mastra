import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDurableAgent } from '../agent/durable';
import type { MastraBrowser } from '../browser';
import { createTool } from '../tools';
import { createTestAgent, createTestController } from './test-utils';

const browser = () => {
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    close,
    retire: vi.fn(() => close()),
    getActivityState: () => ({ activeOperations: 0 }),
  } as unknown as MastraBrowser;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('owned Session browser replacement', () => {
  it.each([false, true])(
    'routes registered agent tools to each replacement without replacing the chat (durable=%s)',
    async durable => {
      const calls: string[] = [];
      const model = new MockLanguageModelV2({
        doGenerate: async () => ({
          content: [{ type: 'tool-call', toolCallId: 'fixture', toolName: 'browser_fixture', input: '{}' }],
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }),
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'fixture',
                toolName: 'browser_fixture',
                input: '{}',
              });
              controller.enqueue({
                type: 'finish',
                finishReason: 'tool-calls',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              });
              controller.close();
            },
          }),
        }),
      });
      const base = createTestAgent({ model });
      const agent = durable ? createDurableAgent({ agent: base }) : base;
      let selected = 'cloudflare';
      const controller = createTestController({
        agent,
        browser: async () => {
          const provider = selected;
          return {
            ...browser(),
            id: provider,
            provider,
            providerType: 'sdk',
            headless: true,
            getTools: () => ({
              browser_fixture: createTool({
                id: 'browser_fixture',
                description: 'Read the current browser fixture',
                inputSchema: z.object({}),
                execute: async () => {
                  calls.push(provider);
                  return { provider };
                },
              }),
            }),
            getInputProcessors: () => [],
            hasThreadSession: () => true,
            isBrowserRunning: () => true,
            getSessionId: () => provider,
            getBrowserState: async () => ({ tabs: [{ url: 'https://example.com/' + provider }], activeTabIndex: 0 }),
          } as unknown as MastraBrowser;
        },
      });
      await controller.init();
      const session = await controller.createSession({ resourceId: 'user', scope: 'chat' });
      const threadId = session.thread.getId();
      for (const provider of ['cloudflare', 'firecrawl', 'cloudflare']) {
        if (selected !== provider) {
          selected = provider;
          await controller.replaceSessionBrowser(session);
        }
        const result = await agent.generate('Read my browser', {
          requestContext: await session.machinery.buildRequestContext(),
          maxSteps: 1,
        });
        expect(result.toolResults[0]?.payload.result).toEqual({ provider });
        expect(await controller.getSessionByResource('user', 'chat')).toBe(session);
        expect(session.thread.getId()).toBe(threadId);
      }
      expect(calls).toEqual(['cloudflare', 'firecrawl', 'cloudflare']);
      await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
    },
  );
  it('closes the previous provider and transfers deletion ownership without changing the chat', async () => {
    const first = browser();
    const second = browser();
    const controller = createTestController({ browser: async () => first });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'user', scope: 'chat', threadId: 'chat' });
    const id = session.identity.getId();
    const subscription = session.stream;
    await expect(controller.replaceSessionBrowser(session, { browser: async () => second })).resolves.toBe(second);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.retire).toHaveBeenCalledOnce();
    expect(session.browser).toBe(second);
    expect(session.identity.getId()).toBe(id);
    expect(session.thread.getId()).toBe('chat');
    expect(session.stream).toBe(subscription);
    expect(await controller.getSessionByResource('user', 'chat')).toBe(session);
    await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('keeps the old owner and does not create the next provider when closing fails', async () => {
    const first = browser();
    vi.mocked(first.close).mockRejectedValueOnce(new Error('provider deletion failed'));
    const factory = vi.fn(async () => browser());
    const controller = createTestController({ browser: async () => first });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'user', scope: 'chat' });
    await expect(controller.replaceSessionBrowser(session, { browser: factory })).rejects.toThrow(
      'provider deletion failed',
    );
    expect(session.browser).toBe(first);
    expect(factory).not.toHaveBeenCalled();
    await controller.replaceSessionBrowser(session, { browser: factory });
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
    await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
  });

  it('rejects simultaneous replacement and message startup while provider closure is pending', async () => {
    const first = browser();
    const closing = deferred();
    const started = deferred();
    vi.mocked(first.close).mockImplementationOnce(() => {
      started.resolve();
      return closing.promise;
    });
    const controller = createTestController({ browser: async () => first });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'user', scope: 'chat' });
    const replacement = controller.replaceSessionBrowser(session, { browser: async () => browser() });
    await started.promise;
    await expect(controller.replaceSessionBrowser(session)).rejects.toThrow('in progress');
    await expect(session.sendMessage({ content: 'Start browsing' })).rejects.toThrow('browser replacement');
    await expect(session.queueMessage({ content: 'Queue browsing' })).rejects.toThrow('browser replacement');
    closing.resolve();
    await replacement;
    await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
  });

  it('rejects active runs and preserves unrelated user/chat browsers', async () => {
    const controller = createTestController({ browser: async () => browser() });
    await controller.init();
    const first = await controller.createSession({ resourceId: 'user-a', scope: 'chat-a' });
    const other = await controller.createSession({ resourceId: 'user-b', scope: 'chat-b' });
    const otherBrowser = other.browser;
    const running = vi.spyOn(first.run, 'isRunning').mockReturnValue(true);
    await expect(controller.replaceSessionBrowser(first)).rejects.toThrow('active Session');
    expect(first.browser!.close).not.toHaveBeenCalled();
    running.mockRestore();
    await controller.replaceSessionBrowser(first);
    expect(other.browser).toBe(otherBrowser);
    expect(otherBrowser!.close).not.toHaveBeenCalled();
    await controller.deleteSession({ resourceId: 'user-a', scope: 'chat-a' });
    await controller.deleteSession({ resourceId: 'user-b', scope: 'chat-b' });
  });
});
