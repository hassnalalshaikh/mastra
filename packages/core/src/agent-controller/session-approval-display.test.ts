// Test-gate port of fork patch P01 (fa3c643cd9 "fix(core): clear resolved session approval prompts").
// Ported to the 1.74 approval API: `displayState.pendingApproval` became the
// `pendingApprovals` Map, `approval.getToolCallId()` became `getToolCallIds()`,
// and `respondToToolApproval` now requires `toolCallId` (so the fork case
// "accepts a response without an optional tool call id" has no 1.74 equivalent).
// Assertions are otherwise unchanged.
import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../request-context';
import { Session } from './session';
import { createMockWorkspace } from './test-utils';

function createSession() {
  const session = new Session({ resourceId: 'r1', id: 's1', ownerId: 'o1', workspace: createMockWorkspace() });
  session.emit({ type: 'agent_start' });
  return session;
}

function requestApproval(session: Session, toolCallId: string) {
  const toolName = 'write_file';
  const args = { path: `${toolCallId}.txt` };
  session.emit({ type: 'tool_start', toolCallId, toolName, args });
  const decision = session.approval.arm({ toolName, toolCallId });
  session.emit({ type: 'tool_approval_required', toolCallId, toolName, args });
  return decision;
}

function pendingIds(session: Session) {
  return [...session.displayState.get().pendingApprovals.keys()];
}

function observeDisplay(session: Session) {
  const changed = vi.fn();
  session.subscribe(event => {
    if (event.type === 'display_state_changed') {
      // Copy the fields under test: the native snapshot remains mutable.
      changed({
        pendingApprovals: [...event.displayState.pendingApprovals.keys()],
        isRunning: event.displayState.isRunning,
        toolStatus: event.displayState.activeTools.get('t1')?.status,
      });
    }
  });
  return changed;
}

describe('Session approval display (P01 test-gate)', () => {
  it.each(['approve', 'decline', 'always_allow_category'] as const)(
    'clears the prompt immediately after %s while preserving the running tool and decision',
    async decision => {
      const session = createSession();
      session.setCategoryResolver(() => 'edit');
      const approval = requestApproval(session, 't1');
      const changed = observeDisplay(session);
      const requestContext = new RequestContext();
      const declineContext = { reason: 'not needed', message: 'Skip this file' };

      session.respondToToolApproval({ decision, toolCallId: 't1', requestContext, declineContext });

      expect(session.approval.isArmed()).toBe(false);
      expect(pendingIds(session)).toEqual([]);
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        pendingApprovals: [],
        isRunning: true,
        toolStatus: 'running',
      });
      await expect(approval).resolves.toEqual({
        decision: decision === 'decline' ? 'decline' : 'approve',
        requestContext,
        declineContext,
      });
      expect(session.hasCategoryGrant('edit')).toBe(decision === 'always_allow_category');

      session.emit({ type: 'tool_end', toolCallId: 't1', result: 'done', isError: false });
      expect(pendingIds(session)).toEqual([]);
      expect(session.displayState.get().isRunning).toBe(true);
    },
  );

  it('does not clear a current prompt or grant a category for the wrong tool call id', async () => {
    const session = createSession();
    session.setCategoryResolver(() => 'edit');
    const approval = requestApproval(session, 't1');
    const changed = observeDisplay(session);

    session.respondToToolApproval({ decision: 'always_allow_category', toolCallId: 'stale' });

    expect(session.approval.isArmed()).toBe(true);
    expect(pendingIds(session)).toEqual(['t1']);
    expect(session.hasCategoryGrant('edit')).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    session.respondToToolApproval({ decision: 'decline', toolCallId: 't1' });
    await expect(approval).resolves.toMatchObject({ decision: 'decline' });
  });

  it('does not emit another snapshot for a duplicate decision after the gate resolves', async () => {
    const session = createSession();
    const approval = requestApproval(session, 't1');
    session.respondToToolApproval({ decision: 'approve', toolCallId: 't1' });
    await approval;
    const changed = observeDisplay(session);

    session.respondToToolApproval({ decision: 'decline', toolCallId: 't1' });

    expect(pendingIds(session)).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('preserves the next queued approval when a stale response or prior tool result arrives', async () => {
    const session = createSession();
    const firstApproval = requestApproval(session, 't1');
    const changed = observeDisplay(session);
    let nextApproval: ReturnType<typeof requestApproval> | undefined;
    const nextRequested = firstApproval.then(() => {
      nextApproval = requestApproval(session, 't2');
    });

    session.respondToToolApproval({ decision: 'approve', toolCallId: 't1' });
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      pendingApprovals: [],
      isRunning: true,
      toolStatus: 'running',
    });
    await nextRequested;
    expect(pendingIds(session)).toEqual(['t2']);
    changed.mockClear();

    session.respondToToolApproval({ decision: 'decline', toolCallId: 't1' });
    expect(changed).not.toHaveBeenCalled();
    expect(session.approval.getToolCallIds()).toEqual(['t2']);
    session.emit({ type: 'tool_end', toolCallId: 't1', result: 'done', isError: false });
    expect(pendingIds(session)).toEqual(['t2']);

    session.respondToToolApproval({ decision: 'approve', toolCallId: 't2' });
    await expect(nextApproval).resolves.toMatchObject({ decision: 'approve' });
    expect(pendingIds(session)).toEqual([]);
  });

  // Skipped on the 1.74 rebase, not weakened: these cases assert the 1.63 display
  // reducer, which cleared the single pending-approval slot on every agent_end.
  // Upstream #24776 (core 1.72) deliberately removed that clearing: parked
  // approvals are keyed per tool call and thread, and drop only when answered,
  // cancelled, or when the tool call ends. P01's own behavior (publish the
  // cleared prompt right after a decision) is covered by the cases above.
  // Whether Khayalek still needs terminal clearing is an open owner decision:
  // .planning/agent-env-issues/core-upgrade/build/OPEN-QUESTIONS.md (P01).
  it.skip.each(['complete', 'aborted', 'error', 'suspended'] as const)(
    'keeps terminal %s cleanup and later decisions from restoring an old prompt',
    async reason => {
      const session = createSession();
      const approval = requestApproval(session, 't1');

      session.emit({ type: 'agent_end', reason });
      expect(pendingIds(session)).toEqual([]);
      expect(session.displayState.get().isRunning).toBe(false);
      session.respondToToolApproval({ decision: 'decline', toolCallId: 't1' });
      await approval;
      expect(pendingIds(session)).toEqual([]);
      expect(session.displayState.get().isRunning).toBe(false);
    },
  );

  it('keeps a thread reset clear after an outstanding decision arrives', async () => {
    const session = createSession();
    const approval = requestApproval(session, 't1');

    session.emit({ type: 'thread_changed', threadId: 'new-thread', previousThreadId: 'old-thread' });
    expect(pendingIds(session)).toEqual([]);
    expect(session.displayState.get().activeTools.size).toBe(0);
    session.respondToToolApproval({ decision: 'decline', toolCallId: 't1' });
    await approval;
    expect(pendingIds(session)).toEqual([]);
    expect(session.displayState.get().activeTools.size).toBe(0);
  });
});
