import { describe, expect, it, vi } from 'vitest';
import { Session } from '../session';

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
  if (bound) session.thread.set({ threadId: 'thread' });
  return { session, agent, buildRequestContext };
}

describe('native command acceptance receipts', () => {
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

  it('consumes a restored native gate before a synchronous reentrant duplicate', () => {
    const { session } = fixture();
    const respond = vi.fn(() => {
      expect(session.respondToToolApproval({ decision: 'approve', toolCallId: 'restored' })).toMatchObject({
        accepted: false,
      });
    });
    session.approval.restore({ toolName: 'tool', toolCallId: 'restored', runId: 'saved-run', respond });
    expect(
      session.respondToToolApproval({ decision: 'approve', toolCallId: 'restored', expectedRunId: 'wrong' }),
    ).toMatchObject({ accepted: false, reason: 'stale_target' });
    expect(
      session.respondToToolApproval({ decision: 'approve', toolCallId: 'restored', expectedRunId: 'saved-run' }),
    ).toMatchObject({ accepted: true, runId: 'saved-run' });
    expect(session.approval.getRunId()).toBe('saved-run');
    expect(session.abort({ expectedRunId: 'saved-run' })).toMatchObject({ accepted: true, runId: 'saved-run' });
    expect(session.approval.getRunId()).toBeNull();
    expect(respond).toHaveBeenCalledTimes(1);
  });

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
      session.suspensions.register({ toolCallId: 'question', toolName, runId: 'saved-run' });
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
    session.suspensions.register({ toolCallId: 'one', toolName: 'ask_user', runId: 'run' });
    session.suspensions.register({ toolCallId: 'two', toolName: 'ask_user', runId: 'run' });
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
    session.suspensions.register({ toolCallId: 'plan', toolName: 'submit_plan', runId: 'old-run' });
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

  it('keeps acceptance when later request-context work fails and reports the native error', async () => {
    const { session, buildRequestContext } = fixture();
    const failure = new Error('context failed');
    buildRequestContext.mockRejectedValue(failure);
    vi.spyOn(session, 'finishAgentRun').mockResolvedValue(undefined);
    const events: any[] = [];
    session.subscribe(event => events.push(event));
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'saved-run' });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'error', error: failure }));
  });

  it('preserves accepted receipt and reports one dependency failure when the native question is restored', async () => {
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
    const finish = vi.spyOn(session, 'finishAgentRun');
    const events: any[] = [];
    session.subscribe(event => events.push(event));
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'saved-run' });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    await vi.waitFor(() =>
      expect(events.filter(event => event.type === 'error')).toEqual([{ type: 'error', error: failure }]),
    );
    expect(session.suspensions.resolveToolCallId('question')).toBe('question');
    expect(session.suspensions.get({ toolCallId: 'question' })?.runId).toBe('saved-run');
    expect(finish).not.toHaveBeenCalled();
  });

  it('rejects idle unbound Stop and stale Stop; accepts a parked target only once', () => {
    const { session, agent } = fixture(false);
    expect(session.abort()).toMatchObject({ accepted: false, reason: 'no_pending_target' });
    session.suspensions.register({ toolCallId: 'wait', toolName: 'custom_wait', runId: 'saved-run' });
    expect(session.abort({ expectedOperationId: 999 })).toMatchObject({ accepted: false, reason: 'stale_target' });
    expect(session.suspensions.hasPending()).toBe(true);
    expect(session.abort()).toMatchObject({ accepted: true, command: 'abort' });
    expect(agent.abortRunStream).toHaveBeenCalledExactlyOnceWith('saved-run');
    expect(session.abort()).toMatchObject({ accepted: false, reason: 'stopping' });
  });

  it.each([false, true])('identifies multiple saved tools without inventing a run (distinct=%s)', distinct => {
    const { session, agent } = fixture(false);
    session.suspensions.register({ toolCallId: 'one', toolName: 'ask_user', runId: 'saved-run' });
    session.suspensions.register({
      toolCallId: 'two',
      toolName: 'custom_wait',
      runId: distinct ? 'other-run' : 'saved-run',
    });
    const receipt = session.abort({ expectedRunId: 'saved-run' });
    expect(receipt).toMatchObject(
      distinct ? { accepted: false, reason: 'ambiguous_target' } : { accepted: true, runId: 'saved-run' },
    );
    expect(agent.abortRunStream).toHaveBeenCalledTimes(distinct ? 0 : 1);
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
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'saved-run' });
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
    const { session, agent, buildRequestContext } = fixture();
    let release!: (value: any) => void;
    buildRequestContext.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'saved-run' });
    expect(
      await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' }),
    ).toMatchObject({ accepted: true });
    expect(session.getCurrentRunId()).toBeNull();
    expect(session.abort({ expectedRunId: 'saved-run' })).toMatchObject({ accepted: true, runId: 'saved-run' });
    expect(agent.abortRunStream).toHaveBeenCalledExactlyOnceWith('saved-run');
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
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'old-run' });
    await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' });
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'new-run' });
    reject(new Error('old preparation failed'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(session.suspensions.get({ toolCallId: 'question' })).toEqual({ toolName: 'ask_user', runId: 'new-run' });
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
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'old-run' });
    await session.respondToToolSuspensionWithReceipt({ toolCallId: 'question', resumeData: 'answer' });
    session.suspensions.register({ toolCallId: 'question', toolName: 'ask_user', runId: 'new-run' });
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

  it('rechecks the captured target after waiting for another subscription before cleanup', async () => {
    const { session, agent } = fixture();
    let release!: (value: any) => void;
    session.setMachinery({
      getAgent: () => agent,
      subscribeToThread: () =>
        new Promise(resolve => {
          release = resolve;
        }),
    } as any);
    vi.spyOn(session, 'processSubscribedThreadStream').mockResolvedValue(undefined);
    vi.spyOn(session, 'restorePendingApproval').mockResolvedValue(undefined);
    const first = session.thread.ensureSubscription('thread', agent as any);
    let current = true;
    const second = session.thread.ensureSubscription('thread', agent as any, false, () => current);
    const rejected = expect(second).rejects.toThrow('stale_target');
    current = false;
    const subscription = { unsubscribe: vi.fn(), activeRunId: () => null };
    release(subscription);
    await first;
    await rejected;
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });
});
