import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import { EventEmitterPubSub } from '../../events/event-emitter';
import { InMemoryStore } from '../../storage/mock';
import { AgentController } from '../agent-controller';
import type { AgentControllerEvent } from '../types';

/** In-process PubSub whose lease handoff can be held, to catch a queued run while it is starting. */
class HeldLeasePubSub extends EventEmitterPubSub {
  hold: Promise<void> | undefined;
  heldCalls = 0;

  override async acquireLease(key: string, owner: string, ttlMs: number) {
    if (this.hold) {
      this.heldCalls += 1;
      await this.hold;
    }
    return super.acquireLease(key, owner, ttlMs);
  }

  override async transferLease(key: string, fromOwner: string, toOwner: string, ttlMs: number) {
    if (this.hold) {
      this.heldCalls += 1;
      await this.hold;
    }
    return super.transferLease(key, fromOwner, toOwner, ttlMs);
  }
}

/** A model whose runs stay open until the test closes their stream; records each prompt and abort. */
function makeHeldRuns(id: string, pubsub?: EventEmitterPubSub) {
  const prompts: unknown[] = [];
  const aborted: number[] = [];
  const sources: ReadableStreamDefaultController<any>[] = [];
  const agent = new Agent({
    id,
    name: 'Steer follow-up test',
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

const occurrences = (prompt: unknown, text: string) => JSON.stringify(prompt).split(text).length - 1;

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

describe('Session.steerFollowUp', () => {
  it('takes a waiting follow-up off the queue and steers with it, files included, exactly once', async () => {
    const { controller, session, prompts, aborted, finish } = await startSession('steer-follow-up-taken');
    try {
      await session.followUp({
        content: 'Check the attached notes now.',
        files: [{ data: Buffer.from('note body').toString('base64'), mediaType: 'text/plain', filename: 'notes.txt' }],
      });
      await session.followUp({ content: 'Then write the summary.' });
      const [steerItem, laterItem] = session.displayState.get().queuedFollowUpItems;

      const result = session.steerFollowUp({ id: steerItem!.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      void result.delivery.catch(() => {});

      // Taken in the same step: the list no longer offers it, the other follow-up stays queued.
      expect(session.displayState.get().queuedFollowUpItems).toEqual([laterItem]);
      // A second press of the same row is refused and changes nothing.
      expect(session.steerFollowUp({ id: steerItem!.id })).toEqual({ ok: false, reason: 'not_queued' });

      // The running turn was steered: aborted, and the next model call carries the follow-up and its file.
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(aborted).toContain(0);
      expect(occurrences(prompts[1], 'Check the attached notes now.')).toBe(1);
      expect(JSON.stringify(prompts[1])).toContain('notes.txt');
      expect(occurrences(prompts[1], 'Then write the summary.')).toBe(0);

      // The other follow-up still runs after the steered turn, once; the steered text is never sent again
      // (this agent has no memory, so each model call carries only its own new input).
      finish(1);
      await result.delivery;
      await vi.waitFor(() => expect(prompts).toHaveLength(3));
      expect(occurrences(prompts[2], 'Then write the summary.')).toBe(1);
      expect(occurrences(prompts[2], 'Check the attached notes now.')).toBe(0);
      finish(2);
      await vi.waitFor(() => {
        expect(session.displayState.get().isRunning).toBe(false);
        expect(session.displayState.get().queuedFollowUpItems).toEqual([]);
      });
      expect(prompts).toHaveLength(3);
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('refuses a follow-up a run already took between paint and click: no abort, no second send', async () => {
    const { controller, session, prompts, aborted, finish, first } = await startSession('steer-follow-up-drained');
    try {
      await session.followUp({ content: 'Drained before the click.' });
      const [painted] = session.displayState.get().queuedFollowUpItems;

      // The run ends and the queue hands the follow-up to the next run before the click arrives.
      finish(0);
      await first;
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(occurrences(prompts[1], 'Drained before the click.')).toBe(1);

      expect(session.steerFollowUp({ id: painted!.id })).toEqual({ ok: false, reason: 'not_queued' });
      expect(session.displayState.get().isRunning).toBe(true);

      finish(1);
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
      expect(aborted).toEqual([]);
      expect(prompts).toHaveLength(2);
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('refuses a follow-up whose run is already starting, and that run goes ahead untouched', async () => {
    const pubsub = new HeldLeasePubSub();
    const { controller, session, prompts, aborted, finish, first } = await startSession(
      'steer-follow-up-starting',
      pubsub,
    );
    try {
      await session.followUp({ content: 'Starting when clicked.' });
      const [painted] = session.displayState.get().queuedFollowUpItems;

      let release!: () => void;
      pubsub.hold = new Promise<void>(resolve => (release = resolve));
      finish(0);
      await first;
      // The queue has picked the follow-up for the next run and is waiting for the thread lease.
      await vi.waitFor(() => expect(pubsub.heldCalls).toBeGreaterThan(0));

      expect(session.steerFollowUp({ id: painted!.id })).toEqual({ ok: false, reason: 'not_queued' });

      pubsub.hold = undefined;
      release();
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(occurrences(prompts[1], 'Starting when clicked.')).toBe(1);
      finish(1);
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
      expect(aborted).toEqual([]);
      expect(prompts).toHaveLength(2);
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('refuses an id this Session never queued without touching the run', async () => {
    const { controller, session, prompts, aborted, finish, first } = await startSession('steer-follow-up-unknown');
    try {
      expect(session.steerFollowUp({ id: 'follow-up-never-queued' })).toEqual({ ok: false, reason: 'not_queued' });
      expect(session.displayState.get().isRunning).toBe(true);
      finish(0);
      await first;
      expect(aborted).toEqual([]);
      expect(prompts).toHaveLength(1);
    } finally {
      await controller.destroy();
    }
  }, 15_000);
});

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

  it('steers with a queued follow-up under its own id, and a plain send keeps the id it is given', async () => {
    const { controller, session, prompts, finish } = await startSession('follow-up-identity-steer');
    const started: string[] = [];
    session.subscribe((event: AgentControllerEvent) => {
      if (event.type === 'message_start' && event.message.role !== 'assistant') started.push(event.message.id);
    });
    try {
      await session.followUp({ id: 'steer-me', content: 'Now this' });
      const result = session.steerFollowUp({ id: 'steer-me' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      void result.delivery.catch(() => {});
      await vi.waitFor(() => expect(started).toContain('steer-me'));
      finish(1);
      await result.delivery;
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
      const sent = session.sendMessage({ id: 'plain-send-id', content: 'Plain' });
      void sent.catch(() => {});
      await vi.waitFor(() => expect(started).toContain('plain-send-id'));
      finish(2);
      await sent;
      expect(prompts).toHaveLength(3);
    } finally {
      await controller.destroy();
    }
  }, 15_000);
});
