import type { BrowserViewerEvent } from '@mastra/core/browser';
import type { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { coreAuthMiddleware } from '../auth/helpers';
import { HTTPException } from '../http-exception';
import { browserViewerCommandSchema, resolveControllerBrowser } from './agent-controller-browser';

/**
 * One connection per viewer for an existing Session browser: user input goes in order without waiting for each
 * command's answer, and events come back on the same connection. Sign-in is checked once, when it opens.
 *
 * Browsers cannot set headers on a WebSocket, and account tokens never go in a URL. The client offers two
 * subprotocols: `mastra.browser.v1` and `mastra.bearer.<token>`; the server answers with `mastra.browser.v1`.
 */
export const BROWSER_SOCKET_PROTOCOL = 'mastra.browser.v1';
export const BROWSER_SOCKET_TOKEN_PREFIX = 'mastra.bearer.';
/** Close code when the sign-in the connection was opened with has expired; the client reconnects with a new one. */
export const BROWSER_SOCKET_TOKEN_EXPIRED = 4401;
/** A frame waits while this many bytes are still queued for the viewer; only the newest waiting frame is kept. */
const MAX_BUFFERED_BYTES = 512 * 1024;
const LONGEST_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Messages the client sends. `seq` is echoed back so the client can match answers to commands. */
export type BrowserSocketClientMessage = { seq: number; command: unknown };
/** Messages the server sends besides viewer events. */
export type BrowserSocketServerMessage =
  | BrowserViewerEvent
  | { type: 'ack'; seq: number }
  | { type: 'command-error'; seq: number; message: string };

export function readBrowserSocketProtocols(header: string | null | undefined) {
  const offered = (header ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const bearer = offered.find(value => value.startsWith(BROWSER_SOCKET_TOKEN_PREFIX));
  return {
    speaksBrowserSocket: offered.includes(BROWSER_SOCKET_PROTOCOL),
    token: bearer ? bearer.slice(BROWSER_SOCKET_TOKEN_PREFIX.length) || null : null,
  };
}

/** Milliseconds until a JWT's `exp`, or undefined when the token carries none. Only called after verification. */
function tokenLifetime(token: string): number | undefined {
  try {
    const part = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 - Date.now() : undefined;
  } catch {
    return undefined;
  }
}

export interface BrowserSocketTransport {
  send(data: string): void;
  close(code: number, reason: string): void;
  /** Bytes queued for the viewer and not yet written. */
  bufferedAmount?(): number;
}

export interface OpenControllerBrowserSocketArgs {
  mastra: Mastra;
  controllerId: string;
  resourceId: string;
  sessionScope?: string;
  sessionThreadId: string;
  incarnation: string;
  /** The `Sec-WebSocket-Protocol` header of the upgrade request. */
  protocols: string | null | undefined;
  path: string;
  request: Request;
  requestContext: RequestContext;
  getHeader: (name: string) => string | undefined;
}

export type OpenedControllerBrowserSocket = {
  /** Start relaying: subscribe to the viewer and accept messages. */
  attach(transport: BrowserSocketTransport): Promise<void>;
  receive(data: string): void;
  dispose(): void;
};

/**
 * Check sign-in and ownership for a socket before it is accepted, exactly as the HTTP viewer routes do
 * (native auth provider, `authorizeUser`, `mapUserToResourceId`, then the read-only Session browser lookup).
 * Throws HTTPException (401, 403, 404) so the upgrade is refused with that status.
 */
export async function openControllerBrowserSocket(
  args: OpenControllerBrowserSocketArgs,
): Promise<OpenedControllerBrowserSocket> {
  const { mastra, protocols, requestContext } = args;
  const offered = readBrowserSocketProtocols(protocols);
  if (!offered.speaksBrowserSocket) throw new HTTPException(400, { message: 'Unsupported browser socket protocol' });
  const serverConfig = mastra.getServer?.();
  const authConfig = serverConfig?.auth;
  if (authConfig) {
    // Permission-based deployments keep using the HTTP routes, where route permissions are enforced.
    if (serverConfig?.rbac)
      throw new HTTPException(403, { message: 'Browser socket unavailable with role-based access' });
    const result = await coreAuthMiddleware({
      path: args.path,
      method: 'GET',
      getHeader: args.getHeader,
      mastra,
      authConfig,
      requestContext,
      rawRequest: args.request,
      token: offered.token,
      buildAuthorizeContext: () => undefined,
      requiresAuth: true,
    });
    if (result.action === 'error')
      throw new HTTPException(result.status as 401 | 403 | 500, { message: String(result.body.error) });
  }
  const viewer = await resolveControllerBrowser(args);
  const expiresIn = offered.token ? tokenLifetime(offered.token) : undefined;

  let transport: BrowserSocketTransport | undefined;
  let release: (() => Promise<void>) | undefined;
  let disposed = false;
  let waitingFrame: BrowserViewerEvent | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const write = (message: BrowserSocketServerMessage) => {
    if (!disposed) transport?.send(JSON.stringify(message));
  };
  const flush = () => {
    flushTimer = undefined;
    if (disposed || !waitingFrame) return;
    if ((transport?.bufferedAmount?.() ?? 0) > MAX_BUFFERED_BYTES) {
      flushTimer = setTimeout(flush, 16);
      return;
    }
    const frame = waitingFrame;
    waitingFrame = undefined;
    write(frame);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(flushTimer);
    clearTimeout(expiryTimer);
    waitingFrame = undefined;
    void release?.();
  };
  return {
    async attach(next) {
      if (disposed) return;
      transport = next;
      if (expiresIn !== undefined)
        expiryTimer = setTimeout(
          () => transport?.close(BROWSER_SOCKET_TOKEN_EXPIRED, 'Sign-in expired'),
          Math.max(0, Math.min(expiresIn, LONGEST_TOKEN_LIFETIME_MS)),
        );
      release = await viewer.subscribe(event => {
        if (disposed) return;
        if (event.type === 'frame') {
          // A newer picture replaces one still waiting for a slow connection.
          waitingFrame = event;
          if (!flushTimer) flush();
          return;
        }
        write(event);
        if (event.type === 'closed' || event.type === 'error') {
          transport?.close(event.type === 'closed' ? 1000 : 1011, event.type);
          dispose();
        }
      });
      if (disposed) await release();
    },
    receive(data) {
      if (disposed) return;
      let message: BrowserSocketClientMessage;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      const seq = Number.isSafeInteger(message?.seq) ? message.seq : -1;
      const parsed = browserViewerCommandSchema.safeParse(message?.command);
      if (!parsed.success) return write({ type: 'command-error', seq, message: 'Invalid browser command' });
      // The viewer runs commands one at a time in the order they arrive; nothing here waits for them.
      viewer.command(parsed.data, args.incarnation).then(
        () => write({ type: 'ack', seq }),
        (error: unknown) =>
          write({ type: 'command-error', seq, message: error instanceof Error ? error.message : String(error) }),
      );
    },
    dispose,
  };
}
