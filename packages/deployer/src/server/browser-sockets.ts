import type { createNodeWebSocket as CreateNodeWebSocket } from '@hono/node-ws';
import type { Mastra } from '@mastra/core/mastra';
import {
  BROWSER_SOCKET_PROTOCOL,
  handleInputMessage,
  openControllerBrowserSocket,
  ViewerRegistry,
} from '@mastra/server/browser-stream';
import type { BrowserStreamConfig, BrowserStreamResult } from '@mastra/server/browser-stream';
import type { Context, Env, Hono, Schema } from 'hono';

/**
 * The server's WebSocket routes, on one `@hono/node-ws` instance (two instances on one server refuse each
 * other's upgrades):
 * - `/browser/:agentId/stream`, the agent-browser screencast Studio watches (as `@mastra/hono` setupBrowserStream);
 * - `<prefix>/agent-controller/:controllerId/sessions/:resourceId/browser/socket`, one connection per viewer of an
 *   existing Session browser: input in order without waiting, events back on the same connection.
 */
export async function setupBrowserSockets<E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  config: BrowserStreamConfig & { mastra: Mastra },
): Promise<BrowserStreamResult | null> {
  // Dynamic import keeps ws out of non-Node bundles; without it, browser sockets are simply unavailable.
  let createNodeWebSocket: typeof CreateNodeWebSocket;
  try {
    const mod = '@hono/node-ws';
    createNodeWebSocket = (await import(/* @vite-ignore */ /* webpackIgnore: true */ mod)).createNodeWebSocket;
  } catch {
    return null;
  }
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  // Answer the Session socket with its protocol, never with the offered bearer.
  const previous = wss.options.handleProtocols;
  wss.options.handleProtocols = (protocols, request) =>
    protocols.has(BROWSER_SOCKET_PROTOCOL) ? BROWSER_SOCKET_PROTOCOL : previous ? previous(protocols, request) : false;
  const registry = new ViewerRegistry();
  const rawPrefix = config.apiPrefix ?? '/api';
  const trimmed = rawPrefix.endsWith('/') ? rawPrefix.slice(0, -1) : rawPrefix;
  const apiPrefix = trimmed || '/api';

  app.get(
    '/browser/:agentId/stream',
    upgradeWebSocket(c => {
      const agentId = c.req.param('agentId')!;
      const threadId = c.req.query('threadId');
      const viewerKey = threadId ? `${agentId}:${threadId}` : agentId;
      return {
        onOpen(_event, ws) {
          ws.send(JSON.stringify({ status: 'connected' }));
          void registry.addViewer(viewerKey, ws, config.getToolset, agentId, threadId);
        },
        onMessage(event) {
          if (typeof event.data === 'string') void handleInputMessage(event.data, config.getToolset, agentId, threadId);
        },
        onClose(_event, ws) {
          void registry.removeViewer(viewerKey, ws);
        },
        onError(event, ws) {
          console.error('[BrowserStream] WebSocket error:', event);
          void registry.removeViewer(viewerKey, ws);
        },
      };
    }),
  );

  app.get(
    `${apiPrefix}/agent-controller/:controllerId/sessions/:resourceId/browser/socket`,
    async (c: Context, next) => {
      if (c.req.header('upgrade')?.toLowerCase() !== 'websocket')
        return c.json({ error: 'WebSocket upgrade required' }, 426);
      let opened: Awaited<ReturnType<typeof openControllerBrowserSocket>>;
      try {
        opened = await openControllerBrowserSocket({
          mastra: config.mastra,
          controllerId: c.req.param('controllerId')!,
          resourceId: c.req.param('resourceId')!,
          sessionScope: c.req.query('sessionScope') || undefined,
          sessionThreadId: c.req.query('sessionThreadId') ?? '',
          incarnation: c.req.query('incarnation') ?? '',
          protocols: c.req.header('sec-websocket-protocol'),
          path: c.req.path,
          request: c.req.raw,
          requestContext: c.get('requestContext'),
          getHeader: name => c.req.header(name),
        });
      } catch (error) {
        const status =
          error && typeof error === 'object' && 'status' in error ? Number((error as { status: number }).status) : 500;
        return c.json(
          { error: error instanceof Error ? error.message : 'Browser socket failed' },
          (status || 500) as 400,
        );
      }
      return upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          const raw = ws.raw as { bufferedAmount?: number } | undefined;
          opened
            .attach({
              send: data => ws.send(data),
              close: (code, reason) => ws.close(code, reason),
              bufferedAmount: () => raw?.bufferedAmount ?? 0,
            })
            .catch(() => ws.close(1011, 'Browser stream failed'));
        },
        onMessage(event) {
          if (typeof event.data === 'string') opened.receive(event.data);
        },
        onClose() {
          opened.dispose();
        },
        onError() {
          opened.dispose();
        },
      }))(c, next);
    },
  );

  app.get(`${apiPrefix}/agents/:agentId/browser/session`, async c => {
    const agentId = c.req.param('agentId');
    if (!agentId) return c.json({ error: 'Agent ID is required' }, 400);
    const threadId = c.req.query('threadId');
    const toolset = await config.getToolset(agentId);
    if (!toolset) return c.json({ hasSession: false, screencastAvailable: true });
    return c.json({ hasSession: threadId ? toolset.hasThreadSession(threadId) : false, screencastAvailable: true });
  });

  app.post(`${apiPrefix}/agents/:agentId/browser/close`, async c => {
    const agentId = c.req.param('agentId');
    if (!agentId) return c.json({ error: 'Agent ID is required' }, 400);
    const toolset = await config.getToolset(agentId);
    if (!toolset) return c.json({ error: 'No browser session for this agent' }, 404);
    try {
      let threadId: string | undefined;
      try {
        threadId = (await c.req.json())?.threadId;
      } catch {
        // No body or invalid JSON: close without a thread.
      }
      const viewerKey = threadId ? `${agentId}:${threadId}` : agentId;
      if (toolset.getScope() === 'thread' && threadId) {
        await registry.closeBrowserSession(viewerKey);
        if ('closeThreadSession' in toolset && typeof toolset.closeThreadSession === 'function')
          await toolset.closeThreadSession(threadId);
      } else {
        await registry.closeBrowserSession(viewerKey);
        await toolset.close();
      }
      return c.json({ success: true });
    } catch (error) {
      console.error(`[BrowserStream] Error closing browser for ${agentId}:`, error);
      return c.json({ error: 'Failed to close browser' }, 500);
    }
  });

  return { injectWebSocket: injectWebSocket as (server: unknown) => void, registry };
}
