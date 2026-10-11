/**
 * End-to-end identity contract: the assistant message emitted over the live
 * stream must carry the same id as its persisted copy. Clients reconcile a
 * live transcript against refetched history by id — two ids for one turn
 * render the turn twice (doubled assistant bubble after an SSE reconnect).
 */
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';

import { Agent } from '../../agent';
import { MockMemory } from '../../memory/mock';
import { InMemoryStore } from '../../storage/mock';
import { AgentController } from '../agent-controller';
import { createMockWorkspace } from '../test-utils';
import type { AgentControllerEvent } from '../types';

function createTextStreamModel(responseText: string | (() => string)) {
  return new MockLanguageModelV2({
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'id-0', modelId: 'mock-model-id', timestamp: new Date(0) },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: typeof responseText === 'function' ? responseText() : responseText },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    }),
  });
}

describe('stream ↔ persisted message identity', () => {
  it('emits the assistant message under the id its persisted copy carries', async () => {
    const storage = new InMemoryStore();
    const agent = new Agent({
      id: 'test-agent',
      name: 'test-agent',
      model: createTextStreamModel('Good to hear.'),
      instructions: 'You are a test agent.',
      memory: new MockMemory({ storage }),
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
    await session.thread.create();
    const threadId = session.thread.requireId();

    const events: AgentControllerEvent[] = [];
    session.subscribe(event => {
      events.push(event);
    });

    await session.sendMessage({ content: 'It seems to work well actually' });

    const streamedStart = events.find(
      (event): event is Extract<AgentControllerEvent, { type: 'message_start' }> =>
        event.type === 'message_start' && event.message.role === 'assistant',
    );
    expect(streamedStart).toBeDefined();
    const streamedEnd = events.find(
      (event): event is Extract<AgentControllerEvent, { type: 'message_end' }> =>
        event.type === 'message_end' && event.id === streamedStart!.message.id,
    );
    expect(streamedEnd).toEqual({ type: 'message_end', id: streamedStart!.message.id });

    const persisted = await session.thread.listMessages({ threadId });
    const persistedAssistant = persisted.filter(message => message.role === 'assistant');
    expect(persistedAssistant).toHaveLength(1);
    expect(streamedStart!.message.id).toBe(persistedAssistant[0]!.id);
  }, 30000);

  it('edits a saved input and dispatches its new signal exactly once in the same thread', async () => {
    const storage = new InMemoryStore();
    let turn = 0;
    const model = createTextStreamModel(() => (turn++ === 0 ? 'Old answer' : 'Corrected answer.'));
    const agent = new Agent({
      id: 'edit-agent',
      name: 'edit-agent',
      model,
      instructions: 'Test.',
      memory: new MockMemory({ storage }),
    });
    const controller = new AgentController({
      workspace: createMockWorkspace(),
      id: 'edit-controller',
      storage,
      resourceId: 'edit-resource',
      modes: [{ id: 'build', agent }],
      defaultModeId: 'build',
    });
    await controller.init();
    const session = await controller.createSession({ id: 'edit-session', ownerId: 'edit-owner' });
    await controller.getMastra()?.startWorkers();
    try {
      await session.thread.create();
      const threadId = session.thread.requireId();
      const original = session.sendMessageWithReceipt({ id: 'old-input', content: 'Old input' });
      await original.accepted;
      await vi.waitFor(
        async () => {
          expect(session.run.isRunning()).toBe(false);
          expect(
            (await session.thread.listMessages({ threadId })).filter(row => row.role === 'assistant'),
          ).toHaveLength(1);
        },
        { timeout: 10000 },
      );
      const oldRows = await session.thread.listMessages({ threadId });
      const oldAnswerId = oldRows.find(row => row.role === 'assistant')!.id;
      const ended = new Promise<void>(resolve =>
        session.subscribe(event => {
          if (event.type === 'message_end') resolve();
        }),
      );
      const result = await session.editMessage({ messageId: 'old-input', content: 'Corrected input' });
      expect(result).toMatchObject({ saved: true, accepted: true, threadId });
      await ended;
      await vi.waitFor(
        async () => {
          expect(session.run.isRunning()).toBe(false);
          expect(
            (await session.thread.listMessages({ threadId })).filter(row => row.role === 'assistant'),
          ).toHaveLength(1);
        },
        { timeout: 10000 },
      );
      const rows = await session.thread.listMessages({ threadId });
      expect(rows.filter(row => row.id === result.messageId)).toHaveLength(1);
      expect(rows.some(row => row.id === 'old-input' || row.id === oldAnswerId)).toBe(false);
      expect(rows.filter(row => row.role === 'assistant')).toHaveLength(1);
      expect(session.thread.requireId()).toBe(threadId);
      expect(model.doStreamCalls).toHaveLength(2);
      const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
      expect(prompt).toContain('Corrected input');
      expect(prompt).not.toContain('Old answer');
      expect(prompt).not.toContain('Old input');
      expect(prompt.match(/Corrected input/g)).toHaveLength(1);
    } finally {
      await controller.getMastra()?.shutdown();
    }
  }, 30000);
});
