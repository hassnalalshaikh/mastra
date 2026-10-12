import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import { EventEmitterPubSub } from '../../events/event-emitter';
import { InMemoryStore } from '../../storage/mock';
import { AgentController } from '../agent-controller';
import type { AgentControllerEvent } from '../types';

/** A model whose runs stay open until the test closes their stream; records each prompt and abort. */
function makeHeldRuns(id: string, pubsub?: EventEmitterPubSub) {
  const prompts: unknown[] = [];
  const aborted: number[] = [];
  const sources: ReadableStreamDefaultController<any>[] = [];
  const agent = new Agent({
    id,
    name: 'Follow-up identity test',
    instructions: 'Reply briefly.',
    ...(pubsub ? { pubsub } : {}),
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

async function startSession(id: string, pubsub?: EventEmitterPubSub) {
  const runs = makeHeldRuns(id, pubsub);
  const controller = new AgentController({
    id: `${id}-controller`,
    storage: new InMemoryStore(),
    modes: [{ id: 'default', name: 'Default', default: true, agent: runs.agent }],
  });
  await controller.init();
  const session = await controller.createSession({ resourceId: `${id}-owner` });
  const first = session.sendMessage({ content: 'Hold the first instruction.' });
  void first.catch(() => {});
  await vi.waitFor(() => {
    expect(runs.prompts).toHaveLength(1);
    expect(session.displayState.get().isRunning).toBe(true);
  });
  return { ...runs, controller, session, first };
}

describe('follow-up identity by id (no text matching needed)', () => {
  it('lists each follow-up with its id and file names, and the message it becomes carries the same id', async () => {
    const { controller, session, prompts, finish, first } = await startSession('follow-up-identity');
    const started: string[] = [];
    session.subscribe((event: AgentControllerEvent) => {
      if (event.type === 'message_start' && event.message.role !== 'assistant') started.push(event.message.id);
    });
    try {
      await session.followUp({
        id: 'chosen-follow-up-id',
        content: 'Look at this',
        files: [{ data: Buffer.from('x').toString('base64'), mediaType: 'application/pdf', filename: 'report.pdf' }],
      });
      await session.followUp({ content: 'Look at this' });
      const items = session.displayState.get().queuedFollowUpItems;
      expect(items[0]).toEqual({
        id: 'chosen-follow-up-id',
        content: 'Look at this',
        files: [{ mediaType: 'application/pdf', filename: 'report.pdf' }],
      });
      // Same text, its own id, and no files: told apart by id and files, never by text.
      expect(items[1]).toMatchObject({ content: 'Look at this', files: [] });
      expect(items[1]!.id).not.toBe('chosen-follow-up-id');
      expect(JSON.stringify(items)).not.toContain(Buffer.from('x').toString('base64'));
      // A second follow-up with a queued id is refused.
      await expect(session.followUp({ id: 'chosen-follow-up-id', content: 'again' })).rejects.toThrow('already queued');

      finish(0);
      await first;
      await vi.waitFor(() => expect(started).toContain('chosen-follow-up-id'));
      finish(1);
      await vi.waitFor(() => expect(started).toContain(items[1]!.id));
      finish(2);
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
      expect(prompts).toHaveLength(3);
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('a plain send keeps the id it is given', async () => {
    const { controller, session, prompts, finish, first } = await startSession('follow-up-identity-send');
    const started: string[] = [];
    session.subscribe((event: AgentControllerEvent) => {
      if (event.type === 'message_start' && event.message.role !== 'assistant') started.push(event.message.id);
    });
    try {
      finish(0);
      await first;
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
      const sent = session.sendMessage({ id: 'plain-send-id', content: 'Plain' });
      void sent.catch(() => {});
      await vi.waitFor(() => expect(started).toContain('plain-send-id'));
      finish(1);
      await sent;
      expect(prompts).toHaveLength(2);
    } finally {
      await controller.destroy();
    }
  }, 15_000);
});
