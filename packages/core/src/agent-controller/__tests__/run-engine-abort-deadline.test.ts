import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import { RequestContext } from '../../request-context';
import { InMemoryStore } from '../../storage/mock';
import { Workspace } from '../../workspace';
import { LocalFilesystem } from '../../workspace/filesystem/local-filesystem';
import type { SessionMachinery } from '../session';
import { Session, SessionStream } from '../session';
import { SessionRunEngine } from '../session-run-engine';
import type { AgentControllerEvent } from '../types';

type StreamChunk = Parameters<SessionRunEngine['processStreamChunk']>[1];

function createHarness() {
  const events: AgentControllerEvent[] = [];
  let idCounter = 0;

  const session = new Session({
    resourceId: 'resource-1',
    id: 'session-1',
    ownerId: 'owner-1',
    workspace: new Workspace({
      id: 'workspace-1',
      filesystem: new LocalFilesystem({ basePath: '/tmp' }),
    }),
  });
  session.thread.set({ threadId: 'thread-1' });
  session.subscribe(event => {
    events.push(event);
  });

  const agent = new Agent({
    id: 'abort-deadline-agent',
    name: 'Abort deadline agent',
    instructions: 'No model request is expected in these stream tests.',
    model: new MockLanguageModelV2({
      doStream: async () => {
        throw new Error('These tests must not start a model request');
      },
    }),
  });
  const machinery: SessionMachinery = {
    getAgent: () => agent,
    getRunScope: () => undefined,
    subscribeToThread: async () => {
      throw new Error('subscribeToThread is not used by these tests');
    },
    buildStreamOptions: async () => ({}),
    buildSharedRunOptions: () => ({}),
    buildToolsets: async () => ({}),
    buildRequestContext: async requestContext => requestContext ?? new RequestContext(),
    persistTokenUsage: vi.fn(async () => {}),
    generateId: () => `msg-${++idCounter}`,
    resolveTransitionModeId: () => undefined,
    saveSystemReminder: vi.fn(async () => null),
  };

  session.setMachinery(machinery);
  const engine = new SessionRunEngine(session, machinery);
  return { agent, engine, events, machinery, session };
}

function chunk(value: StreamChunk): StreamChunk {
  return value;
}

describe('SessionRunEngine — abort deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    'iterator',
    'decline-resolve',
    'decline-reject',
    ...(['tool-result', 'tool-error'] as const).flatMap(type =>
      ['storage', 'message'].flatMap(stage => ['resolve', 'reject'].map(ending => `${type}-${stage}-${ending}`)),
    ),
  ] as const)('opens a fresh stream after steering times out and ignores late %s work', async lateWork => {
    vi.useFakeTimers();
    const { agent, engine, events, machinery, session } = createHarness();
    session.thread.connect(undefined, session);
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>(resolve => {
      releaseOld = resolve;
    });
    const decline = vi.spyOn(session, 'declineToolCall').mockImplementation(async () => {
      await oldBlocked;
      if (lateWork === 'decline-reject') throw new Error('late decline failure');
    });
    const storage = await new InMemoryStore().getStore('memory');
    const oldMessage = {
      id: 'old-source',
      role: 'assistant' as const,
      type: 'text' as const,
      createdAt: new Date(),
      threadId: 'thread-1',
      resourceId: 'resource-1',
      content: { format: 2 as const, parts: [] },
    };
    const waitForStorage = async () => {
      await oldBlocked;
      if (lateWork.endsWith('reject')) throw new Error('late storage failure');
    };
    machinery.getMessageStorage = async () => {
      if (lateWork.includes('-storage-')) await waitForStorage();
      return storage;
    };
    vi.spyOn(storage!, 'listMessagesById').mockImplementation(async () => {
      if (lateWork.includes('-message-')) await waitForStorage();
      return { messages: [oldMessage] };
    });
    const oldSubscription = {
      stream: (async function* () {
        yield chunk({ type: 'text-start', runId: 'old-run', payload: { id: 'old-text' } });
        if (lateWork.startsWith('decline-')) {
          yield chunk({
            type: 'tool-call-approval',
            runId: 'old-run',
            payload: {
              toolCallId: 'old-tool',
              toolName: 'write_file',
              args: {},
              toolApprovalPolicy: 'manual',
            },
          });
        }
        if (lateWork.startsWith('tool-')) {
          yield chunk({
            type: lateWork.startsWith('tool-result-') ? 'tool-result' : 'tool-error',
            runId: 'old-run',
            payload: {
              toolCallId: 'old-tool',
              toolName: 'read_file',
              messageId: 'old-source',
              result: 'stale output',
              error: new Error('stale output'),
            },
          } as StreamChunk);
        }
        await oldBlocked;
        yield chunk({ type: 'text-delta', runId: 'old-run', payload: { id: 'old-text', text: 'stale output' } });
      })(),
      activeRunId: () => 'old-run',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    let finishNext!: () => void;
    const nextBlocked = new Promise<void>(resolve => {
      finishNext = resolve;
    });
    const nextSubscription = {
      stream: (async function* () {
        yield chunk({ type: 'text-start', runId: 'next-run', payload: { id: 'next-text' } });
        yield chunk({
          type: 'text-delta',
          runId: 'next-run',
          payload: { id: 'next-text', text: 'steered response' },
        });
        await nextBlocked;
        yield chunk({ type: 'finish', runId: 'next-run', payload: { stepResult: { reason: 'stop' } } });
      })(),
      activeRunId: () => 'next-run',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    const subscribe = vi.fn(async () => nextSubscription);
    machinery.subscribeToThread = subscribe;
    const dispatch = vi.spyOn(agent, 'queueMessage').mockReturnValue({
      accepted: Promise.resolve({ action: 'deliver', runId: 'next-run' }),
      signal: { type: 'user', contents: 'Change course.' },
    } as ReturnType<Agent['queueMessage']>);
    session.stream.attach({
      subscription: oldSubscription,
      agent,
      key: SessionStream.keyFor({ agent, resourceId: 'resource-1', threadId: 'thread-1' }),
    });
    const processed = engine.processSubscribedThreadStream(oldSubscription);
    await vi.advanceTimersByTimeAsync(0);
    await session.steer({ content: 'Change course.' });
    await vi.advanceTimersByTimeAsync(5_000);
    await processed;

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(session.stream.isCurrent({ subscription: nextSubscription })).toBe(true);
    expect(nextSubscription.unsubscribe).not.toHaveBeenCalled();
    expect(session.followUps.count()).toBe(0);
    expect(events.filter(event => event.type === 'agent_start')).toHaveLength(2);
    const completedBeforeRelease = events.filter(event => event.type === 'tool_end').length;
    releaseOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.stream.isCurrent({ subscription: nextSubscription })).toBe(true);
    expect(JSON.stringify(events)).not.toContain('stale output');
    expect(events.filter(event => event.type === 'error')).toHaveLength(0);
    expect(events.filter(event => event.type === 'tool_end')).toHaveLength(completedBeforeRelease);
    expect(decline).toHaveBeenCalledTimes(lateWork.startsWith('decline-') ? 1 : 0);
    expect(session.run.isAbortRequested()).toBe(false);
    expect(events.filter(event => event.type === 'agent_end')).toEqual([{ type: 'agent_end', reason: 'aborted' }]);
    finishNext();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(event => event.type === 'agent_end')).toEqual([
      { type: 'agent_end', reason: 'aborted' },
      { type: 'agent_end', reason: 'complete' },
    ]);
    session.stream.detach();
    dispatch.mockRestore();
    decline.mockRestore();
  });

  it.each(['finish', 'iterator-error', 'chunk-error'] as const)(
    'finalizes once when %s end hooks outlast the abort deadline',
    async ending => {
      vi.useFakeTimers();
      const { engine, events, session } = createHarness();
      let releaseEnd!: () => void;
      const heldEnd = new Promise<void>(resolve => {
        releaseEnd = resolve;
      });
      const beforeEnd = vi.fn(async () => {
        await heldEnd;
      });
      session.onBeforeAgentEnd(beforeEnd);
      const drain = vi.spyOn(session, 'drainFollowUpQueue').mockResolvedValue(false);
      const subscription = {
        stream: (async function* () {
          yield chunk({ type: 'text-start', payload: { id: 't1' } });
          if (ending === 'iterator-error') throw new Error('iterator failure');
          yield chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } });
        })(),
        activeRunId: () => 'run-1',
        abort: () => true,
        unsubscribe: vi.fn(),
      };
      const processChunk = vi.spyOn(engine, 'processStreamChunk');
      if (ending === 'chunk-error') {
        processChunk.mockImplementation(async (_state, nextChunk) => {
          if (nextChunk.type === 'finish') throw new Error('chunk failure');
        });
      }
      session.stream.attach({ subscription, key: 'thread-1' });
      const processed = engine.processSubscribedThreadStream(subscription);
      await vi.advanceTimersByTimeAsync(0);
      expect(beforeEnd).toHaveBeenCalledTimes(1);
      session.abortRun();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(beforeEnd).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.type === 'agent_end')).toHaveLength(0);
      expect(drain).not.toHaveBeenCalled();
      releaseEnd();
      await processed;
      await vi.advanceTimersByTimeAsync(0);
      expect(beforeEnd).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.type === 'agent_end')).toHaveLength(1);
      expect(drain).toHaveBeenCalledTimes(1);
      expect(session.run.isRunning()).toBe(false);
      processChunk.mockRestore();
      drain.mockRestore();
      session.stream.detach();
    },
  );

  it('does not finalize or drain into another thread after a pending end hook', async () => {
    vi.useFakeTimers();
    const { engine, events, session } = createHarness();
    let releaseEnd!: () => void;
    session.onBeforeAgentEnd(
      () =>
        new Promise<void>(resolve => {
          releaseEnd = resolve;
        }),
    );
    const drain = vi.spyOn(session, 'drainFollowUpQueue').mockResolvedValue(false);
    const subscription = {
      stream: (async function* () {
        yield chunk({ type: 'text-start', payload: { id: 't1' } });
        yield chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } });
      })(),
      activeRunId: () => 'run-1',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });
    const processed = engine.processSubscribedThreadStream(subscription);
    await vi.advanceTimersByTimeAsync(0);
    session.thread.set({ threadId: 'thread-2' });
    releaseEnd();
    await processed;
    expect(events.filter(event => event.type === 'agent_end')).toHaveLength(0);
    expect(drain).not.toHaveBeenCalled();
    drain.mockRestore();
    session.stream.detach();
  });

  it('Given a stream hung mid-run, When the run is aborted, Then it still finalizes as aborted after the grace period', async () => {
    vi.useFakeTimers();
    const { engine, events, session } = createHarness();
    session.run.ensureAbortController();

    const processed = engine.processStream({
      fullStream: (async function* () {
        yield chunk({ type: 'text-start', payload: { id: 't1' } });
        yield chunk({ type: 'text-delta', payload: { id: 't1', text: 'partial' } });
        await new Promise(() => {});
      })(),
    });
    await vi.advanceTimersByTimeAsync(0);

    session.abortRun();
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await processed;
    expect(events).toContainEqual({ type: 'agent_end', reason: 'aborted' });
    expect(session.run.isRunning()).toBe(false);
    expect(result?.message.content.parts).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('Given a run that ends on a terminal chunk, Then the source stream is still cleaned up', async () => {
    const { engine } = createHarness();
    let cleanedUp = false;

    await engine.processStream({
      fullStream: (async function* () {
        try {
          yield chunk({ type: 'text-start', payload: { id: 't1' } });
          yield chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } });
          yield chunk({ type: 'text-start', payload: { id: 't2' } });
        } finally {
          cleanedUp = true;
        }
      })(),
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(cleanedUp).toBe(true);
  });

  it('Given a subscribed thread stream hung mid-run, When the run is aborted, Then it finalizes as aborted and detaches the subscription', async () => {
    vi.useFakeTimers();
    const { engine, events, session } = createHarness();

    const subscription = {
      stream: (async function* () {
        yield chunk({ type: 'text-start', payload: { id: 't1' } });
        yield chunk({ type: 'text-delta', payload: { id: 't1', text: 'partial' } });
        await new Promise(() => {});
      })(),
      activeRunId: () => 'run-1',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });

    const processed = engine.processSubscribedThreadStream(subscription);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({ type: 'agent_start' });

    session.abortRun();
    await vi.advanceTimersByTimeAsync(5_000);

    await processed;
    expect(events).toContainEqual({ type: 'agent_end', reason: 'aborted' });
    expect(session.run.isRunning()).toBe(false);
    expect(session.stream.isOpen()).toBe(false);
  });

  it('Given an aborted subscribed run that finishes within the grace period, Then the stale deadline does not kill a follow-up run', async () => {
    vi.useFakeTimers();
    const { engine, events, session } = createHarness();

    const queue: StreamChunk[] = [];
    let notify: (() => void) | undefined;
    const push = (value: StreamChunk) => {
      queue.push(value);
      notify?.();
      notify = undefined;
    };
    const subscription = {
      stream: (async function* () {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      })(),
      activeRunId: () => 'run-1',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });
    void engine.processSubscribedThreadStream(subscription);

    push(chunk({ type: 'text-start', payload: { id: 't1' } }));
    push(chunk({ type: 'text-delta', payload: { id: 't1', text: 'first run' } }));
    await vi.advanceTimersByTimeAsync(0);

    session.abortRun();
    await vi.advanceTimersByTimeAsync(1_000);
    push(chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({ type: 'agent_end', reason: 'aborted' });

    push(chunk({ type: 'text-start', payload: { id: 't2' } }));
    push(chunk({ type: 'text-delta', payload: { id: 't2', text: 'follow-up' } }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(session.run.isRunning()).toBe(true);
    expect(session.stream.isOpen()).toBe(true);
    expect(events.filter(event => event.type === 'agent_start')).toHaveLength(2);
    expect(events.filter(event => event.type === 'agent_end')).toEqual([{ type: 'agent_end', reason: 'aborted' }]);
  });

  it('Given an abort of a later run on the same subscription, When that run hangs, Then the re-armed deadline still bails it', async () => {
    vi.useFakeTimers();
    const { engine, events, session } = createHarness();

    const queue: StreamChunk[] = [];
    let notify: (() => void) | undefined;
    const push = (value: StreamChunk) => {
      queue.push(value);
      notify?.();
      notify = undefined;
    };
    const subscription = {
      stream: (async function* () {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      })(),
      activeRunId: () => 'run-1',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });
    const processed = engine.processSubscribedThreadStream(subscription);

    push(chunk({ type: 'text-start', payload: { id: 't1' } }));
    push(chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({ type: 'agent_end', reason: 'complete' });

    push(chunk({ type: 'text-start', payload: { id: 't2' } }));
    await vi.advanceTimersByTimeAsync(0);

    session.abortRun();
    await vi.advanceTimersByTimeAsync(5_000);

    await processed;
    expect(events).toContainEqual({ type: 'agent_end', reason: 'aborted' });
    expect(session.run.isRunning()).toBe(false);
    expect(session.stream.isOpen()).toBe(false);
  });

  it('Given teardown happens before the deadline observes it, Then a later abort still receives the full grace period', async () => {
    vi.useFakeTimers();
    const { engine, events, session } = createHarness();

    const queue: StreamChunk[] = [];
    let notify: (() => void) | undefined;
    const push = (value: StreamChunk) => {
      queue.push(value);
      notify?.();
      notify = undefined;
    };
    const subscription = {
      stream: (async function* () {
        while (true) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      })(),
      activeRunId: () => 'run-1',
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });
    const processed = engine.processSubscribedThreadStream(subscription);

    // First run: abort, then finish immediately so teardown resolves the
    // deadline race before its grace timer ever fires.
    push(chunk({ type: 'text-start', payload: { id: 't1' } }));
    await vi.advanceTimersByTimeAsync(0);
    session.abortRun();
    push(chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContainEqual({ type: 'agent_end', reason: 'aborted' });

    // Second run on the same subscription hangs after its abort.
    push(chunk({ type: 'text-start', payload: { id: 't2' } }));
    await vi.advanceTimersByTimeAsync(0);
    session.abortRun();

    // The later abort gets a full, fresh grace period — no early bail from a
    // stale timer armed by the first abort...
    await vi.advanceTimersByTimeAsync(4_999);
    expect(session.stream.isOpen()).toBe(true);

    // ...and the re-armed deadline still bails the hung run once it elapses.
    await vi.advanceTimersByTimeAsync(1);
    await processed;
    expect(events.filter(event => event.type === 'agent_end')).toEqual([
      { type: 'agent_end', reason: 'aborted' },
      { type: 'agent_end', reason: 'aborted' },
    ]);
    expect(session.run.isRunning()).toBe(false);
    expect(session.stream.isOpen()).toBe(false);
  });

  it('Given a subscribed run whose producer loses liveness, Then it finalizes as an error and the subscription can process a follow-up run', async () => {
    const { engine, events, session } = createHarness();

    const subscription = {
      stream: (async function* () {
        yield chunk({ type: 'text-start', payload: { id: 't1' }, runId: 'run-1' });
        yield chunk({ type: 'text-delta', payload: { id: 't1', text: 'partial' }, runId: 'run-1' });
        yield chunk({
          type: 'error',
          payload: { error: new Error('Thread run run-1 lost its lease before publishing a terminal event') },
          runId: 'run-1',
        });
        yield chunk({ type: 'text-start', payload: { id: 't2' }, runId: 'run-2' });
        yield chunk({ type: 'text-delta', payload: { id: 't2', text: 'recovered' }, runId: 'run-2' });
        yield chunk({ type: 'finish', payload: { stepResult: { reason: 'stop' } }, runId: 'run-2' });
      })(),
      activeRunId: () => null,
      abort: () => true,
      unsubscribe: vi.fn(),
    };
    session.stream.attach({ subscription, key: 'thread-1' });

    await engine.processSubscribedThreadStream(subscription);

    expect(events.filter(event => event.type === 'error')).toEqual([
      {
        type: 'error',
        error: new Error('Thread run run-1 lost its lease before publishing a terminal event'),
      },
    ]);
    expect(events.filter(event => event.type === 'agent_end')).toEqual([
      { type: 'agent_end', reason: 'error' },
      { type: 'agent_end', reason: 'complete' },
    ]);
    expect(events.filter(event => event.type === 'agent_start')).toHaveLength(2);
    expect(session.run.isRunning()).toBe(false);
  });

  it('Given a stream that reacts to the abort signal in time, Then the deadline never fires', async () => {
    const { engine, events, session } = createHarness();
    const abortController = session.run.ensureAbortController();

    const result = await engine.processStream({
      fullStream: (async function* () {
        yield chunk({ type: 'text-start', payload: { id: 't1' } });
        abortController.abort();
        session.run.requestAbort();
        yield chunk({ type: 'abort', payload: {} });
      })(),
    });

    expect(events).toContainEqual({ type: 'agent_end', reason: 'aborted' });
    expect(result?.message).toBeDefined();
  });
});
