import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import { InMemoryStore } from '../../storage/mock';
import { AgentController } from '../agent-controller';
import type { AgentControllerEvent } from '../types';

/** A model whose runs stay open until the test closes their stream. */
function makeHeldRuns(id: string) {
  const prompts: unknown[] = [];
  const sources: ReadableStreamDefaultController<any>[] = [];
  const agent = new Agent({
    id,
    name: 'Follow-up queue test',
    instructions: 'Reply briefly.',
    model: new MockLanguageModelV2({
      doStream: async ({ prompt }) => {
        const index = prompts.length;
        prompts.push(prompt);
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
  return { agent, prompts, finish };
}

describe('Session follow-up queue items', () => {
  it('keeps the original files and queue order when steering is refused', async () => {
    const { agent, prompts, finish } = makeHeldRuns('refused-steer-file');
    const controller = new AgentController({
      id: 'refused-steer-file-controller',
      storage: new InMemoryStore(),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    try {
      await controller.init();
      const session = await controller.createSession({ resourceId: 'refused-steer-owner' });
      const first = session.sendMessage({ content: 'Hold.' });
      void first.catch(() => {});
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      await session.followUp({ content: 'Earlier row' });
      await session.followUp({ content: '', files: [{ data: 'KEPT', mediaType: 'text/plain', filename: 'kept.txt' }] });
      const rows = session.followUps.list();
      const abort = vi.spyOn(session, 'abort').mockImplementationOnce(() => {
        throw new Error('abort refused');
      });
      await expect(session.steer({ content: '', followUpId: rows[1]!.id })).rejects.toThrow('abort refused');
      expect(session.followUps.list()).toEqual(rows);
      abort.mockRestore();
      session.followUps.clear();
      finish(0);
      await first;
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('promotes a queued file message by native id without a remove/send race', async () => {
    const { agent, prompts, finish } = makeHeldRuns('promote-file');
    const controller = new AgentController({
      id: 'promote-file-controller',
      storage: new InMemoryStore(),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    try {
      await controller.init();
      const session = await controller.createSession({ resourceId: 'promote-file-owner' });
      const first = session.sendMessage({ content: 'Hold.' });
      void first.catch(() => {});
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      await session.followUp({ content: 'Other queued message' });
      await session.followUp({
        content: '',
        files: [{ data: 'PROMOTED_FILE', mediaType: 'text/plain', filename: 'promoted.txt' }],
      });
      const selected = session.followUps.list()[1]!;
      await expect(
        session.steer({ content: 'must not replace the native row', followUpId: 'missing' }),
      ).rejects.toThrow('no longer available');
      expect(session.followUps.count()).toBe(2);
      expect(session.run.isRunning()).toBe(true);
      await session.steer({ content: 'must not replace the native row', followUpId: selected.id });
      expect(session.followUps.count()).toBe(2);
      expect(session.followUps.list()[0]!.id).toBe(selected.id);
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(JSON.stringify(prompts[1])).toContain('PROMOTED_FILE');
      expect(JSON.stringify(prompts[1])).not.toContain('must not replace');
      expect(session.followUps.list().map(item => item.content)).toEqual(['Other queued message']);
      finish(1);
      await vi.waitFor(() => expect(prompts).toHaveLength(3));
      finish(2);
      await first.catch(() => {});
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('keeps files in native queue snapshots and converts them when a queued message runs', async () => {
    const { agent, prompts, finish } = makeHeldRuns('queued-files');
    const controller = new AgentController({
      id: 'queued-files-controller',
      storage: new InMemoryStore(),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    try {
      await controller.init();
      const session = await controller.createSession({ resourceId: 'queued-files-owner' });
      const first = session.sendMessage({ content: 'Hold.' });
      void first.catch(() => {});
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      const files = [
        {
          data: 'data:text/plain;base64,' + Buffer.from('KEPT_FILE_DATA').toString('base64'),
          mediaType: 'text/plain',
          filename: 'notes.txt',
        },
      ];
      await session.followUp({ content: '', files });
      const queued = session.followUps.list()[0]!;
      expect(queued.files).toEqual([{ mediaType: 'text/plain', filename: 'notes.txt' }]);
      expect(JSON.stringify(session.displayState.get().queuedFollowUpItems)).not.toContain('base64,');
      files[0]!.data = 'changed by caller';
      queued.files![0]!.filename = 'changed display copy';
      expect(session.followUps.list()[0]!.files![0]!.filename).toBe('notes.txt');
      finish(0);
      await first;
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(JSON.stringify(prompts[1])).toContain('KEPT_FILE_DATA');
      expect(JSON.stringify(prompts[1])).toContain('notes.txt');
      expect(JSON.stringify(prompts[1])).not.toContain('changed');
      finish(1);
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(false));
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('lists queued follow-ups with ids, removes one by id, and drains the rest in order', async () => {
    const { agent, prompts, finish } = makeHeldRuns('follow-up-queue-items');
    const controller = new AgentController({
      id: 'follow-up-queue-items-controller',
      storage: new InMemoryStore(),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    try {
      await controller.init();
      const session = await controller.createSession({ resourceId: 'owner-queue' });
      const events: AgentControllerEvent[] = [];
      session.subscribe(event => events.push(event));

      const first = session.sendMessage({ content: 'Hold the first instruction.' });
      void first.catch(() => {});
      await vi.waitFor(() => {
        expect(prompts).toHaveLength(1);
        expect(session.displayState.get().isRunning).toBe(true);
      });

      await session.followUp({ content: 'Then check the tests.' });
      await session.followUp({ content: 'Then write the summary.' });
      const queued = session.displayState.get();
      expect(queued.queuedFollowUps).toBe(2);
      expect(queued.queuedFollowUpItems.map(item => item.content)).toEqual([
        'Then check the tests.',
        'Then write the summary.',
      ]);
      const [firstItem, secondItem] = queued.queuedFollowUpItems;
      expect(firstItem!.id).toBeTruthy();
      expect(secondItem!.id).not.toBe(firstItem!.id);

      // Remove one by id: the count and the items move together, once.
      expect(session.removeFollowUp({ id: firstItem!.id })).toBe(true);
      expect(session.removeFollowUp({ id: firstItem!.id })).toBe(false);
      const afterRemove = session.displayState.get();
      expect(afterRemove.queuedFollowUps).toBe(1);
      expect(afterRemove.queuedFollowUpItems).toEqual([secondItem]);
      const queuedEvents = events.filter(event => event.type === 'follow_up_queued');
      expect(queuedEvents.at(-1)).toMatchObject({ count: 1, items: [secondItem] });

      // The run ends: the remaining follow-up drains into the next run and leaves the list.
      finish(0);
      await first;
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(JSON.stringify(prompts[1])).toContain('Then write the summary.');
      await vi.waitFor(() => {
        const drained = session.displayState.get();
        expect(drained.queuedFollowUps).toBe(0);
        expect(drained.queuedFollowUpItems).toEqual([]);
      });

      finish(1);
      await vi.waitFor(() => {
        expect(session.displayState.get().isRunning).toBe(false);
        expect(controller.listActiveThreadRuns()).toHaveLength(0);
      });
    } finally {
      await controller.destroy();
    }
  }, 15_000);

  it('steer runs its message next and keeps the queued follow-ups, one run each', async () => {
    const { agent, prompts, finish } = makeHeldRuns('follow-up-queue-steer');
    const controller = new AgentController({
      id: 'follow-up-queue-steer-controller',
      storage: new InMemoryStore(),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    try {
      await controller.init();
      const session = await controller.createSession({ resourceId: 'owner-steer' });
      const events: AgentControllerEvent[] = [];
      session.subscribe(event => events.push(event));
      const first = session.sendMessage({ content: 'Hold the first instruction.' });
      void first.catch(() => {});
      await vi.waitFor(() => expect(session.displayState.get().isRunning).toBe(true));
      await session.followUp({
        content: 'Queued first.',
        files: [{ data: 'FIRST_FILE_DATA', mediaType: 'text/plain', filename: 'first.txt' }],
      });
      await session.followUp({ content: 'Queued second.' });

      await session.steer({
        content: 'Change course now.',
        files: [{ data: 'STEER_FILE_DATA', mediaType: 'text/plain', filename: 'steer.txt' }],
      });
      // The steered message is next; the queue keeps its order behind it.
      expect(session.followUps.list().map(item => item.content)).toEqual([
        'Change course now.',
        'Queued first.',
        'Queued second.',
      ]);

      // The aborted run ends, then each message runs on its own.
      await vi.waitFor(() => expect(prompts).toHaveLength(2));
      expect(JSON.stringify(prompts[1])).toContain('Change course now.');
      expect(JSON.stringify(prompts[1])).toContain('STEER_FILE_DATA');
      expect(JSON.stringify(prompts[1])).not.toContain('Queued first.');
      expect(session.followUps.list().map(item => item.content)).toEqual(['Queued first.', 'Queued second.']);

      finish(1);
      await vi.waitFor(() => expect(prompts).toHaveLength(3));
      expect(JSON.stringify(prompts[2])).toContain('Queued first.');
      expect(JSON.stringify(prompts[2])).toContain('FIRST_FILE_DATA');
      expect(JSON.stringify(prompts[2])).not.toContain('Queued second.');

      finish(2);
      await vi.waitFor(() => expect(prompts).toHaveLength(4));
      expect(JSON.stringify(prompts[3])).toContain('Queued second.');

      finish(3);
      await first.catch(() => {});
      await vi.waitFor(() => {
        expect(events.filter(event => event.type === 'agent_end').map(event => event.reason)).toEqual([
          'aborted',
          'complete',
          'complete',
          'complete',
        ]);
        expect(session.displayState.get().isRunning).toBe(false);
        expect(session.followUps.count()).toBe(0);
      });
    } finally {
      await controller.destroy();
    }
  }, 20_000);

  it.each(['sendMessage', 'followUp', 'steer'] as const)(
    '%s keeps messages separate while an idle run starts',
    async method => {
      const { agent, prompts, finish } = makeHeldRuns('follow-up-queue-starting');
      const controller = new AgentController({
        id: 'follow-up-queue-starting-controller',
        storage: new InMemoryStore(),
        modes: [{ id: 'default', name: 'Default', default: true, agent }],
      });
      try {
        await controller.init();
        const session = await controller.createSession({ resourceId: 'owner-starting' });
        const first = session[method]({ content: 'First instruction.' });
        void first.catch(() => {});
        // The run has not started yet: these must not be folded into its first request.
        await session.followUp({ content: 'Second instruction.' });
        await session.followUp({ content: 'Third instruction.' });
        expect(session.followUps.list().map(item => item.content)).toEqual([
          'Second instruction.',
          'Third instruction.',
        ]);

        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        expect(JSON.stringify(prompts[0])).toContain('First instruction.');
        expect(JSON.stringify(prompts[0])).not.toContain('Second instruction.');

        finish(0);
        await vi.waitFor(() => expect(prompts).toHaveLength(2));
        expect(JSON.stringify(prompts[1])).toContain('Second instruction.');
        expect(JSON.stringify(prompts[1])).not.toContain('Third instruction.');

        finish(1);
        await vi.waitFor(() => expect(prompts).toHaveLength(3));
        expect(JSON.stringify(prompts[2])).toContain('Third instruction.');

        finish(2);
        await first;
        await vi.waitFor(() => {
          expect(session.displayState.get().isRunning).toBe(false);
          expect(session.followUps.count()).toBe(0);
        });
      } finally {
        await controller.destroy();
      }
    },
    20_000,
  );

  it.each(['sendMessage', 'followUp', 'steer'] as const)(
    '%s releases a refused idle send so queued files can run',
    async method => {
      const { agent, prompts, finish } = makeHeldRuns('follow-up-queue-refused');
      const controller = new AgentController({
        id: 'follow-up-queue-refused-controller',
        storage: new InMemoryStore(),
        modes: [{ id: 'default', name: 'Default', default: true, agent }],
      });
      try {
        await controller.init();
        const session = await controller.createSession({ resourceId: 'owner-refused' });
        vi.spyOn(agent, 'sendSignal').mockImplementationOnce(
          () =>
            ({
              signal: { id: 'refused', type: 'user-message', contents: 'Refused instruction.' },
              accepted: Promise.reject(new Error('refused before start')),
            }) as any,
        );
        const first = session[method]({ content: 'Refused instruction.' });
        await session.followUp({
          content: 'Queued behind the refused send.',
          files: [{ data: 'KEPT_AFTER_REFUSAL', mediaType: 'text/plain', filename: 'kept.txt' }],
        });
        expect(session.followUps.count()).toBe(1);
        await expect(first).rejects.toThrow('refused before start');

        // Nothing started, so no run end will send the queue: it moves on at once.
        await vi.waitFor(() => expect(prompts).toHaveLength(1));
        expect(JSON.stringify(prompts[0])).toContain('Queued behind the refused send.');
        expect(JSON.stringify(prompts[0])).toContain('KEPT_AFTER_REFUSAL');
        finish(0);
        await vi.waitFor(() => {
          expect(session.displayState.get().isRunning).toBe(false);
          expect(session.followUps.count()).toBe(0);
        });
      } finally {
        await controller.destroy();
      }
    },
    20_000,
  );
});

describe('Session follow-ups behind a parked run', () => {
  async function createIdleSession(id: string) {
    const { agent } = makeHeldRuns(id);
    const controller = new AgentController({
      id: `${id}-controller`,
      storage: new InMemoryStore(),
      modes: [{ id: 'default', name: 'Default', default: true, agent }],
    });
    await controller.init();
    const session = await controller.createSession({ resourceId: `owner-${id}` });
    // The drain sends through the runtime queue when the thread stream is open
    // and through sendMessage otherwise; record either without starting runs.
    const queueMessage = vi
      .spyOn(agent, 'queueMessage')
      .mockImplementation(
        () => ({ signal: {}, accepted: Promise.resolve({ action: 'deliver', runId: 'queued-run' }) }) as any,
      );
    const sendMessage = vi.spyOn(session, 'sendMessage').mockResolvedValue(undefined);
    const dispatched = () => [
      ...sendMessage.mock.calls.map(([input]) => ({ text: input.content, interjection: false })),
      ...queueMessage.mock.calls.map(([input]) =>
        typeof input === 'string'
          ? { text: input, interjection: false }
          : {
              text: String((input as { contents: unknown }).contents),
              interjection: (input as { attributes?: { delivery?: string } }).attributes?.delivery === 'while-active',
            },
      ),
    ];
    return { controller, session, dispatched };
  }

  const park = (session: Awaited<ReturnType<typeof createIdleSession>>['session']) =>
    session.emit({
      type: 'tool_suspended',
      toolCallId: 'call-generate',
      toolName: 'generate_image',
      args: {},
      suspendPayload: { prompt: 'a cat' },
    });

  it('holds follow-ups while a tool suspension keeps the run parked and sends them one at a time once it ends', async () => {
    const { controller, session, dispatched } = await createIdleSession('follow-up-parked-suspension');
    try {
      const events: AgentControllerEvent[] = [];
      session.subscribe(event => events.push(event));
      park(session);
      expect(session.run.isRunning()).toBe(false);

      await session.followUp({ content: 'Then make it blue.' });
      await session.followUp({ content: 'Then add a hat.' });

      expect(dispatched()).toEqual([]);
      expect(session.followUps.list().map(item => item.content)).toEqual(['Then make it blue.', 'Then add a hat.']);
      expect(events.filter(event => event.type === 'follow_up_queued')).toHaveLength(2);

      // The parked run is not over: nothing drains into it.
      await expect(session.drainFollowUpQueue()).resolves.toBe(false);
      expect(session.followUps.count()).toBe(2);

      // Once the suspension clears, the queue sends one message.
      session.emit({ type: 'tool_suspension_cancelled', toolCallId: 'call-generate', toolName: 'generate_image' });
      await expect(session.drainFollowUpQueue()).resolves.toBe(true);
      expect(dispatched().map(item => item.text)).toEqual(['Then make it blue.']);
      expect(session.followUps.list().map(item => item.content)).toEqual(['Then add a hat.']);
    } finally {
      await controller.destroy();
    }
  });

  // With a live subscription the run engine's teardown drains the queue after Stop
  // (covered with a real ask_user suspension in agent-controller-ask-user.test.ts).
  // Without one there is no teardown to wait for, so Stop moves the queue on at once.
  it('moves the queue on at once when Stop abandons a parked run with no live stream', async () => {
    const { controller, session, dispatched } = await createIdleSession('follow-up-parked-stop');
    try {
      session.stream.detach();
      park(session);
      await session.followUp({ content: 'After the stop.' });
      expect(session.followUps.count()).toBe(1);

      session.abort();

      await vi.waitFor(() => expect(dispatched().map(item => item.text)).toEqual(['After the stop.']));
      expect(session.followUps.count()).toBe(0);
    } finally {
      await controller.destroy();
    }
  });

  it('steer on a parked run sends the steered message first, as an interjection, and keeps the queue', async () => {
    const { controller, session, dispatched } = await createIdleSession('follow-up-parked-steer');
    try {
      session.stream.detach();
      park(session);
      await session.followUp({ content: 'Queued while generating.' });

      await session.steer({ content: 'Stop that and do this.' });

      await vi.waitFor(() => expect(dispatched()).toHaveLength(1));
      expect(dispatched()[0]!.text).toBe('Stop that and do this.');
      expect(session.followUps.list().map(item => item.content)).toEqual(['Queued while generating.']);
    } finally {
      await controller.destroy();
    }
  });
});
