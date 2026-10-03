import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { Agent } from '../agent';
import { MockMemory } from '../memory/mock';
import { InMemoryStore } from '../storage/mock';
import { createTool } from './tool';
import { executionStartHook, TOOL_EXECUTION_START } from './tool-execution-events';
import { executeToolWithPolicy } from './tool-policy-execution';

const invocation = (onStart: (input: unknown) => Promise<void>, abortSignal?: AbortSignal) => ({
  ...executionStartHook(onStart),
  toolCallId: 'call-1',
  messages: [],
  abortSignal,
});

describe('native admitted tool execution', () => {
  it.each([false, true])('starts once with validated input before body (converted=%s)', async converted => {
    const order: string[] = [];
    const execute = vi.fn(async (input, context) => {
      order.push('body');
      expect(context[TOOL_EXECUTION_START]).toBeUndefined();
      return input;
    });
    const native = createTool({
      id: 'work',
      description: 'Work',
      inputSchema: z.object({ amount: z.string() }).transform(({ amount }) => ({ amount: Number(amount) })),
      execute,
    });
    const agent = new Agent({
      id: 'convert',
      name: 'Convert',
      instructions: 'Test',
      model: 'openai/gpt-4.1-mini',
      tools: { work: native },
    });
    const tool = converted ? (await agent.getToolsForExecution({})).work! : native;
    const start = vi.fn(async input => {
      expect(input).toEqual({ amount: 4 });
      order.push('start');
    });
    expect(
      await executeToolWithPolicy(tool, 'work', { amount: '4' }, invocation(start), () => ({ allowed: true })),
    ).toEqual({ amount: 4 });
    expect(order).toEqual(['start', 'body']);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each(['validation', 'policy', 'abort'])('never starts a rejected call (%s)', async reason => {
    const execute = vi.fn(async () => 'done');
    const tool = createTool({ id: 'work', description: 'Work', inputSchema: z.object({ value: z.string() }), execute });
    const start = vi.fn(async () => {});
    const abort = new AbortController();
    if (reason === 'abort') abort.abort();
    const promise = executeToolWithPolicy(
      tool,
      'work',
      { value: reason === 'validation' ? 3 : 'accepted' },
      invocation(start, abort.signal),
      () => (reason === 'policy' ? { allowed: false, error: { error: true, message: 'Denied' } } : { allowed: true }),
    );
    if (reason === 'abort') await expect(promise).rejects.toThrow();
    else await promise;
    expect(execute).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('starts a raw processor tool and never leaks native metadata', async () => {
    const start = vi.fn(async () => {});
    const execute = vi.fn(async (_input, context) => {
      expect(context[TOOL_EXECUTION_START]).toBeUndefined();
      return 'ok';
    });
    expect(await executeToolWithPolicy({ execute }, 'raw', {}, invocation(start))).toBe('ok');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('does not turn a thrown body error into success', async () => {
    const start = vi.fn(async () => {});
    const tool = createTool({
      id: 'work',
      description: 'Work',
      execute: async () => {
        throw new Error('failed');
      },
    });
    await expect(executeToolWithPolicy(tool, 'work', {}, invocation(start))).rejects.toThrow('failed');
    expect(start).toHaveBeenCalledTimes(1);
  });
});

it.each([true, false])('the real Agent stream reports admitted execution truth (allowed=%s)', async allowed => {
  let step = 0;
  const calls: string[] = [];
  const storage = new InMemoryStore();
  const memory = new MockMemory({ storage });
  const model = new MockLanguageModelV2({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        ...(step++ === 0
          ? [{ type: 'tool-call' as const, toolCallId: 'call-real', toolName: 'work', input: '{}' }]
          : [
              { type: 'text-start' as const, id: 'text' },
              { type: 'text-delta' as const, id: 'text', delta: 'Done' },
              { type: 'text-end' as const, id: 'text' },
            ]),
        {
          type: 'finish',
          finishReason: step === 1 ? 'tool-calls' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    }),
  });
  const agent = new Agent({
    id: 'stream-proof',
    name: 'Stream proof',
    instructions: 'Test',
    model,
    memory,
    toolPolicy: ({ phase }) =>
      phase !== 'execute' || allowed ? { allowed: true } : { allowed: false, error: { message: 'Policy rejected' } },
    tools: {
      work: createTool({
        id: 'work',
        description: 'Work',
        inputSchema: z.object({}),
        execute: async () => {
          calls.push('body');
          return 'Actual result';
        },
      }),
    },
  });
  const stream = await agent.stream('Run', {
    memory: { thread: 'native-stream', resource: 'owner' },
    onChunk: chunk => {
      if (chunk.type === 'tool-execution-start') calls.push('start');
    },
  });
  const chunks: any[] = [];
  for await (const chunk of stream.fullStream) chunks.push(chunk);
  expect(calls).toEqual(allowed ? ['start', 'body'] : []);
  const outcome = chunks.find(chunk => chunk.type === 'tool-result');
  expect(outcome?.payload.isError).toBe(!allowed);
  if (allowed) {
    const index = await (await storage.getStore('threadState'))!.getState({
      threadId: 'native-stream',
      type: 'recent-tool-completions',
    });
    expect(index).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: outcome.payload.messageId })]));
  }
});
