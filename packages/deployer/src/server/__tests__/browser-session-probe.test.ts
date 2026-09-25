import { Mastra } from '@mastra/core/mastra';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('deployer browser session probe', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../browser-sockets');
  });

  it('registers a fallback /api/agents/:agentId/browser/session route that reports screencast unavailable when setupBrowserStream is unavailable', async () => {
    // Simulate `@hono/node-ws` / `ws` not being installed
    vi.doMock('../browser-sockets', () => ({ setupBrowserSockets: vi.fn().mockResolvedValue(null) }));

    const { createHonoServer } = await import('../index');
    const mastra = new Mastra({ logger: false });
    const app = await createHonoServer(mastra, { tools: {} });

    const response = await app.request('http://localhost/api/agents/some-agent/browser/session');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hasSession: false, screencastAvailable: false });
  });

  it('does not register the fallback route when setupBrowserStream succeeds (the browser sockets own the route in that case)', async () => {
    vi.doMock('../browser-sockets', () => {
      const registeredRoutes: Array<{ method: string; path: string }> = [];

      return {
        setupBrowserSockets: vi.fn().mockImplementation(async (app: any) => {
          // Mimic the real adapter: register the probe route ourselves so we can prove
          // the fallback path doesn't double-register.
          app.get('/api/agents/:agentId/browser/session', (c: any) =>
            c.json({ hasSession: false, screencastAvailable: true }),
          );
          registeredRoutes.push({ method: 'GET', path: '/api/agents/:agentId/browser/session' });
          return { injectWebSocket: () => {}, registry: {} };
        }),
      };
    });

    const { createHonoServer } = await import('../index');
    const mastra = new Mastra({ logger: false });
    const app = await createHonoServer(mastra, { tools: {} });

    const response = await app.request('http://localhost/api/agents/some-agent/browser/session');

    expect(response.status).toBe(200);
    // Comes from the mocked setupBrowserStream, proving the fallback didn't overwrite it.
    await expect(response.json()).resolves.toEqual({ hasSession: false, screencastAvailable: true });
  });

  it('skips setupBrowserStream and registers fallback when browser streaming is disabled', async () => {
    const setupBrowserStreamMock = vi.fn().mockResolvedValue({ injectWebSocket: () => {}, registry: {} });
    vi.doMock('../browser-sockets', () => ({ setupBrowserSockets: setupBrowserStreamMock }));

    const { createHonoServer } = await import('../index');
    const mastra = new Mastra({ logger: false });
    const app = await createHonoServer(mastra, { tools: {}, browserStream: false });

    expect(setupBrowserStreamMock).not.toHaveBeenCalled();

    const response = await app.request('http://localhost/api/agents/some-agent/browser/session');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hasSession: false, screencastAvailable: false });
  });

  it('serves the Session browser socket only as a WebSocket upgrade', async () => {
    const { createHonoServer } = await import('../index');
    const mastra = new Mastra({ logger: false });
    const app = await createHonoServer(mastra, { tools: {} });
    const response = await app.request(
      'http://localhost/api/agent-controller/code/sessions/user%3Aa/browser/socket?sessionThreadId=t&incarnation=one',
    );
    expect(response.status).toBe(426);
  });

  it('mounts the fallback under a custom apiPrefix and forwards it to setupBrowserStream', async () => {
    const setupBrowserStreamMock = vi.fn().mockResolvedValue(null);
    vi.doMock('../browser-sockets', () => ({ setupBrowserSockets: setupBrowserStreamMock }));

    const { createHonoServer } = await import('../index');
    const mastra = new Mastra({ logger: false, server: { apiPrefix: '/custom/v1' } });
    const app = await createHonoServer(mastra, { tools: {} });

    // setupBrowserStream is called with the same apiPrefix
    expect(setupBrowserStreamMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ apiPrefix: '/custom/v1' }),
    );

    const response = await app.request('http://localhost/custom/v1/agents/some-agent/browser/session');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ hasSession: false, screencastAvailable: false });

    // Default-prefix probe path should NOT be served by the fallback when a custom prefix is configured.
    // Other unrelated handlers may respond with non-JSON or different status; we only assert that the
    // fallback shape is not returned at the default prefix.
    const defaultResponse = await app.request('http://localhost/api/agents/some-agent/browser/session');
    const defaultBody = defaultResponse.status === 200 ? await defaultResponse.json().catch(() => null) : null;
    expect(defaultBody).not.toEqual({ hasSession: false, screencastAvailable: false });
  });
});
