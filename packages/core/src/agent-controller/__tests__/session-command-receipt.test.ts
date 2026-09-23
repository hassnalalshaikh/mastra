import { describe, expect, it, vi } from 'vitest';
import z from 'zod';
import { Agent } from '../../agent';
import { InMemoryStore } from '../../storage';
import { MastraLanguageModelV2Mock } from '../../test-utils/llm-mock';
import { createTool } from '../../tools';
import { submitPlanTool } from '../../tools/builtin/submit-plan';
import { AgentController } from '../agent-controller';
import { Session, SessionStream } from '../session';
import { createMockWorkspace } from '../test-utils';

function nativeStream(toolName?: string) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'response-metadata', id: 'response', modelId: 'mock', timestamp: new Date(0) });
      if (toolName) {
        controller.enqueue({
          type: 'tool-call',
          toolCallId: 'question',
          toolName,
          input: '{"path":"plan.md"}',
          providerExecuted: false,
        });
      } else {
        controller.enqueue({ type: 'text-start', id: 'text' });
        controller.enqueue({ type: 'text-delta', id: 'text', delta: 'Done.' });
        controller.enqueue({ type: 'text-end', id: 'text' });
      }
      controller.enqueue({
        type: 'finish',
        finishReason: toolName ? 'tool-calls' : 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      controller.close();
    },
  });
}

async function nativeFixture(plan = false) {
  let calls = 0;
  const confirm = createTool({
    id: 'confirm',
    description: 'Ask for confirmation',
    inputSchema: z.object({ path: z.string() }),
    execute: async (_input, context) => {
      if (context?.agent?.resumeData === 'done') return 'done';
      await context?.agent?.suspend({ question: 'Continue?' });
      return 'waiting';
    },
  });
  const agent = new Agent({
    id: 'plan',
    name: 'plan',
    instructions: 'Ask once.',
    model: new MastraLanguageModelV2Mock({
      doStream: async () => ({ stream: nativeStream(calls++ === 0 ? (plan ? 'submit_plan' : 'confirm') : undefined) }),
    }),
    tools: plan ? { submit_plan: submitPlanTool } : { confirm },
  });
  const build = new Agent({
    id: 'build',
    name: 'build',
    instructions: 'Build.',
    model: new MastraLanguageModelV2Mock({ doStream: async () => ({ stream: nativeStream() }) }),
  });
  const controller = new AgentController({
    id: 'receipt-native',
    workspace: createMockWorkspace(),
    storage: new InMemoryStore(),
    initialState: { yolo: true } as any,
    modes: [
      { id: 'plan', name: 'Plan', default: true, agent, ...(plan ? { transitionsTo: 'build' } : {}) },
      { id: 'build', name: 'Build', agent: build },
    ],
  });
  await controller.init();
  const session = await controller.createSession({ id: 'session', ownerId: 'owner', resourceId: 'user' });
  await session.thread.create();
  await session.sendMessage({ content: 'Start.' });
  return { session, agent, build };
}

function fixture(bound = true) {
  const session = new Session({ id: 'session', ownerId: 'owner', resourceId: 'user' });
  session.thread.connect(undefined, session);
  const buildRequestContext = vi.fn(() => new Promise<any>(() => {}));
  const agent = {
    id: 'agent',
    abortRunStream: vi.fn(),
    abortThreadStream: vi.fn(),
    listSuspendedRuns: vi.fn(async () => ({ runs: [] })),
    getMastraInstance: () => undefined,
  };
  session.setMachinery({
    getAgent: () => agent,
    getRunScope: () => undefined,
    buildRequestContext,
    resolveTransitionModeId: () => undefined,
  } as any);
  const settle = vi
    .spyOn(session.runEngine, 'settleSuspendedToolCallsAsDenied')
    .mockImplementation(() => new Promise(() => {}));
  if (bound) session.thread.set({ threadId: 'thread' });
  return { session, agent, buildRequestContext, settle };
}

describe('native command acceptance receipts', () => {
  it('preserves an immediate same-tool same-run re-suspension before the send response returns', async () => {
    const { session, agent } = await nativeFixture();
    const original = session.suspensions.get({ toolCallId: 'question' })!;
    expect(original).toBeDefined();
    const send = agent.sendStreamResume.bind(agent);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    vi.spyOn(agent, 'sendStreamResume').mockImplementationOnce(async options => {
      await send(options);
      await held;
    });
    let observed!: () => void;
    const resuspended = new Promise<void>(resolve => {
      observed = resolve;
    });
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_suspended') observed();
    });
    const answer = session.respondToToolSuspension({ toolCallId: 'question', resumeData: 'again' });
    await resuspended;
    release();
    await answer;
    unsubscribe();
    const next = session.suspensions.get({ toolCallId: 'question' });
    expect(next).toMatchObject({ runId: original.runId, toolName: 'confirm' });
    expect(next).not.toBe(original);
    expect(next?.claimed).not.toBe(true);
    await session.respondToToolSuspension({ toolCallId: 'question', resumeData: 'done' });
    expect(session.suspensions.hasPending()).toBe(false);
  });

  it('restores the selected build subscription after the native plan resume starts a new operation', async () => {
    const { session, build } = await nativeFixture(true);
    const before = session.run.getOperationId();
    await session.respondToToolSuspension({ toolCallId: 'question', resumeData: { action: 'approved' } });
    expect(session.run.getOperationId()).toBeGreaterThan(before);
    expect(session.mode.get()).toBe('build');
    expect(
      session.stream.matches({
        key: SessionStream.keyFor({
          agent: build,
          threadId: session.thread.requireId(),
          resourceId: session.identity.getResourceId(),
        }),
      }),
    ).toBe(true);
  });
  it.each(['approve', 'decline', 'always_allow_category'] as const)(
    'accepts %s once and rejects stale and resolved gates',
    async decision => {
      const { session } = fixture();
      const settled = session.approval.arm({ toolName: 'tool', toolCallId: 'current' });
      expect(session.respondToToolApproval({ decision, toolCallId: 'old' })).toMatchObject({
        accepted: false,
        reason: 'stale_target',
      });
      expect(session.approval.isArmed()).toBe(true);
      expect(session.respondToToolApproval({ decision, toolCallId: 'current' })).toMatchObject({
        command: 'approval',
        accepted: true,
        toolCallId: 'current',
      });
      expect(session.respondToToolApproval({ decision, toolCallId: 'current' })).toMatchObject({
        accepted: false,
        reason: 'no_pending_target',
      });
      expect(await settled).toMatchObject({ decision: decision === 'decline' ? 'decline' : 'approve' });
    },
  );

  it('does not accept approval after Stop begins', () => {
    const { session } = fixture();
    void session.approval.arm({ toolName: 'tool', toolCallId: 'current' });
    session.run.requestAbort({ deferSignal: true });
    expect(session.respondToToolApproval({ decision: 'approve', toolCallId: 'current' })).toMatchObject({
      accepted: false,
      reason: 'stopping',
    });
    expect(session.approval.isArmed()).toBe(true);
  });

  it.each(['ask_user', 'request_access', 'submit_plan', 'custom_wait'])(
    'receipts %s before execution and rejects a double click',
    async toolName => {
      const { session, buildRequestContext } = fixture();
      session.suspensions.register({
        threadId: 'thread',
        resourceId: 'user',
        toolCallId: 'question',
        toolName,
        runId: 'saved-run',
      });
      const first = session.respondToToolSuspensionWithReceipt({
        toolCallId: 'question',
        resumeData: { action: 'approved' },
      });
      expect(await first).toEqual({
        command: 'suspension',
        accepted: true,
        toolCallId: 'question',
        runId: 'saved-run',
      });
      expect(buildRequestContext).toHaveBeenCalledTimes(1);
      expect(
        await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'duplicate' }),
      ).toMatchObject({ accepted: false, reason: 'no_pending_target' });
    },
  );

  it('rejects absent, stale, ambiguous and stopping questions without execution', async () => {
    const { session, buildRequestContext } = fixture();
    const answer = (toolCallId?: string) =>
      session.respondToToolSuspensionWithReceipt({ toolCallId, resumeData: 'answer' });
    expect(await answer('old')).toMatchObject({ accepted: false, reason: 'no_pending_target' });
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'one',
      toolName: 'ask_user',
      runId: 'run',
    });
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'two',
      toolName: 'ask_user',
      runId: 'run',
    });
    expect(
      await session.respondToToolSuspensionWithReceipt({
        toolCallId: 'one',
        resumeData: 'answer',
        expectedRunId: 'wrong',
      }),
    ).toMatchObject({ accepted: false, reason: 'stale_target' });
    expect(await answer('old')).toMatchObject({ accepted: false, reason: 'stale_target' });
    expect(await answer()).toMatchObject({ accepted: false, reason: 'ambiguous_target' });
    session.run.requestAbort();
    expect(await answer('one')).toMatchObject({ accepted: false, reason: 'stopping' });
    expect(buildRequestContext).not.toHaveBeenCalled();
  });

  it('claims the plan once before the transition and prevents a delayed switch after Stop', async () => {
    const { session, agent, buildRequestContext } = fixture();
    session.setMachinery({
      getAgent: () => agent,
      getRunScope: () => undefined,
      buildRequestContext,
      resolveTransitionModeId: () => 'build',
    } as any);
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'plan',
      toolName: 'submit_plan',
      runId: 'old-run',
    });
    const switchMode = vi.spyOn(session.mode, 'switch').mockResolvedValue(undefined);
    const finish = vi.spyOn(session, 'finishAgentRun');
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'plan', resumeData: { action: 'approved' } }),
    ).toMatchObject({ accepted: true });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'plan', resumeData: { action: 'approved' } }),
    ).toMatchObject({ accepted: false, reason: 'no_pending_target' });
    session.abort();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(switchMode).not.toHaveBeenCalled();
    expect(buildRequestContext).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it.each([
    { threadId: 'another-thread', resourceId: 'user' },
    { threadId: 'thread', resourceId: 'another-user' },
  ])('rejects a suspension outside its captured scope: %o', async scope => {
    const { session, buildRequestContext } = fixture();
    session.suspensions.register({ ...scope, toolCallId: 'question', toolName: 'ask_user', runId: 'run' });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: false, reason: 'stale_target' });
    expect(buildRequestContext).not.toHaveBeenCalled();
    expect(session.suspensions.get({ toolCallId: 'question' })?.claimed).not.toBe(true);
  });

  it('keeps a claimed suspension claimed when the same native event is re-emitted', async () => {
    const { session } = fixture();
    const target = {
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'run',
    };
    session.suspensions.register(target);
    const pending = session.suspensions.get({ toolCallId: 'question' });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    session.suspensions.register(target);
    expect(session.suspensions.get({ toolCallId: 'question' })).toBe(pending);
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'again' }),
    ).toMatchObject({ accepted: false, reason: 'no_pending_target' });
    expect(session.abort({ expectedRunId: 'run', localOnly: true })).toMatchObject({ accepted: true, runId: 'run' });
  });

  it('keeps acceptance when later request-context work fails and reports the native error', async () => {
    const { session, buildRequestContext } = fixture();
    const failure = new Error('context failed');
    buildRequestContext.mockRejectedValue(failure);
    vi.spyOn(session, 'finishAgentRun').mockResolvedValue(undefined);
    const events: any[] = [];
    session.subscribe(event => events.push(event));
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'saved-run',
    });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'error', error: failure }));
  });

  it('preserves accepted receipt and reports a later execution failure', async () => {
    const { session } = fixture();
    const failure = Object.assign(new Error('Required tool dependency missing'), { name: 'ToolDependencyError' });
    const agent = {
      sendStreamResume: vi.fn(async () => {
        throw failure;
      }),
    };
    session.setMachinery({
      getAgent: () => agent,
      getRunScope: () => undefined,
      buildRequestContext: async () => ({}),
      buildSharedRunOptions: () => ({}),
      buildToolsets: async () => ({}),
    } as any);
    vi.spyOn(session.thread, 'ensureSubscription').mockResolvedValue(undefined);
    const finish = vi.spyOn(session, 'finishAgentRun').mockResolvedValue(undefined);
    const events: any[] = [];
    session.subscribe(event => events.push(event));
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'saved-run',
    });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    await vi.waitFor(() =>
      expect(events.filter(event => event.type === 'error')).toEqual([{ type: 'error', error: failure }]),
    );
    expect(session.suspensions.has({ toolCallId: 'question' })).toBe(false);
    expect(finish).toHaveBeenCalledExactlyOnceWith('error');
  });

  it('rejects idle unbound Stop and stale Stop; accepts a parked target only once', () => {
    const { session, settle } = fixture(false);
    expect(session.abort()).toMatchObject({ accepted: false, reason: 'no_pending_target' });
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'wait',
      toolName: 'custom_wait',
      runId: 'saved-run',
    });
    expect(session.abort({ expectedOperationId: 999 })).toMatchObject({ accepted: false, reason: 'stale_target' });
    expect(session.suspensions.hasPending()).toBe(true);
    expect(session.abort()).toMatchObject({ accepted: true, command: 'abort' });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(session.abort()).toMatchObject({ accepted: false, reason: 'stopping' });
  });

  it.each([false, true])('identifies multiple saved tools without inventing a run (distinct=%s)', distinct => {
    const { session, settle } = fixture(false);
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'one',
      toolName: 'ask_user',
      runId: 'saved-run',
    });
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'two',
      toolName: 'custom_wait',
      runId: distinct ? 'other-run' : 'saved-run',
    });
    const receipt = session.abort({ expectedRunId: 'saved-run' });
    expect(receipt).toMatchObject(
      distinct ? { accepted: false, reason: 'ambiguous_target' } : { accepted: true, runId: 'saved-run' },
    );
    expect(settle).toHaveBeenCalledTimes(distinct ? 0 : 1);
  });

  it('does not resume or finish another thread when context resolution crosses navigation', async () => {
    const { session, buildRequestContext } = fixture();
    let release!: (value: any) => void;
    buildRequestContext.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const subscription = vi.spyOn(session.thread, 'ensureSubscription');
    const finish = vi.spyOn(session, 'finishAgentRun');
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'saved-run',
    });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    session.thread.set({ threadId: 'other-thread' });
    release({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscription).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(session.suspensions.hasPending()).toBe(false);
  });

  it('keeps the exact accepted question available to Stop while context is preparing', async () => {
    const { session, settle, buildRequestContext } = fixture();
    let release!: (value: any) => void;
    buildRequestContext.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'saved-run',
    });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    expect(session.getCurrentRunId()).toBeNull();
    expect(session.abort({ expectedRunId: 'saved-run' })).toMatchObject({ accepted: true, runId: 'saved-run' });
    expect(settle).toHaveBeenCalledTimes(1);
    release({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.suspensions.hasPending()).toBe(false);
  });

  it('cleanup keeps a later suspension registered with the same tool ID', async () => {
    const { session, buildRequestContext } = fixture();
    let reject!: (error: Error) => void;
    buildRequestContext.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    vi.spyOn(session, 'finishAgentRun').mockResolvedValue(undefined);
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'old-run',
    });
    await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' });
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'new-run',
    });
    reject(new Error('old preparation failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.suspensions.get({ toolCallId: 'question' })).toMatchObject({
      toolName: 'ask_user',
      runId: 'new-run',
    });
  });

  it('successful old preparation cannot resume a replacement under the same tool ID', async () => {
    const { session, buildRequestContext } = fixture();
    let release!: (value: any) => void;
    buildRequestContext.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const subscription = vi.spyOn(session.thread, 'ensureSubscription');
    const finish = vi.spyOn(session, 'finishAgentRun');
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'old-run',
    });
    await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' });
    session.suspensions.register({
      threadId: 'thread',
      resourceId: 'user',
      toolCallId: 'question',
      toolName: 'ask_user',
      runId: 'new-run',
    });
    release({});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(subscription).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(session.suspensions.get({ toolCallId: 'question' })?.runId).toBe('new-run');
  });

  it('does not write mode settings into another thread after outgoing settings wait', async () => {
    const { session } = fixture();
    let release!: () => void;
    const oldSet = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    session.setStore({ get: vi.fn(), set: oldSet });
    session.mode.setResolver(modeId => ({ id: modeId, name: modeId }));
    session.mode.set({ modeId: 'plan' });
    session.model.set({ modelId: 'old-model' });
    const switching = session.mode.switch({ modeId: 'build', isCurrent: () => session.thread.getId() === 'thread' });
    const newSet = vi.fn();
    session.thread.set({ threadId: 'other-thread' });
    session.setStore({ get: vi.fn(), set: newSet });
    release();
    await switching;
    expect(oldSet).toHaveBeenCalledTimes(1);
    expect(newSet).not.toHaveBeenCalled();
  });

  it('does not attach a subscription after its captured command target changes', async () => {
    const { session, agent } = fixture();
    let release!: (value: any) => void;
    session.setMachinery({
      getAgent: () => agent,
      subscribeToThread: () =>
        new Promise(resolve => {
          release = resolve;
        }),
    } as any);
    const attach = vi.spyOn(session.stream, 'attach');
    let current = true;
    const opening = session.thread.ensureSubscription('thread', agent as any, () => current);
    const rejected = expect(opening).rejects.toThrow('stale_target');
    current = false;
    const subscription = { unsubscribe: vi.fn() };
    release(subscription);
    await rejected;
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(attach).not.toHaveBeenCalled();
  });
});
