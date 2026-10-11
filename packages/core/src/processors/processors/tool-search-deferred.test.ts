import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';
import { RequestContext } from '../../request-context';
import { createTool } from '../../tools';
import type { DeferredTool } from '../../tools';
import type { ProcessInputStepArgs } from '../index';
import { ToolSearchProcessor } from './tool-search';

const step = (requestContext = new RequestContext(), tools = {}) =>
  ({
    requestContext,
    tools,
    messageList: { addSystem: vi.fn() },
  }) as unknown as ProcessInputStepArgs;
const executable = (id: string, owner = '') =>
  createTool({
    id,
    description: `${id} mailbox messages`,
    inputSchema: z.object({ limit: z.number().int().positive() }),
    execute: async () => owner,
  });
const metadata = (id: string, resolve = vi.fn(async () => executable(id))): DeferredTool => ({
  id,
  description: `${id} mailbox messages`,
  resolve,
});

describe('deferred tool search', () => {
  it('withholds cold history without discovery and refreshes the same step on explicit search', async () => {
    let cold = false;
    let added = false;
    const inventory = vi.fn(async () => ({
      mail: metadata('mail'),
      ...(added ? { new_mail: metadata('new_mail') } : {}),
    }));
    const deferredTools = vi.fn(async ({ reason }: { reason?: string }) =>
      reason === 'restore'
        ? cold
          ? {}
          : { mail: metadata('mail'), ...(added ? { new_mail: metadata('new_mail') } : {}) }
        : inventory(),
    );
    const processor = new ToolSearchProcessor({ tools: {}, deferredTools, restoreDeferred: 'known-only' });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    cold = true;
    added = true;
    inventory.mockClear();
    deferredTools.mockClear();
    const restored = await processor.processInputStep(args);
    expect(Object.keys(restored.tools)).toEqual(['search_tools', 'load_tool']);
    expect(inventory).not.toHaveBeenCalled();
    expect(deferredTools).toHaveBeenCalledExactlyOnceWith({
      requestContext: args.requestContext,
      reason: 'restore',
      toolNames: ['mail'],
    });
    // The native store still owns the loaded name, even though its schema was
    // unavailable at restoration. Fresh discovery can find a newly added tool.
    const found = await restored.tools.search_tools.execute!({ query: 'new_mail' }, {} as never);
    expect(found).toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ name: 'new_mail' })]) });
    await restored.tools.load_tool!.execute!({ toolName: 'new_mail' }, {} as never);
    expect(inventory).toHaveBeenCalledTimes(1);
    cold = false;
    expect(
      Object.keys(await processor.getLoadedToolsForRequestContext({ requestContext: args.requestContext })),
    ).toEqual(['mail', 'new_mail']);
  });

  it('replaces only its earlier known entries when the same step explicitly loads fresh declarations', async () => {
    let restoring = false;
    const oldResolve = vi.fn(async () => executable('mail', 'old'));
    const newResolve = vi.fn(async () => executable('mail', 'new'));
    const processor = new ToolSearchProcessor({
      tools: { local: executable('local') },
      restoreDeferred: 'known-only',
      deferredTools: async ({ reason }) => ({
        mail: metadata('mail', restoring && reason === 'restore' ? oldResolve : newResolve),
      }),
    });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolNames: ['mail', 'local'] }, {} as never);
    restoring = true;
    const restored = await processor.processInputStep(args);
    expect(restored.tools.local).toBeDefined();
    expect(oldResolve).toHaveBeenCalledTimes(1);
    await restored.tools.search_tools.execute!({ query: 'mail' }, {} as never);
    // A different loaded tool can be added without a duplicate collision or
    // replacing the request's unrelated static declaration.
    expect(restored.tools.local.id).toBe('local');
    expect(newResolve).toHaveBeenCalledTimes(1);
  });

  it('keeps native history when known-only restoration fails, but explicit loading still refuses', async () => {
    let failed = false;
    const processor = new ToolSearchProcessor({
      tools: { local: executable('local') },
      restoreDeferred: 'known-only',
      deferredTools: async () => {
        if (failed) throw Error('metadata unavailable');
        return { mail: metadata('mail') };
      },
    });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolNames: ['mail', 'local'] }, {} as never);
    failed = true;
    const restored = await processor.processInputStep(args);
    expect(restored.tools.local).toBeDefined();
    expect(restored.tools.mail).toBeUndefined();
    await expect(restored.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never)).rejects.toThrow(
      'metadata unavailable',
    );
    failed = false;
    expect(
      Object.keys(await processor.getLoadedToolsForRequestContext({ requestContext: args.requestContext })),
    ).toEqual(['mail', 'local']);
  });

  it('leaves the default supplier argument and eager restoration unchanged', async () => {
    const deferredTools = vi.fn(async () => ({ mail: metadata('mail') }));
    const processor = new ToolSearchProcessor({ tools: {}, deferredTools });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    deferredTools.mockClear();
    const restored = await processor.processInputStep(args);
    expect(restored.tools.mail).toBeDefined();
    expect(deferredTools).toHaveBeenCalledExactlyOnceWith({ requestContext: args.requestContext });
  });

  it('removes an omitted known declaration on explicit discovery and refuses its restored executor', async () => {
    let removed = false;
    const execute = vi.fn(async () => 'dispatched');
    const mail = createTool({
      id: 'mail',
      description: 'mailbox',
      inputSchema: z.object({ limit: z.number() }),
      execute,
    });
    const declaration = { id: 'mail', description: 'mailbox', binding: 'own-mail', resolve: async () => mail };
    const processor = new ToolSearchProcessor({
      tools: { local: executable('local') },
      restoreDeferred: 'known-only',
      deferredTools: async ({ reason }) => (reason === 'restore' || !removed ? { mail: declaration } : {}),
    });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolNames: ['mail', 'local'] }, {} as never);
    const restored = await processor.processInputStep(args);
    expect(restored.tools.mail).toBeDefined();
    removed = true;
    const found = await restored.tools.search_tools.execute!({ query: 'mail' }, {} as never);
    expect(found).toMatchObject({ results: [] });
    const load = await restored.tools.load_tool!.execute!({ toolNames: ['mail'] }, {} as never);
    expect(load).toMatchObject({ success: false, notFound: ['mail'] });
    await expect(restored.tools.mail.execute!({ limit: 1 }, {} as never)).rejects.toThrow('no longer authorized');
    expect(execute).not.toHaveBeenCalled();
    expect(restored.tools.local).toBeDefined();
  });

  it.each(['binding', 'schema', 'approval', 'authorization'])(
    'fresh execution still refuses changed %s',
    async change => {
      let changed = false;
      const execute = vi.fn(async () => 'sent');
      const deferredTools = vi.fn(async () => ({
        mail: {
          ...metadata('mail'),
          binding: changed && change === 'binding' ? 'new' : 'original',
          resolve: async () =>
            createTool({
              id: 'mail',
              description: 'mailbox',
              inputSchema:
                changed && change === 'schema' ? z.object({ limit: z.string() }) : z.object({ limit: z.number() }),
              requireApproval: changed && change === 'approval',
              execute,
            }),
        },
      }));
      const processor = new ToolSearchProcessor({
        tools: {},
        deferredTools,
        restoreDeferred: 'known-only',
        deferredFilter: () => !(changed && change === 'authorization'),
      });
      const args = step();
      const first = await processor.processInputStep(args);
      await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
      const active = await processor.processInputStep(args);
      changed = true;
      deferredTools.mockClear();
      await expect(active.tools.mail.execute!({ limit: 1 }, {} as never)).rejects.toThrow(
        change === 'binding'
          ? 'target changed'
          : change === 'authorization'
            ? 'no longer authorized'
            : 'contract changed',
      );
      expect(deferredTools).toHaveBeenCalledExactlyOnceWith({
        requestContext: args.requestContext,
        reason: 'execute',
        toolNames: ['mail'],
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('does not read metadata or schemas for an unloaded text response', async () => {
    const resolve = vi.fn(async () => executable('mail'));
    const deferredTools = vi.fn(async () => ({ mail: metadata('mail', resolve) }));
    const processor = new ToolSearchProcessor({ tools: {}, deferredTools });
    const result = await processor.processInputStep(step());
    expect(Object.keys(result.tools)).toEqual(['search_tools', 'load_tool']);
    expect(deferredTools).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('searches the complete catalog and resolves only the selected tool', async () => {
    const schemaReads = vi.fn(async (id: string) => executable(id));
    const deferredTools = vi.fn(async () =>
      Object.fromEntries(
        Array.from({ length: 587 }, (_, i) => {
          const id = i === 586 ? 'unique_inbox' : `action_${i}`;
          return [
            id,
            metadata(
              id,
              vi.fn(() => schemaReads(id)),
            ),
          ];
        }),
      ),
    );
    const processor = new ToolSearchProcessor({ tools: {}, deferredTools, search: { topK: 1, autoLoad: true } });
    const args = step();
    const first = await processor.processInputStep(args);
    const found = await first.tools.search_tools.execute!({ query: 'unique_inbox' }, {} as never);
    expect(found).toMatchObject({ results: [{ name: 'unique_inbox' }] });
    expect(schemaReads.mock.calls.map(([id]) => id)).toEqual(['unique_inbox']);
    const second = await processor.processInputStep(args);
    expect(Object.keys(second.tools)).toEqual(['search_tools', 'unique_inbox']);
    expect(second.tools.unique_inbox.inputSchema).toBeDefined();
  });

  it('search without auto-load reads no full schemas', async () => {
    const resolve = vi.fn(async () => executable('mail'));
    const processor = new ToolSearchProcessor({
      tools: {},
      deferredTools: async () => ({ mail: metadata('mail', resolve) }),
    });
    const first = await processor.processInputStep(step());
    await first.tools.search_tools.execute!({ query: 'mail' }, {} as never);
    expect(resolve).not.toHaveBeenCalled();
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('binds loaded and resumed tools to the current request', async () => {
    const processor = new ToolSearchProcessor({
      tools: {},
      deferredTools: async ({ requestContext }) => ({
        mail: {
          id: 'mail',
          description: 'mailbox',
          resolve: async () => executable('mail', requestContext?.get('owner')),
        },
      }),
    });
    const a = new RequestContext([['owner', 'alice']]);
    const b = new RequestContext([['owner', 'bob']]);
    const first = await processor.processInputStep(step(a));
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    const resumed = await processor.getLoadedToolsForRequestContext({ requestContext: b });
    expect(await resumed.mail.execute!({ limit: 1 }, {} as never)).toBe('bob');
  });

  it('does not claim activation when schema resolution fails', async () => {
    const processor = new ToolSearchProcessor({
      tools: {},
      deferredTools: async () => ({
        mail: {
          id: 'mail',
          description: 'mailbox',
          resolve: async () => {
            throw Error('schema unavailable');
          },
        },
      }),
    });
    const first = await processor.processInputStep(step());
    await expect(first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never)).rejects.toThrow(
      'schema unavailable',
    );
    expect(await processor.getLoadedToolsForRequestContext()).toEqual({});
  });

  it('enforces skill policy before fetching a schema and execution policy afterward', async () => {
    let allowed = false;
    const resolve = vi.fn(async () => executable('mail'));
    const processor = new ToolSearchProcessor({
      tools: {},
      deferredTools: async () => ({ mail: metadata('mail', resolve) }),
      toolPolicy: async () => (allowed ? { allowed: true } : { allowed: false, error: { message: 'load skill' } }),
    });
    const args = step();
    const first = await processor.processInputStep(args);
    expect(await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never)).toMatchObject({ success: false });
    expect(resolve).not.toHaveBeenCalled();
    allowed = true;
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    const second = await processor.processInputStep(args);
    allowed = false;
    expect(await second.tools.mail.execute!({ limit: 1 }, {} as never)).toMatchObject({ message: 'load skill' });
  });

  it('rejects reserved names and collisions without replacing existing tools', async () => {
    const processor = new ToolSearchProcessor({
      tools: { mail: executable('mail') },
      deferredTools: async () => ({ mail: metadata('mail') }),
    });
    const result = await processor.processInputStep(step());
    await expect(result.tools.search_tools.execute!({ query: 'mail' }, {} as never)).rejects.toThrow(
      'duplicate deferred tool',
    );
  });

  it('does not fetch connector metadata when only a local tool was loaded', async () => {
    const deferredTools = vi.fn(async () => ({}));
    const processor = new ToolSearchProcessor({ tools: { local: executable('local') }, deferredTools });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolName: 'local' }, {} as never);
    deferredTools.mockClear();
    const second = await processor.processInputStep(args);
    expect(second.tools.local).toBeDefined();
    expect(deferredTools).not.toHaveBeenCalled();
  });

  it('withholds a revoked previously loaded connector while a plain reply remains possible', async () => {
    let revoked = false;
    const processor = new ToolSearchProcessor({
      tools: {},
      deferredTools: async () => ({
        mail: {
          id: 'mail',
          description: 'mailbox',
          resolve: async () => {
            if (revoked) throw Error('revoked');
            return executable('mail');
          },
        },
      }),
    });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    revoked = true;
    const second = await processor.processInputStep(args);
    expect(Object.keys(second.tools)).toEqual(['search_tools', 'load_tool']);
    await expect(second.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never)).rejects.toThrow('revoked');
  });

  it('preserves the number of ordinary filter calls without deferred tools', async () => {
    const filter = vi.fn(() => true);
    const processor = new ToolSearchProcessor({ tools: { mail: executable('mail') }, filter });
    const args = step();
    const first = await processor.processInputStep(args);
    await first.tools.load_tool!.execute!({ toolName: 'mail' }, {} as never);
    expect(filter.mock.calls).toHaveLength(1);
    filter.mockClear();
    await processor.processInputStep(args);
    expect(filter.mock.calls).toHaveLength(1);
  });

  it('fills search results after denied metadata without passing metadata to the ordinary filter', async () => {
    const resolve = vi.fn(async () => executable('allowed'));
    const filter = vi.fn(({ tool }) => Boolean(tool.inputSchema && tool.execute));
    const processor = new ToolSearchProcessor({
      tools: {},
      filter,
      search: { topK: 1, autoLoad: true },
      deferredFilter: ({ toolName }) => toolName === 'allowed',
      deferredTools: async () => ({
        denied1: { ...metadata('denied1'), description: 'mailbox mailbox mailbox' },
        denied2: { ...metadata('denied2'), description: 'mailbox mailbox mailbox' },
        denied3: { ...metadata('denied3'), description: 'mailbox mailbox mailbox' },
        allowed: { ...metadata('allowed', resolve), description: 'mailbox messages archive inbox' },
      }),
    });
    const first = await processor.processInputStep(step());
    const found = await first.tools.search_tools.execute!({ query: 'mailbox' }, {} as never);
    expect(found).toMatchObject({ results: [{ name: 'allowed' }] });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(filter.mock.calls[0][0].tool.execute).toBeTypeOf('function');
  });
});
