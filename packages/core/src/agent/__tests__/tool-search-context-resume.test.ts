import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockMemory } from '../../memory/mock';
import { ToolSearchProcessor } from '../../processors/processors/tool-search';
import { RequestContext } from '../../request-context';
import { createTool } from '../../tools';
import { Agent } from '../agent';

// Issue #24787: a resumed run (after a restart, run-registry expiry, or on another
// instance) rebuilds tools without a live processInputStep. With storage: 'context'
// the loaded set must come from the persisted thread messages.
describe('ToolSearchProcessor storage: context — resume tool rebuild', () => {
  const weather = createTool({
    id: 'weather',
    description: 'Get weather',
    inputSchema: z.object({ city: z.string() }),
    execute: async () => ({ temp: 20 }),
  });

  function createAgent(memory: MockMemory) {
    return new Agent({
      id: 'tool-search-agent',
      name: 'tool-search-agent',
      instructions: 'test',
      model: 'openai/gpt-4o-mini',
      memory,
      // A fresh processor instance models a new process: no same-process state.
      inputProcessors: [new ToolSearchProcessor({ tools: { weather }, storage: 'context' })],
    });
  }

  async function seedThread(memory: MockMemory, threadId: string, resourceId: string, withLoadResult: boolean) {
    await memory.saveThread({
      thread: { id: threadId, resourceId, title: 't', createdAt: new Date(), updatedAt: new Date() },
    });
    await memory.saveMessages({
      messages: [
        {
          id: 'u1',
          threadId,
          resourceId,
          role: 'user',
          createdAt: new Date(Date.now() - 1000),
          content: { format: 2, parts: [{ type: 'text', text: 'weather?' }] },
        },
        {
          id: 'a1',
          threadId,
          resourceId,
          role: 'assistant',
          createdAt: new Date(),
          content: {
            format: 2,
            parts: withLoadResult
              ? [
                  {
                    type: 'tool-invocation',
                    toolInvocation: {
                      state: 'result',
                      toolCallId: 'call-1',
                      toolName: 'load_tool',
                      args: { toolName: 'weather' },
                      result: { success: true, toolName: 'weather' },
                    },
                  },
                ]
              : [{ type: 'text', text: 'hi' }],
          },
        },
      ],
    });
  }

  it('restores search-loaded tools from persisted thread messages', async () => {
    const memory = new MockMemory();
    await seedThread(memory, 'thread-1', 'user-1', true);
    const agent = createAgent(memory);

    const tools = await agent.getToolsForExecution({
      threadId: 'thread-1',
      resourceId: 'user-1',
      requestContext: new RequestContext(),
    });

    expect(tools.weather).toBeDefined();
  });

  it('does not restore tools the thread never loaded', async () => {
    const memory = new MockMemory();
    await seedThread(memory, 'thread-2', 'user-1', false);
    const agent = createAgent(memory);

    const tools = await agent.getToolsForExecution({
      threadId: 'thread-2',
      resourceId: 'user-1',
      requestContext: new RequestContext(),
    });

    expect(tools.weather).toBeUndefined();
  });

  it.each([false, true])('restores persisted deferred history without inventory reads (known=%s)', async known => {
    const memory = new MockMemory();
    await seedThread(memory, 'deferred-thread', 'user-1', true);
    const inventory = vi.fn(async () => new Promise<never>(() => {}));
    const supplier = vi.fn(async ({ reason }: { reason?: string }) => {
      if (reason !== 'restore') return inventory();
      return known ? { weather: { id: 'weather', description: 'Get weather', resolve: async () => weather } } : {};
    });
    const processor = new ToolSearchProcessor({
      tools: {},
      storage: 'context',
      restoreDeferred: 'known-only',
      deferredTools: supplier,
    });
    const agent = new Agent({
      id: 'deferred-history-agent',
      name: 'deferred-history-agent',
      instructions: 'test',
      model: 'openai/gpt-4o-mini',
      memory,
      inputProcessors: [processor],
    });
    const requestContext = new RequestContext();
    const tools = await agent.getToolsForExecution({
      threadId: 'deferred-thread',
      resourceId: 'user-1',
      requestContext,
    });
    expect(Boolean(tools.weather)).toBe(known);
    expect(inventory).not.toHaveBeenCalled();
    expect(supplier).toHaveBeenCalledExactlyOnceWith({ requestContext, reason: 'restore', toolNames: ['weather'] });
    if (known)
      expect(tools.weather.parameters.jsonSchema).toEqual({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      });
    // Restoration did not rewrite persisted tool history or fabricate a cold schema.
    const messages = await memory.recall({ threadId: 'deferred-thread', resourceId: 'user-1' });
    expect(JSON.stringify(messages.messages)).toContain('load_tool');
    expect(JSON.stringify(messages.messages)).toContain('weather');
  });
});
