import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import type { MastraDBMessage } from '../../agent/message-list/state/types';
import { RequestContext } from '../../request-context';
import { Workspace } from '../../workspace';
import { LocalFilesystem } from '../../workspace/filesystem/local-filesystem';
import type { SessionMachinery } from '../session';
import { Session } from '../session';
import { SessionRunEngine } from '../session-run-engine';
import type { AgentControllerEvent } from '../types';

/**
 * BDD spec for the DB-native message contract of the run engine.
 *
 * Given a streamed run, the engine must build and emit `MastraDBMessage`s:
 * `content.format === 2` with nested `content.parts` accumulating
 * `text` / `reasoning` / `tool-invocation` parts in stream order — NOT the
 * legacy flat `AgentControllerMessageContent` union.
 */

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
    getAgent: () =>
      new Agent({
        id: 'stream-fixture',
        name: 'Stream fixture',
        instructions: 'Local folding only.',
        model: 'openai/gpt-4.1-mini',
      }),
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

  const engine = new SessionRunEngine(session, machinery);
  return { engine, events, session };
}

function isMastraDBMessage(value: unknown): value is MastraDBMessage {
  return typeof value === 'object' && value !== null && 'content' in value && 'role' in value;
}

function lastMessageEvent(events: AgentControllerEvent[]): MastraDBMessage {
  for (const event of [...events].reverse()) {
    if ('message' in event && isMastraDBMessage(event.message)) {
      return event.message;
    }
  }
  throw new Error('no message event emitted');
}

function textOf(message: MastraDBMessage): string {
  return message.content.parts.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('');
}

function requestContext(): RequestContext {
  return new RequestContext();
}

function chunk(value: StreamChunk): StreamChunk {
  return value;
}

/**
 * A subagent delegated through `Agent.agents` streams its chunks back as
 * `tool-output` chunks from `AGENT` on the parent's `agent-<key>` tool call.
 * The run engine folds them into the same `subagent_*` events (and so the same
 * `activeSubagents` display state) the built-in `subagent` tool produces.
 */
describe('SessionRunEngine — delegated subagent progress', () => {
  const nested = (type: string, payload: Record<string, unknown>) =>
    chunk({
      type: 'tool-output',
      runId: 'run-1',
      payload: {
        toolCallId: 'delegate-1',
        toolName: 'agent-helperAgent',
        output: { type, from: 'AGENT', runId: 'sub-run', payload },
      },
    } as StreamChunk);

  it('shows a delegated helper live in activeSubagents and closes it when the parent call settles', async () => {
    const { engine, events, session } = createHarness();
    const state = engine.createStreamState('run-1');
    const ctx = requestContext();
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-call',
        runId: 'run-1',
        payload: {
          toolCallId: 'delegate-1',
          toolName: 'agent-helperAgent',
          args: { prompt: 'Research the latest AI news', instructions: 'Role: News researcher' },
        },
      }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      nested('tool-call', { toolCallId: 'inner-1', toolName: 'workflow-deep-search', args: { q: 'ai' } }),
      ctx,
    );

    const live = session.displayState.get().activeSubagents.get('delegate-1');
    expect(live).toMatchObject({
      agentType: 'helperAgent',
      task: 'Research the latest AI news',
      status: 'running',
      toolCalls: [{ name: 'workflow-deep-search', isError: false }],
    });

    await engine.processStreamChunk(
      state,
      nested('tool-result', { toolCallId: 'inner-1', toolName: 'workflow-deep-search', result: { ok: true } }),
      ctx,
    );
    await engine.processStreamChunk(
      state,
      nested('tool-error', { toolCallId: 'inner-2', toolName: 'search_tools', error: new Error('boom') }),
      ctx,
    );
    await engine.processStreamChunk(state, nested('text-delta', { id: 't', text: 'Found 3 stories' }), ctx);
    expect(session.displayState.get().activeSubagents.get('delegate-1')?.textDelta).toBe('Found 3 stories');

    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-result',
        runId: 'run-1',
        payload: {
          toolCallId: 'delegate-1',
          toolName: 'agent-helperAgent',
          result: { text: 'Final findings' },
        },
      }),
      ctx,
    );

    const ended = session.displayState.get().activeSubagents.get('delegate-1');
    expect(ended).toMatchObject({ status: 'completed', result: 'Final findings' });
    expect(typeof ended?.durationMs).toBe('number');
    expect(events.map(event => event.type).filter(type => type.startsWith('subagent_'))).toEqual([
      'subagent_start',
      'subagent_tool_start',
      'subagent_tool_end',
      'subagent_tool_end',
      'subagent_text_delta',
      'subagent_end',
    ]);
  });

  it('ignores tool output that is not from a delegated agent', async () => {
    const { engine, events } = createHarness();
    const state = engine.createStreamState('run-1');
    await engine.processStreamChunk(
      state,
      chunk({
        type: 'tool-output',
        runId: 'run-1',
        payload: { toolCallId: 'wf-1', toolName: 'workflow-x', output: { type: 'step-start', from: 'WORKFLOW' } },
      } as StreamChunk),
      requestContext(),
    );
    expect(events.some(event => event.type.startsWith('subagent_'))).toBe(false);
  });
});
