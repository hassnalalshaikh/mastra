/**
 * Regression test for the operation-id guard in `Session.completeDeferredAbort()`.
 *
 * A Stop on a run parked on a suspension / approval gate defers its teardown until the
 * parked call has been settled. If the user sends a new message in that window, a new
 * operation starts on the SAME thread binding (the binding generation does not change,
 * so the binding-generation guard cannot catch it). The stale deferred abort must then
 * be skipped, otherwise the new message would inherit the Stop.
 */
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent';
import { InMemoryStore } from '../../storage';
import { AgentController } from '../agent-controller';
import { createMockWorkspace } from '../test-utils';

vi.setConfig({ testTimeout: 30_000 });

async function createSession(id: string) {
  const agent = new Agent({
    id: `${id}-agent`,
    name: `${id} agent`,
    instructions: 'Test agent.',
    model: { provider: 'openai', name: 'gpt-4o', toolChoice: 'auto' },
  });
  const controller = new AgentController({
    workspace: createMockWorkspace(),
    id: `${id}-controller`,
    storage: new InMemoryStore(),
    modes: [{ id: 'default', name: 'Default', default: true, agent }],
  });
  await controller.init();
  const session = await controller.createSession({ id: `${id}-session`, ownerId: 'owner-1' });
  await session.thread.create();
  return session;
}

describe('completeDeferredAbort operation-id guard', () => {
  it.each([true, false])(
    'skips a stale deferred abort when a newer operation started on the same binding (localOnly=%s)',
    async localOnly => {
      const session = await createSession(`op-guard-direct-${localOnly}`);

      // Operation A is running; its Stop is deferred and captures the origin.
      session.run.nextOperation();
      session.run.ensureAbortController();
      const origin = {
        bindingGeneration: session.run.bindingGeneration(),
        operationId: session.run.getOperationId(),
        localOnly,
      };

      // Operation B starts on the same binding (no rebind, so the generation is unchanged).
      session.run.nextOperation();
      const controllerB = session.run.ensureAbortController();
      expect(session.run.bindingGeneration()).toBe(origin.bindingGeneration);

      const streamAbort = vi.spyOn(session.stream, 'abort');
      session.completeDeferredAbort(origin);

      expect(streamAbort).not.toHaveBeenCalled();
      expect(session.run.isAbortRequested()).toBe(false);
      expect(controllerB.signal.aborted).toBe(false);
    },
  );

  it.each([true, false])(
    'still completes the deferred abort when the operation is unchanged (localOnly=%s)',
    async localOnly => {
      const session = await createSession(`op-guard-control-${localOnly}`);

      session.run.nextOperation();
      const controllerA = session.run.ensureAbortController();
      const origin = {
        bindingGeneration: session.run.bindingGeneration(),
        operationId: session.run.getOperationId(),
        localOnly,
      };

      const streamAbort = vi.spyOn(session.stream, 'abort');
      session.completeDeferredAbort(origin);

      expect(streamAbort).toHaveBeenCalledTimes(1);
      expect(streamAbort).toHaveBeenCalledWith({ localOnly });
      expect(session.run.isAbortRequested()).toBe(true);
      expect(controllerA.signal.aborted).toBe(true);
    },
  );

  it.each([true, false])(
    'does not let a Stop on a parked suspension abort a message sent right after it (localOnly=%s)',
    async localOnly => {
      const session = await createSession(`op-guard-e2e-${localOnly}`);
      session.suspensions.register({
        toolCallId: 'call-a',
        runId: 'run-a',
        toolName: 'confirmAccess',
        threadId: session.thread.requireId(),
        resourceId: session.identity.getResourceId(),
      });

      // Run A is in flight and parked on the suspension.
      session.run.nextOperation();
      session.run.ensureAbortController();

      let release!: () => void;
      const barrier = new Promise<void>(resolve => (release = resolve));
      vi.spyOn(session.runEngine, 'settleSuspendedToolCallsAsDenied').mockImplementation(async () => {
        await barrier;
      });
      const streamAbort = vi.spyOn(session.stream, 'abort');

      session.abort({ localOnly });
      expect(session.run.isAbortRequested()).toBe(true);

      // A message sent right after Stop starts operation B on the same binding (the
      // stopped run's state is reset, the binding generation is unchanged).
      session.run.reset();
      session.run.nextOperation();
      const controllerB = session.run.ensureAbortController();

      // The parked run's settlement lands afterwards.
      release();
      await barrier;
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(streamAbort).not.toHaveBeenCalled();
      expect(session.run.isAbortRequested()).toBe(false);
      expect(controllerB.signal.aborted).toBe(false);
    },
  );
});
