import { describe, expect, it, vi } from 'vitest';

import { RequestContext } from '../../request-context';
import { Workspace } from '../../workspace';
import { LocalFilesystem } from '../../workspace/filesystem/local-filesystem';
import type { SessionMachinery } from '../session';
import { Session } from '../session';
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

  const machinery: SessionMachinery = {
    getAgent: () => ({ id: 'agent-stub' }) as unknown as ReturnType<SessionMachinery['getAgent']>,
    getRunScope: () => undefined,
    subscribeToThread: async () => {
      throw new Error('subscribeToThread is not used by these stream-folding tests');
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

  return { engine: new SessionRunEngine(session, machinery), events, session };
}

function chunk(value: StreamChunk): StreamChunk {
  return value;
}

function assistantStarts(events: AgentControllerEvent[]) {
  return events.filter(
    (event): event is Extract<AgentControllerEvent, { type: 'message_start' }> =>
      event.type === 'message_start' && event.message.role === 'assistant',
  );
}

// 1.74 port: createStreamState takes (threadId, runId); these cases bind only the run.
describe('SessionRunEngine answer text events', () => {
  const requestContext = () => new RequestContext();

  it('emits immutable run-bound text deltas before completion, excluding reasoning and tools', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState(undefined, 'run-1');
    const ctx = requestContext();
    await engine.processStreamChunk(
      state,
      chunk({ type: 'step-start', runId: 'run-1', payload: { messageId: 'answer-1' } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'reasoning-start', runId: 'run-1', payload: { id: 'r1' } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'reasoning-delta', runId: 'run-1', payload: { id: 'r1', text: 'private thought' } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-call',
        runId: 'run-1',
        payload: { toolCallId: 'tc1', toolName: 'read', args: { text: 'tool input' } },
      }),
      ctx,
    );
    await engine.processStreamChunk(state, chunk({ type: 'text-start', runId: 'run-1', payload: { id: 't1' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', runId: 'run-1', payload: { id: 't1', text: 'Hello' } }),
      ctx,
    );
    const first = events.find(event => event.type === 'text_delta');
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', runId: 'run-1', payload: { id: 't1', text: ' world' } }),
      ctx,
    );
    expect(first).toEqual({ type: 'text_delta', runId: 'run-1', messageId: 'answer-1', textDelta: 'Hello' });
    expect(events.filter(event => event.type === 'text_delta')).toEqual([
      first,
      { type: 'text_delta', runId: 'run-1', messageId: 'answer-1', textDelta: ' world' },
    ]);
    expect(events.some(event => event.type === 'agent_end')).toBe(false);
  });

  it.each([null, 'run-1'])('does not emit text with unknown or mismatched stream identity %s', async runId => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState(undefined, runId);
    const ctx = requestContext();
    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), ctx);
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'text-delta',
        ...(runId ? { runId: 'other-run' } : {}),
        payload: { id: 't1', text: 'Do not forward' },
      }),
      ctx,
    );
    expect(events.filter(event => event.type === 'text_delta')).toEqual([]);
  });
});

describe('SessionRunEngine compact message lifecycle', () => {
  it('keeps delayed tool events and rotated messages on their originating thread', async () => {
    const { engine, events, session } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();
    session.thread.set({ threadId: 'thread-2' });

    const toolCallId = 'late-call';
    const toolName = 'view';
    const chunks: StreamChunk[] = [
      { type: 'tool-call-input-streaming-start', payload: { toolCallId, toolName } },
      { type: 'tool-call-delta', payload: { toolCallId, argsTextDelta: '{}' } },
      { type: 'tool-call-input-streaming-end', payload: { toolCallId } },
      { type: 'tool-call', payload: { toolCallId, toolName, args: {} } },
      { type: 'data-mastracode-tool-progress', data: { toolCallId, progress: 'late progress' } },
      { type: 'tool-result', payload: { toolCallId, toolName, result: 'late result' } },
      { type: 'data-user-message', data: { id: 'user-next' } },
      { type: 'text-start', payload: { id: 'text-next' } },
      { type: 'text-delta', payload: { id: 'text-next', text: 'still the original thread' } },
    ];
    for (const item of chunks) await engine.processStreamChunk(state, item, context);

    const toolEvents = events.filter(event => 'toolCallId' in event);
    expect(toolEvents.map(event => event.type)).toEqual([
      'tool_input_start',
      'tool_input_delta',
      'tool_input_end',
      'tool_start',
      'tool_update',
      'shell_output',
      'tool_end',
    ]);
    for (const event of toolEvents) expect(event).toMatchObject({ threadId: 'thread-1' });
    const starts = assistantStarts(events);
    expect(starts).toHaveLength(2);
    for (const event of starts) expect(event.message.threadId).toBe('thread-1');
  });

  it('stamps the assistant message id on tool-input events so consumers can attribute arguments to a step', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    // Tool-call chunks arrive before this step's message_start, so the stamped id is the
    // only thing that tells one step's streamed arguments from the next step's.
    const toolCallId = 'call-1';
    const toolName = 'view';
    const chunks: StreamChunk[] = [
      chunk({ type: 'tool-call-input-streaming-start', payload: { toolCallId, toolName } }),
      chunk({ type: 'tool-call-delta', payload: { toolCallId, argsTextDelta: '{"path"' } }),
      chunk({ type: 'tool-call-delta', payload: { toolCallId, argsTextDelta: ':"a.ts"}' } }),
      chunk({ type: 'tool-call-input-streaming-end', payload: { toolCallId } }),
      chunk({ type: 'tool-call', payload: { toolCallId, toolName, args: { path: 'a.ts' } } }),
    ];
    for (const item of chunks) await engine.processStreamChunk(state, item, context);

    const toolInputs = events.filter(
      event =>
        event.type === 'tool_input_start' || event.type === 'tool_input_delta' || event.type === 'tool_input_end',
    );
    expect(toolInputs.map(event => event.type)).toEqual([
      'tool_input_start',
      'tool_input_delta',
      'tool_input_delta',
      'tool_input_end',
    ]);
    for (const event of toolInputs) expect(event).toMatchObject({ messageId: 'msg-1' });
    // The message the tool call belongs to opens only once the call itself arrives, so the
    // stamped ids must agree with the assistant message that starts after the arguments.
    expect(assistantStarts(events).map(event => event.message.id)).toEqual(['msg-1']);
  });

  it('emits one start, ordered text deltas, and one end when assistant text completes', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), context);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't1', text: 'Hello' } }),
      context,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't1', text: ' world' } }),
      context,
    );
    await engine.processStreamChunk(state, chunk({ type: 'text-end', payload: { id: 't1' } }), context);

    const [started] = assistantStarts(events);
    expect(started).toMatchObject({
      type: 'message_start',
      message: { id: 'msg-1', content: { format: 2, parts: [{ type: 'text', text: '' }] } },
    });
    expect(events.filter(event => event.type === 'message_update')).toEqual([
      { type: 'message_update', id: 'msg-1', event: { type: 'text-delta', delta: 'Hello' } },
      { type: 'message_update', id: 'msg-1', event: { type: 'text-delta', delta: ' world' } },
    ]);
    expect(events.some(event => event.type === 'message_end')).toBe(false);

    await engine.processStreamChunk(state, chunk({ type: 'data-user-message', data: { id: 'user-1' } }), context);

    expect(events.filter(event => event.type === 'message_end')).toEqual([
      { type: 'message_end', id: 'msg-1' },
      { type: 'message_end', id: 'user-1' },
    ]);
  });

  it('emits one lifecycle for multiple text parts in one assistant message', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), context);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't1', text: 'first' } }),
      context,
    );
    await engine.processStreamChunk(state, chunk({ type: 'text-end', payload: { id: 't1' } }), context);
    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't2' } }), context);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't2', text: ' second' } }),
      context,
    );
    await engine.processStreamChunk(state, chunk({ type: 'data-user-message', data: { id: 'user-1' } }), context);

    expect(assistantStarts(events)).toHaveLength(1);
    expect(events.filter(event => event.type === 'message_update')).toEqual([
      { type: 'message_update', id: 'msg-1', event: { type: 'text-delta', delta: 'first' } },
      { type: 'message_update', id: 'msg-1', event: { type: 'part', index: 1, part: { type: 'text', text: '' } } },
      { type: 'message_update', id: 'msg-1', event: { type: 'text-delta', delta: ' second' } },
    ]);
    expect(events.filter(event => event.type === 'message_end')).toContainEqual({ type: 'message_end', id: 'msg-1' });
  });

  it('sends compact part snapshots and reasoning deltas after the initial message start', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 'text-1' } }), context);
    await engine.processStreamChunk(state, chunk({ type: 'reasoning-start', payload: { id: 'reasoning-1' } }), context);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'reasoning-delta', payload: { id: 'reasoning-1', text: 'Checking the files.' } }),
      context,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-call', payload: { toolCallId: 'tool-1', toolName: 'view', args: { path: 'a.ts' } } }),
      context,
    );

    expect(events.filter(event => event.type === 'message_update')).toEqual([
      {
        type: 'message_update',
        id: 'msg-1',
        event: {
          type: 'part',
          index: 1,
          part: expect.objectContaining({
            type: 'reasoning',
            reasoning: '',
            details: [{ type: 'text', text: '' }],
          }),
        },
      },
      {
        type: 'message_update',
        id: 'msg-1',
        event: { type: 'reasoning-delta', index: 1, delta: 'Checking the files.' },
      },
      {
        type: 'message_update',
        id: 'msg-1',
        event: {
          type: 'part',
          index: 2,
          part: {
            type: 'tool-invocation',
            toolInvocation: { state: 'call', toolCallId: 'tool-1', toolName: 'view', args: { path: 'a.ts' } },
          },
        },
      },
    ]);
  });

  it('ends the active assistant before rotating to a new response id', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    await engine.processStreamChunk(
      state,
      chunk({ type: 'step-start', payload: { messageId: 'response-1' } }),
      context,
    );
    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't1' } }), context);
    await engine.processStreamChunk(
      state,
      chunk({ type: 'text-delta', payload: { id: 't1', text: 'first' } }),
      context,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'step-start', payload: { messageId: 'response-2' } }),
      context,
    );
    await engine.processStreamChunk(state, chunk({ type: 'text-start', payload: { id: 't2' } }), context);

    expect(events.filter(event => event.type === 'message_start').map(event => event.message.id)).toEqual([
      'response-1',
      'response-2',
    ]);
    expect(events.filter(event => event.type === 'message_end')).toEqual([{ type: 'message_end', id: 'response-1' }]);
  });

  it('emits immediate compact start/end pairs for signal messages', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();
    const payload = { id: 'signal-1', message: 'hello', createdAt: '2026-01-02T03:04:05.000Z' };

    await engine.processStreamChunk(state, chunk({ type: 'data-signal', data: payload }), context);

    expect(events.filter(event => event.type === 'message_start' || event.type === 'message_end')).toEqual([
      {
        type: 'message_start',
        message: expect.objectContaining({
          id: 'signal-1',
          role: 'signal',
          content: { format: 2, parts: [{ type: 'data-signal', data: payload }], metadata: { signal: payload } },
        }),
      },
      { type: 'message_end', id: 'signal-1' },
    ]);
  });

  it('carries the tool title on tool_input_start, tool_start and the message part', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-call-input-streaming-start',
        payload: { toolCallId: 'tool-1', toolName: 'search', title: 'Search the web' },
      }),
      context,
    );
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-call',
        payload: { toolCallId: 'tool-1', toolName: 'search', args: { q: 'mastra' }, title: 'Search the web' },
      }),
      context,
    );

    expect(events).toContainEqual({
      type: 'tool_input_start',
      threadId: 'thread-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      title: 'Search the web',
      messageId: 'msg-1',
    });
    expect(events).toContainEqual({
      type: 'tool_start',
      threadId: 'thread-1',
      toolCallId: 'tool-1',
      toolName: 'search',
      args: { q: 'mastra' },
      title: 'Search the web',
    });
    expect(assistantStarts(events)).toHaveLength(1);
    expect(assistantStarts(events)[0]?.message.content.parts).toEqual([
      {
        type: 'tool-invocation',
        title: 'Search the web',
        toolInvocation: { state: 'call', toolCallId: 'tool-1', toolName: 'search', args: { q: 'mastra' } },
      },
    ]);
  });

  it('streams tool-only assistant message part updates', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState();
    const context = new RequestContext();

    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-call', payload: { toolCallId: 'tool-1', toolName: 'read', args: { path: 'a.ts' } } }),
      context,
    );
    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-result', payload: { toolCallId: 'tool-1', toolName: 'read', result: 'ok' } }),
      context,
    );
    await engine.processStreamChunk(state, chunk({ type: 'data-user-message', data: { id: 'user-1' } }), context);

    expect(assistantStarts(events)).toHaveLength(1);
    expect(events.filter(event => event.type === 'message_update')).toEqual([
      {
        type: 'message_update',
        id: 'msg-1',
        event: {
          type: 'part',
          index: 0,
          part: {
            type: 'tool-invocation',
            toolInvocation: {
              state: 'result',
              toolCallId: 'tool-1',
              toolName: 'read',
              args: { path: 'a.ts' },
              result: 'ok',
              isError: false,
            },
          },
        },
      },
    ]);
    expect(events.filter(event => event.type === 'message_end')).toContainEqual({ type: 'message_end', id: 'msg-1' });
  });
});

// 1.74 port: createStreamState takes (threadId, runId), and a dispatched background
// task reports its placeholder with native `backgroundTask.status: 'running'` metadata.
const requestContext = () => new RequestContext();

describe('truthful native tool lifecycle', () => {
  it('preparation stays distinct from execution and the terminal outcome keeps run identity', async () => {
    const { engine, session, events } = createHarness();
    const state = engine.createStreamState(undefined, 'run-exact');
    const ctx = requestContext();
    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-call', payload: { toolCallId: 'task', toolName: 'work', args: { visible: true } } }),
      ctx,
    );
    expect(session.displayState.get().activeTools.get('task')?.status).toBe('running');
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-execution-start',
        payload: { runId: 'run-exact', args: { toolCallId: 'task', toolName: 'work', args: { visible: true } } },
      }),
      ctx,
    );
    expect(session.displayState.get().activeTools.get('task')?.status).toBe('executing');
    await engine.processStreamChunk(
      state,
      chunk({ type: 'tool-result', payload: { toolCallId: 'task', toolName: 'work', result: 'done' } }),
      ctx,
    );
    expect(session.displayState.get().activeTools.get('task')?.status).toBe('completed');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_end',
        runId: 'run-exact',
        toolCallId: 'task',
        toolName: 'work',
        messageId: state.currentMessage.id,
        completedAt: expect.any(String),
        isError: false,
      }),
    );
  });

  it('cancelled active work has one failed outcome, never a successful completion', async () => {
    const { session, events } = createHarness();
    session.emit({ type: 'tool_execution_start', runId: 'run-cancel', toolCallId: 'task', toolName: 'work', args: {} });
    await session.finishAgentRun('aborted');
    await session.finishAgentRun('aborted');
    const outcomes = events.filter(event => event.type === 'tool_end');
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ toolCallId: 'task', isError: true, cancelled: true });
  });
});

it('a background dispatch stays active and announces only its real final result', async () => {
  const { engine, session, events } = createHarness();
  const state = engine.createStreamState(undefined, 'background-run');
  const ctx = requestContext();
  await engine.processStreamChunk(
    state,
    chunk({ type: 'tool-call', payload: { toolCallId: 'bg', toolName: 'work', args: {} } }),
    ctx,
  );
  await engine.processStreamChunk(
    state,
    chunk({
      type: 'tool-execution-start',
      payload: { runId: 'background-run', args: { toolCallId: 'bg', toolName: 'work' } },
    }),
    ctx,
  );
  await engine.processStreamChunk(
    state,
    chunk({
      type: 'tool-result',
      payload: {
        toolCallId: 'bg',
        toolName: 'work',
        result: 'Dispatched',
        providerMetadata: { mastra: { backgroundTask: { taskId: 'bg-task', status: 'running' } } },
      },
    }),
    ctx,
  );
  expect(events.filter(event => event.type === 'tool_end')).toHaveLength(0);
  await session.finishAgentRun('complete');
  session.emit({ type: 'agent_start' });
  expect(session.displayState.get().activeTools.get('bg')).toMatchObject({ status: 'executing', background: true });
  await engine.processStreamChunk(
    state,
    chunk({ type: 'tool-result', payload: { toolCallId: 'bg', toolName: 'work', result: 'Actual result' } }),
    ctx,
  );
  expect(events.filter(event => event.type === 'tool_end')).toHaveLength(1);
  expect(session.displayState.get().activeTools.get('bg')).toMatchObject({ status: 'completed', background: false });
});
