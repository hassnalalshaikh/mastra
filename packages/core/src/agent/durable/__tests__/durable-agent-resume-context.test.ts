import type { LanguageModelV2StreamPart } from '@ai-sdk/provider-v5';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '../../../mastra';
import { RequestContext, MASTRA_AUTH_TOKEN_KEY } from '../../../request-context';
import {
  REQUEST_CONTEXT_INPUT_SOURCE,
  captureResumeRequestContext,
  finalizeResumeRequestContext,
  restoreResumeRequestContext,
  getRequestContextInputSource,
  getRequestContextInputValues,
} from '../../../request-context/input-source';
import { InMemoryStore } from '../../../storage';
import { createTool } from '../../../tools';
import { Agent } from '../../agent';
import { DurableStepIds } from '../constants';
import { createDurableAgent } from '../create-durable-agent';
import { globalRunRegistry } from '../run-registry';
import type { DurableAgenticWorkflowInput } from '../types';
import { rebuildRunToolsFromMastra, restoreRequestContext, resolveRuntimeDependencies } from '../utils/resolve-runtime';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function textModel() {
  const doStream = vi.fn(async () => ({
    stream: convertArrayToReadableStream<LanguageModelV2StreamPart>([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: 'OK' },
      { type: 'text-end', id: 'text' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]),
    warnings: [],
  }));
  return { model: new MockLanguageModelV2({ doStream }), doStream };
}

function context(binding: unknown = { model: 'A', price: 2 }) {
  return new RequestContext([
    ['binding', binding],
    ['user', 'old-user'],
    ['allowed', true],
    [MASTRA_AUTH_TOKEN_KEY, 'old-token'],
  ]);
}

describe('original selected durable context', () => {
  it.each(['prepare', 'stream', 'generate'] as const)(
    'refuses missing selected data before %s defaults/model',
    async method => {
      const defaults = vi.fn(() => ({}));
      const fixture = textModel();
      const selectModel = vi.fn(() => fixture.model);
      const agent = createDurableAgent({
        agent: new Agent({
          id: 'required',
          name: 'Required',
          instructions: 'Test.',
          model: selectModel,
          defaultOptions: defaults,
        }),
        resumeRequestContextKeys: ['binding'],
      });
      await expect(agent[method]('Hello', { requestContext: new RequestContext() })).rejects.toThrow(
        'complete original selected request context',
      );
      expect(defaults).not.toHaveBeenCalled();
      expect(selectModel).not.toHaveBeenCalled();
      expect(fixture.doStream).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['nested undefined', { nested: undefined }],
    ['function', { nested: () => 1 }],
    ['nonfinite', { value: Infinity }],
    ['bigint', { value: 1n }],
    ['symbol', { value: Symbol('x') }],
    ['date', new Date(0)],
    ['toJSON', { toJSON: () => ({ partial: true }) }],
    ['sparse', new Array(2)],
    ['budget', 'x'.repeat(16_777_217)],
    ['utf8-budget', '界'.repeat(6_000_000)],
  ])('refuses %s before any model/default callback', async (_label, binding) => {
    const defaults = vi.fn(() => ({}));
    const select = vi.fn(() => textModel().model);
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'invalid',
        name: 'Invalid',
        instructions: 'Test.',
        model: select,
        defaultOptions: defaults,
      }),
      resumeRequestContextKeys: ['binding'],
    });
    await expect(agent.stream('Hello', { requestContext: context(binding) })).rejects.toThrow(
      'complete original selected request context',
    );
    expect(defaults).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it('does not invoke an accessor or accept cyclic selected data', () => {
    const getter = vi.fn(() => 1);
    const accessors = Object.defineProperty({}, 'value', { get: getter, enumerable: true });
    expect(() => captureResumeRequestContext(context(accessors), ['binding'])).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => captureResumeRequestContext(context(cycle), ['binding'])).toThrow();
  });

  it.each([
    'mastra__authToken',
    'mastra__resourceId',
    'mastra__threadId',
    'mastra__versions',
    'mastra__user',
    'mastra__userPermissions',
    'mastra__userRoles',
    'mastra__authMode',
    'mastra__isStudio',
    'mastra__inheritedMemory',
    'organizationId',
    'MastraMemory',
    'controller',
  ])('refuses reserved selection %s', key => {
    expect(() =>
      createDurableAgent({
        agent: new Agent({ id: 'reserved', name: 'Reserved', instructions: 'Test.', model: textModel().model }),
        resumeRequestContextKeys: [key],
      }),
    ).toThrow();
  });

  it('lets initial defaults complete execution selection while keeping original input and cloning once', async () => {
    const incoming = context({ authority: 'admitted' });
    const base = new Agent({
      id: 'complete',
      name: 'Complete',
      instructions: 'Test.',
      model: textModel().model,
      defaultOptions: ({ requestContext }) => {
        requestContext.set('binding', { authority: 'admitted', model: 'A', price: 2 });
        return {};
      },
    });
    const configured = ['binding'];
    const agent = createDurableAgent({ agent: base, resumeRequestContextKeys: configured });
    configured.push('user');
    const prepared = await agent.prepare('Hello', { requestContext: incoming });
    expect(prepared.workflowInput.resumeRequestContextKeys).toEqual(['binding']);
    expect(prepared.workflowInput.resumeRequestContextInputEntries).toEqual({ binding: { authority: 'admitted' } });
    expect(prepared.workflowInput.requestContextEntries?.binding).toEqual({
      authority: 'admitted',
      model: 'A',
      price: 2,
    });
    expect(incoming.get('binding')).toEqual({ authority: 'admitted' });
    prepared.registryEntry.requestContext!.set('binding', { model: 'B' });
    expect(prepared.workflowInput.requestContextEntries?.binding).toEqual({
      authority: 'admitted',
      model: 'A',
      price: 2,
    });
  });

  it('rejects selection deleted by an initial resolver before dispatch', async () => {
    const fixture = textModel();
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'delete',
        name: 'Delete',
        instructions: 'Test.',
        model: fixture.model,
        defaultOptions: ({ requestContext }) => {
          requestContext.delete('binding');
          return {};
        },
      }),
      resumeRequestContextKeys: ['binding'],
    });
    await expect(agent.stream('Hello', { requestContext: context() })).rejects.toThrow(
      'complete original selected request context',
    );
    expect(fixture.doStream).not.toHaveBeenCalled();
  });

  it('retains raw and transformed execution forms without decoding twice', async () => {
    const raw = new RequestContext([
      ['binding', '7'],
      ['fresh', '9'],
    ]);
    const execution = new RequestContext([
      ['binding', 7],
      ['fresh', 9],
    ]);
    Object.defineProperty(execution, Symbol.for('mastra.core.request-context.input-source'), { value: raw });
    const schema = z.object({
      binding: z.string().transform(value => Number(value)),
      fresh: z.string().transform(value => Number(value)),
    });
    const defaults = vi.fn(({ requestContext }) => {
      expect(requestContext.get('binding')).toBe(7);
      return {};
    });
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'transform',
        name: 'Transform',
        instructions: 'Test.',
        model: textModel().model,
        requestContextSchema: schema,
        defaultOptions: defaults,
      }),
      resumeRequestContextKeys: ['binding'],
    });
    const prepared = await agent.prepare('Hello', { requestContext: execution });
    const currentRaw = new RequestContext([
      ['binding', '88'],
      ['fresh', '11'],
    ]);
    const current = new RequestContext([
      ['binding', 88],
      ['fresh', 11],
    ]);
    Object.defineProperty(current, REQUEST_CONTEXT_INPUT_SOURCE, { value: currentRaw });
    const restored = restoreResumeRequestContext(prepared.workflowInput, current, ['binding']);
    expect(getRequestContextInputValues(restored)).toEqual({ binding: '7', fresh: '11' });
    expect(restored.get('binding')).toBe(7);
    expect(restored.get('fresh')).toBe(11);
    const result = await schema['~standard'].validate(getRequestContextInputValues(restored));
    expect(result.issues).toBeUndefined();
    expect(current.get('binding')).toBe(88);
    expect(raw.get('binding')).toBe('7');
  });

  it('keeps missing fresh nonselected fields absent and rejects missing saved forms', () => {
    const saved = captureResumeRequestContext(context(), ['binding'])!;
    const current = new RequestContext([
      ['binding', { model: 'B' }],
      [MASTRA_AUTH_TOKEN_KEY, 'new-token'],
    ]);
    const restored = restoreRequestContext(saved.requestContextEntries, current, saved);
    expect(restored.get('binding')).toEqual({ model: 'A', price: 2 });
    expect(restored.has('user')).toBe(false);
    expect(restored.has('allowed')).toBe(false);
    expect(restored.get(MASTRA_AUTH_TOKEN_KEY)).toBe('new-token');
    expect(() => restoreResumeRequestContext({ ...saved, resumeRequestContextInputEntries: {} }, current)).toThrow();
    expect(() => restoreResumeRequestContext({ ...saved, requestContextEntries: {} }, current)).toThrow();
    expect(() => restoreResumeRequestContext({}, current, ['binding'])).toThrow();
  });

  it('keeps the prepared native instance and both selected forms with fresh nonselected scope', () => {
    const admitted = new RequestContext([['binding', null]]);
    const original = captureResumeRequestContext(admitted, ['binding'])!;
    admitted.set('binding', { model: 'A', price: 2 });
    const saved = finalizeResumeRequestContext(admitted, original);
    const restored = restoreResumeRequestContext(
      saved,
      new RequestContext([[MASTRA_AUTH_TOKEN_KEY, 'current-token']]),
      ['binding'],
    );
    const same = restoreRequestContext(saved.requestContextEntries, restored, saved);
    expect(same).toBe(restored);
    expect(same.get('binding')).toEqual({ model: 'A', price: 2 });
    expect(getRequestContextInputSource(same)?.get('binding')).toBeNull();
    expect(same.get(MASTRA_AUTH_TOKEN_KEY)).toBe('current-token');
    expect(same.has('user')).toBe(false);
    expect(same.has('allowed')).toBe(false);
  });

  it.each(['raw', 'completed', 'missing-raw', 'policy'] as const)(
    'refuses marked native view reuse after %s corruption',
    problem => {
      const saved = captureResumeRequestContext(context(), ['binding'])!;
      const restored = restoreResumeRequestContext(saved, new RequestContext(), ['binding']);
      if (problem === 'raw') getRequestContextInputSource(restored)!.set('binding', { model: 'B', price: 99 });
      if (problem === 'completed') restored.set('binding', { model: 'B', price: 99 });
      if (problem === 'missing-raw') getRequestContextInputSource(restored)!.delete('binding');
      const original = problem === 'policy' ? { ...saved, resumeRequestContextKeys: ['other'] } : saved;
      expect(() => restoreRequestContext(original.requestContextEntries, restored, original)).toThrow(
        'complete original selected request context',
      );
    },
  );

  it.each([
    'hot',
    'cold',
    'agent-policy',
    'mastra-policy',
    'agent-policy-revoked',
    'mastra-policy-revoked',
    'hot-rewrite',
    'cold-rewrite',
  ] as const)('retains original model and fresh identity through actual %s approval', async mode => {
    const observations: unknown[] = [];
    let count = 0;
    const doStream = vi.fn(async () => ({
      stream: convertArrayToReadableStream<LanguageModelV2StreamPart>([
        { type: 'stream-start', warnings: [] },
        ...(count++ === 0
          ? [
              {
                type: 'tool-call' as const,
                toolCallId: 'call',
                toolName: 'checked',
                input: '{}',
                toolCallType: 'function' as const,
              },
            ]
          : [
              { type: 'text-start' as const, id: 'text' },
              { type: 'text-delta' as const, id: 'text', delta: 'Done.' },
              { type: 'text-end' as const, id: 'text' },
            ]),
        {
          type: 'finish',
          finishReason: count === 1 ? 'tool-calls' : 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
      warnings: [],
    }));
    const model = new MockLanguageModelV2({ doStream });
    const execute = vi.fn(async (_input, { requestContext }) => {
      observations.push({
        binding: requestContext.get('binding'),
        user: requestContext.get('user'),
        allowed: requestContext.get('allowed'),
        token: requestContext.get(MASTRA_AUTH_TOKEN_KEY),
      });
      return { ok: true };
    });
    const tool = createTool({
      id: 'checked',
      description: 'Checked',
      inputSchema: z.object({}),
      requireApproval: true,
      execute,
    });
    const policy = vi.fn(({ requestContext }: { requestContext?: RequestContext }) =>
      mode.includes('revoked') && requestContext?.get('allowed') !== true
        ? { allowed: false as const, error: { code: 'current_permission_required', retryable: false } }
        : { allowed: true as const },
    );
    let rewriting = false;
    const defaults = vi.fn(({ requestContext }) => {
      expect(requestContext.get('binding')).toEqual({ model: 'A', price: 2 });
      if (rewriting) requestContext.set('binding', { model: 'B' });
      return {};
    });
    const base = new Agent({
      id: `resume-${mode}`,
      name: 'Resume',
      instructions: 'Use checked.',
      model: ({ requestContext }) => {
        expect(requestContext.get('binding')).toEqual({ model: 'A', price: 2 });
        return model;
      },
      defaultOptions: defaults,
      tools: { checked: tool },
      ...(mode.startsWith('agent-policy') ? { toolPolicy: policy } : {}),
    });
    const agent = createDurableAgent({ agent: base, resumeRequestContextKeys: ['binding'], cleanupTimeoutMs: 0 });
    const store = new InMemoryStore();
    const mastra = new Mastra({
      agents: { agent },
      storage: store,
      logger: false,
      ...(mode.startsWith('mastra-policy') ? { toolPolicy: policy } : {}),
    });
    cleanups.push(() => mastra.shutdown());
    let suspended: unknown;
    const original = context();
    const first = await agent.stream('Run checked.', {
      requestContext: original,
      onSuspended: data => {
        suspended = data;
      },
    });
    await vi.waitFor(() => expect(suspended).toMatchObject({ type: 'approval', toolCallId: 'call' }));
    await globalRunRegistry.get(first.runId)?.workflowExecution;
    expect(execute).not.toHaveBeenCalled();
    expect(doStream).toHaveBeenCalledTimes(1);
    if (mode.startsWith('cold')) first.cleanup();
    else globalRunRegistry.get(first.runId)!.requestContext!.set('binding', { model: 'tampered' });
    const fresh = new RequestContext([
      ['binding', { model: 'B', price: 999 }],
      ['user', 'new-user'],
      [MASTRA_AUTH_TOKEN_KEY, 'new-token'],
    ]);
    rewriting = mode.includes('rewrite');
    if (mode.includes('revoked') || rewriting) {
      await expect(agent.resume(first.runId, { approved: true }, { requestContext: fresh })).rejects.toThrow(
        mode.includes('revoked') ? 'Load the required skills' : 'complete original selected request context',
      );
      expect(execute).not.toHaveBeenCalled();
      expect(doStream).toHaveBeenCalledTimes(1);
      expect(
        (
          await (await store.getStore('workflows'))!.getWorkflowRunById({
            workflowName: DurableStepIds.AGENTIC_LOOP,
            runId: first.runId,
          })
        )?.snapshot,
      ).toMatchObject({ status: 'suspended' });
      first.cleanup();
      return;
    }
    const resumed = await agent.resume(first.runId, { approved: true }, { requestContext: fresh });
    for await (const _chunk of resumed.fullStream) {
      /* Drain actual completion. */
    }
    expect(observations).toEqual([
      { binding: { model: 'A', price: 2 }, user: 'new-user', allowed: undefined, token: 'new-token' },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(doStream).toHaveBeenCalledTimes(2);
    expect(fresh.get('binding')).toEqual({ model: 'B', price: 999 });
    expect(defaults.mock.calls.length).toBeGreaterThan(1);
    if (mode.includes('policy')) expect(policy.mock.calls.length).toBeGreaterThan(1);
    resumed.cleanup();
    first.cleanup();
  });

  it('propagates missing selected metadata from native tool rebuild without policy fallback', async () => {
    const base = new Agent({ id: 'rebuild', name: 'Rebuild', instructions: 'Test.', model: textModel().model });
    const mastra = new Mastra({ agents: { base }, logger: false });
    cleanups.push(() => mastra.shutdown());
    await expect(
      rebuildRunToolsFromMastra({
        mastra,
        runId: 'broken',
        agentId: base.id,
        state: {},
        resumeRequestContextKeys: ['binding'],
        requestContextEntries: { binding: { model: 'A' } },
        resumeRequestContextInputEntries: {},
      }),
    ).rejects.toThrow('complete original selected request context');
  });

  it.each(['missing-input', 'missing-execution', 'missing-policy', 'null-final', 'extra-key'] as const)(
    'rejects %s persisted selected data before resumed defaults or model',
    async problem => {
      const fixture = textModel();
      const defaults = vi.fn(() => ({}));
      const select = vi.fn(() => fixture.model);
      const base = new Agent({
        id: 'broken-snapshot',
        name: 'Broken',
        instructions: 'Test.',
        model: select,
        defaultOptions: defaults,
      });
      const agent = createDurableAgent({
        agent: base,
        resumeRequestContextKeys: ['binding'],
        resumeRequestContextSchema: z.object({ binding: z.object({ model: z.string(), price: z.number() }) }),
      });
      const store = new InMemoryStore();
      const mastra = new Mastra({ agents: { agent }, storage: store, logger: false });
      cleanups.push(() => mastra.shutdown());
      const prepared = await agent.prepare('Hello', { requestContext: context(), runId: 'saved-broken' });
      (await agent.observe('saved-broken')).cleanup();
      defaults.mockClear();
      select.mockClear();
      const workflows = (await store.getStore('workflows'))!;
      const malformed = {
        ...prepared.workflowInput,
        ...(problem === 'missing-input'
          ? { resumeRequestContextInputEntries: {} }
          : problem === 'missing-execution'
            ? { requestContextEntries: {} }
            : problem === 'missing-policy'
              ? { resumeRequestContextKeys: undefined }
              : problem === 'extra-key'
                ? {
                    resumeRequestContextKeys: ['binding', 'user'],
                    resumeRequestContextInputEntries: {
                      ...prepared.workflowInput.resumeRequestContextInputEntries,
                      user: 'old-user',
                    },
                  }
                : { requestContextEntries: { binding: null } }),
      } as DurableAgenticWorkflowInput;
      await workflows.persistWorkflowSnapshot({
        workflowName: DurableStepIds.AGENTIC_LOOP,
        runId: 'saved-broken',
        snapshot: {
          status: 'suspended',
          context: { input: malformed },
          value: {},
          activePaths: [],
          suspendedPaths: {},
          activeStepsPath: {},
          resumeLabels: {},
          serializedStepGraph: [],
          waitingPaths: {},
          timestamp: Date.now(),
        } as any,
      });
      await expect(
        agent.resume('saved-broken', { approved: true }, { requestContext: context({ model: 'B' }) }),
      ).rejects.toThrow('complete original selected request context');
      expect(defaults).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(fixture.doStream).not.toHaveBeenCalled();
      expect(
        (await workflows.getWorkflowRunById({ workflowName: DurableStepIds.AGENTIC_LOOP, runId: 'saved-broken' }))
          ?.snapshot,
      ).toMatchObject({ status: 'suspended' });
    },
  );

  it('validates only the completed execution selection, leaving original null raw admission untouched', async () => {
    const fixture = textModel();
    const schema = z.object({
      binding: z.object({ authority: z.literal('admitted'), selection: z.object({ model: z.literal('A') }) }),
    });
    const base = new Agent({
      id: 'final-domain',
      name: 'Final domain',
      instructions: 'Test.',
      model: fixture.model,
      defaultOptions: ({ requestContext }) => {
        requestContext.set('binding', { authority: 'admitted', selection: { model: 'A' } });
        return {};
      },
    });
    const agent = createDurableAgent({
      agent: base,
      resumeRequestContextKeys: ['binding'],
      resumeRequestContextSchema: schema,
    });
    const prepared = await agent.prepare('Hello', {
      requestContext: context({ authority: 'admitted', selection: null }),
    });
    expect(prepared.workflowInput.resumeRequestContextInputEntries?.binding).toEqual({
      authority: 'admitted',
      selection: null,
    });
    expect(prepared.workflowInput.requestContextEntries?.binding).toEqual({
      authority: 'admitted',
      selection: { model: 'A' },
    });
    const invalid = createDurableAgent({
      agent: new Agent({ id: 'incomplete-final', name: 'Incomplete', instructions: 'Test.', model: fixture.model }),
      resumeRequestContextKeys: ['binding'],
      resumeRequestContextSchema: schema,
    });
    await expect(
      invalid.stream('Hello', { requestContext: context({ authority: 'admitted', selection: null }) }),
    ).rejects.toThrow('complete original selected request context');
    expect(fixture.doStream).not.toHaveBeenCalled();
  });

  it('keeps completed selected execution data when a native tool validates its original input view', async () => {
    const agent = createDurableAgent({
      agent: new Agent({
        id: 'tool-final',
        name: 'Tool final',
        instructions: 'Test.',
        model: textModel().model,
        defaultOptions: ({ requestContext }) => {
          requestContext.set('binding', { selection: { model: 'A' } });
          return {};
        },
      }),
      resumeRequestContextKeys: ['binding'],
    });
    const prepared = await agent.prepare('Hello', { requestContext: context({ selection: null }) });
    const restored = restoreResumeRequestContext(prepared.workflowInput, new RequestContext([['user', 'new-user']]), [
      'binding',
    ]);
    const tool = createTool({
      id: 'current-view',
      description: 'Read the current execution view.',
      inputSchema: z.object({}),
      requestContextSchema: z.object({ user: z.string() }),
      execute: async (_input, { requestContext }) => ({
        binding: requestContext.get('binding'),
        user: requestContext.get('user'),
      }),
    });
    await expect(tool.execute!({}, { requestContext: restored })).resolves.toEqual({
      binding: { selection: { model: 'A' } },
      user: 'new-user',
    });
    expect(getRequestContextInputValues(restored).binding).toEqual({ selection: null });
  });

  it.each(['prepare', 'stream'] as const)(
    'refuses live selected drift during asynchronous final validation before %s dispatch',
    async method => {
      const fixture = textModel();
      let live: RequestContext | undefined;
      const validationViews: unknown[] = [];
      const validate = vi.fn(async (value: unknown) => {
        validationViews.push(live!.get('binding'));
        expect(value).toEqual({ binding: { model: 'A', price: 2 } });
        live!.set('binding', { model: 'B', price: 99 });
        return { value: value as Record<string, unknown> };
      });
      const schema = z
        .object({ binding: z.object({ model: z.string(), price: z.number() }) })
        .superRefine(async value => {
          await validate(value);
        });
      const agent = createDurableAgent({
        agent: new Agent({
          id: 'async-final',
          name: 'Async final',
          instructions: 'Test.',
          model: ({ requestContext }) => {
            live = requestContext;
            return fixture.model;
          },
        }),
        resumeRequestContextKeys: ['binding'],
        resumeRequestContextSchema: schema,
      });
      await expect(agent[method]('Hello', { requestContext: context() })).rejects.toThrow(
        'complete original selected request context',
      );
      expect(validate).toHaveBeenCalled();
      expect(validationViews[0]).toEqual({ model: 'A', price: 2 });
      expect(live!.get('binding')).toEqual({ model: 'B', price: 99 });
      expect(fixture.doStream).not.toHaveBeenCalled();
    },
  );

  it('a public native workflow cold rebuild preserves an ordinary model authorization failure without fallback', async () => {
    const fixture = textModel();
    let revoked = false;
    const refusal = new Error('Current owner is no longer allowed.');
    const base = new Agent({
      id: 'cold-owner',
      name: 'Cold owner',
      instructions: 'Test.',
      model: ({ requestContext }) => {
        expect(requestContext.get('binding')).toEqual({ model: 'A', price: 2 });
        if (revoked) throw refusal;
        return fixture.model;
      },
    });
    const agent = createDurableAgent({ agent: base, resumeRequestContextKeys: ['binding'] });
    const mastra = new Mastra({ agents: { agent }, storage: new InMemoryStore(), logger: false });
    cleanups.push(() => mastra.shutdown());
    const prepared = await agent.prepare('Hello', { requestContext: context(), runId: 'cold-owner-run' });
    (await agent.observe(prepared.runId)).cleanup();
    revoked = true;
    const run = await agent.getWorkflow().createRun({ runId: prepared.runId });
    const result = await run.start({
      inputData: prepared.workflowInput,
      requestContext: new RequestContext([['user', 'current-user']]),
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected the actual native failure.');
    expect(result.error).toMatchObject({ message: refusal.message });
    expect(fixture.doStream).not.toHaveBeenCalled();
    expect(globalRunRegistry.get(prepared.runId)).toBeUndefined();
  });

  it('refuses selected cold dependencies without a registered native runtime before model fallback', async () => {
    const fixture = textModel();
    const agent = createDurableAgent({
      agent: new Agent({ id: 'missing-runtime', name: 'Missing runtime', instructions: 'Test.', model: fixture.model }),
      resumeRequestContextKeys: ['binding'],
    });
    const prepared = await agent.prepare('Hello', { requestContext: context(), runId: 'missing-runtime-run' });
    (await agent.observe(prepared.runId)).cleanup();
    await expect(
      resolveRuntimeDependencies({
        agentId: agent.id,
        runId: prepared.runId,
        input: prepared.workflowInput,
        requestContext: new RequestContext([['user', 'current-user']]),
      }),
    ).rejects.toThrow('complete original selected request context');
    expect(fixture.doStream).not.toHaveBeenCalled();
    expect(globalRunRegistry.get(prepared.runId)).toBeUndefined();
  });

  it.each(['hot', 'cold', 'cold-large'] as const)(
    'keeps selected schema input and execution forms through an actual %s approval',
    async mode => {
      const large = mode === 'cold-large';
      const payload = large ? 'a'.repeat(8_100_000) : undefined;
      const completedPayload = payload?.toUpperCase();
      let calls = 0;
      const observed: unknown[] = [];
      const model = new MockLanguageModelV2({
        doStream: async () => ({
          stream: convertArrayToReadableStream<LanguageModelV2StreamPart>([
            { type: 'stream-start', warnings: [] },
            ...(calls++ === 0
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: 'schema-call',
                    toolName: 'check',
                    input: '{}',
                    toolCallType: 'function' as const,
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'text' },
                  { type: 'text-delta' as const, id: 'text', delta: 'Done.' },
                  { type: 'text-end' as const, id: 'text' },
                ]),
            {
              type: 'finish',
              finishReason: calls === 1 ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]),
          warnings: [],
        }),
      });
      const check = createTool({
        id: 'check',
        description: 'Check the selected value.',
        inputSchema: z.object({}),
        requireApproval: true,
        execute: async (_input, { requestContext }) => {
          observed.push({
            value: requestContext.get('binding'),
            fresh: requestContext.get('fresh'),
            user: requestContext.get('user'),
            ...(large ? { payload: requestContext.get('payload') } : {}),
          });
          return { ok: true };
        },
      });
      const schema = z.object({
        binding: z.string().transform(Number),
        fresh: z.string().transform(Number),
        user: z.string(),
        payload: z
          .string()
          .transform(value => value.toUpperCase())
          .optional(),
      });
      const base = new Agent({
        id: `schema-${mode}`,
        name: 'Schema',
        instructions: 'Use check.',
        requestContextSchema: schema,
        tools: { check },
        model: ({ requestContext }) => {
          expect(requestContext.get('binding')).toBe(7);
          if (large) expect(requestContext.get('payload')).toBe(completedPayload);
          return model;
        },
      });
      const agent = createDurableAgent({
        agent: base,
        resumeRequestContextKeys: large ? ['binding', 'payload'] : ['binding'],
        resumeRequestContextSchema: z.object({ binding: z.number(), payload: z.string().optional() }),
      });
      const store = new InMemoryStore();
      const mastra = new Mastra({ agents: { agent }, storage: store, logger: false });
      cleanups.push(() => mastra.shutdown());
      let suspended: unknown;
      const launch = createTool({
        id: 'launch',
        description: 'Forward a transformed context.',
        inputSchema: z.object({}),
        requestContextSchema: schema,
        execute: async (_input, { requestContext }) =>
          agent.stream('Use check.', {
            requestContext,
            onSuspended: value => {
              suspended = value;
            },
          }),
      });
      const first = await launch.execute!(
        {},
        {
          requestContext: new RequestContext([
            ['binding', '7'],
            ['fresh', '9'],
            ['user', 'old-user'],
            ...(large ? [['payload', payload] as [string, unknown]] : []),
          ]),
        },
      );
      await vi.waitFor(() => expect(suspended).toMatchObject({ type: 'approval', toolCallId: 'schema-call' }));
      await globalRunRegistry.get(first.runId)?.workflowExecution;
      const saved = (await (await store.getStore('workflows'))!.getWorkflowRunById({
        workflowName: DurableStepIds.AGENTIC_LOOP,
        runId: first.runId,
      }))!.snapshot as any;
      expect(saved.context.input.resumeRequestContextInputEntries).toEqual({
        binding: '7',
        ...(large ? { payload } : {}),
      });
      if (large) {
        expect(saved.context.input.requestContextEntries.payload).toBe(completedPayload);
        expect(JSON.stringify(saved.context.input.resumeRequestContextInputEntries).length).toBeGreaterThan(8_000_000);
        expect(JSON.stringify(saved.context.input.requestContextEntries).length).toBeGreaterThan(8_000_000);
      }
      expect(saved.context.input.requestContextEntries.binding).toBe(7);
      if (mode.startsWith('cold')) first.cleanup();
      const continueRun = createTool({
        id: 'continue',
        description: 'Forward current transformed values.',
        inputSchema: z.object({}),
        requestContextSchema: schema,
        execute: async (_input, { requestContext }) =>
          agent.resume(first.runId, { approved: true }, { requestContext }),
      });
      const resumed = await continueRun.execute!(
        {},
        {
          requestContext: new RequestContext([
            ['binding', '88'],
            ['fresh', '11'],
            ['user', 'new-user'],
            ...(large ? [['payload', 'new-caller'] as [string, unknown]] : []),
          ]),
        },
      );
      for await (const _chunk of resumed.fullStream) {
        /* Drain the actual native result. */
      }
      expect(observed).toEqual([
        { value: 7, fresh: 11, user: 'new-user', ...(large ? { payload: completedPayload } : {}) },
      ]);
      expect(calls).toBe(2);
      resumed.cleanup();
      first.cleanup();
    },
  );

  it('refuses a selected tool rebuild without its native runtime while preserving legacy fallback', async () => {
    const saved = captureResumeRequestContext(context(), ['binding'])!;
    await expect(
      rebuildRunToolsFromMastra({ ...saved, runId: 'no-runtime', agentId: 'no-runtime', state: {} }),
    ).rejects.toThrow('complete original selected request context');
    await expect(
      rebuildRunToolsFromMastra({ runId: 'legacy-no-runtime', agentId: 'legacy', state: {} }),
    ).resolves.toBeUndefined();
  });

  it('refuses saved accessors without invoking them and bounds the complete selected record', () => {
    const saved = captureResumeRequestContext(context(), ['binding'])!;
    const getter = vi.fn(() => ({ model: 'A' }));
    const requestContextEntries = Object.defineProperty({}, 'binding', { enumerable: true, get: getter });
    expect(() => restoreResumeRequestContext({ ...saved, requestContextEntries }, context(), ['binding'])).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const large = { first: 'x'.repeat(9_000_000), second: 'x'.repeat(9_000_000) };
    expect(() =>
      restoreResumeRequestContext(
        {
          resumeRequestContextKeys: ['first', 'second'],
          requestContextEntries: large,
          resumeRequestContextInputEntries: large,
        },
        undefined,
        ['first', 'second'],
      ),
    ).toThrow();
  });

  it.each(['resume', 'recover'] as const)(
    'preserves selected version-resolution refusal before %s callbacks or dispatch',
    async method => {
      const fixture = textModel();
      const defaults = vi.fn(() => ({}));
      const select = vi.fn(() => fixture.model);
      const agent = createDurableAgent({
        agent: new Agent({
          id: `version-denied-${method}`,
          name: 'Version denied',
          instructions: 'Test.',
          model: select,
          defaultOptions: defaults,
        }),
        resumeRequestContextKeys: ['binding'],
      });
      const store = new InMemoryStore();
      const mastra = new Mastra({ agents: { agent }, storage: store, logger: false });
      cleanups.push(() => mastra.shutdown());
      const prepared = await agent.prepare('Hello', { requestContext: context(), runId: `version-denied-${method}` });
      (await agent.observe(prepared.runId)).cleanup();
      defaults.mockClear();
      select.mockClear();
      const workflows = (await store.getStore('workflows'))!;
      const status = method === 'resume' ? 'suspended' : 'running';
      await workflows.persistWorkflowSnapshot({
        workflowName: DurableStepIds.AGENTIC_LOOP,
        runId: prepared.runId,
        snapshot: {
          status,
          context: { input: { ...prepared.workflowInput, agentVersionId: 'original-version' } },
          value: {},
          activePaths: [],
          suspendedPaths: {},
          activeStepsPath: {},
          resumeLabels: {},
          serializedStepGraph: [],
          waitingPaths: {},
          timestamp: Date.now(),
        } as any,
      });
      const refusal = new Error('The current caller cannot read that saved agent version.');
      const version = vi.spyOn(mastra, 'resolveVersionedAgent').mockRejectedValue(refusal);
      const result =
        method === 'resume'
          ? agent.resume(prepared.runId, { approved: true }, { requestContext: context({ model: 'B' }) })
          : agent.recover(prepared.runId);
      await expect(result).rejects.toBe(refusal);
      expect(version).toHaveBeenCalledWith(expect.anything(), { versionId: 'original-version' });
      expect(defaults).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(fixture.doStream).not.toHaveBeenCalled();
      expect(
        (await workflows.getWorkflowRunById({ workflowName: DurableStepIds.AGENTIC_LOOP, runId: prepared.runId }))
          ?.snapshot,
      ).toMatchObject({ status });
      expect(globalRunRegistry.get(prepared.runId)).toBeUndefined();
    },
  );
});
