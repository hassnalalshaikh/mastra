import type { BrowserViewerCommand, BrowserViewerEvent } from '@mastra/core/browser';
import type { ClientOptions } from '../types';
import { BaseResource } from './base';

/** The Session browser socket protocol (see `@mastra/server/browser-stream`). */
const BROWSER_SOCKET_PROTOCOL = 'mastra.browser.v1';
const BROWSER_SOCKET_TOKEN_PREFIX = 'mastra.bearer.';
const BROWSER_SOCKET_TOKEN_EXPIRED = 4401;

/** Authenticated viewer for an existing exact Controller Session browser launch. */
export class SessionBrowserViewer extends BaseResource {
  private commands: Array<{
    command: BrowserViewerCommand;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private sending = false;
  private disposed = false;
  private commandAbort = new AbortController();
  constructor(
    options: ClientOptions,
    private path: string,
  ) {
    // Input commands must never be retried: a lost response may have applied the action.
    super({ ...options, retries: 0 });
  }

  async command(command: BrowserViewerCommand): Promise<void> {
    if (this.disposed) throw new Error('Browser viewer disposed');
    const last = this.commands.at(-1);
    if (
      last?.command.type === 'mouse' &&
      last.command.event.type === 'mouseWheel' &&
      command.type === 'mouse' &&
      command.event.type === 'mouseWheel'
    ) {
      const previous = last.command.event;
      const next = command.event;
      const deltaX = (previous.deltaX ?? 0) + (next.deltaX ?? 0);
      const deltaY = (previous.deltaY ?? 0) + (next.deltaY ?? 0);
      // One pending gesture can carry the same total distance in one request.
      // Keep target, modifier, direction and every intervening command boundary.
      if (
        previous.x === next.x &&
        previous.y === next.y &&
        (previous.modifiers ?? 0) === (next.modifiers ?? 0) &&
        previous.button === next.button &&
        previous.clickCount === next.clickCount &&
        Math.sign(previous.deltaX ?? 0) === Math.sign(next.deltaX ?? 0) &&
        Math.sign(previous.deltaY ?? 0) === Math.sign(next.deltaY ?? 0) &&
        Number.isFinite(deltaX) &&
        Number.isFinite(deltaY) &&
        Math.abs(deltaX) <= 10000 &&
        Math.abs(deltaY) <= 10000
      ) {
        last.command = { type: 'mouse', event: { ...next, deltaX, deltaY } };
        return last.promise;
      }
    }
    if (
      last?.command.type === 'text' &&
      command.type === 'text' &&
      last.command.text.length + command.text.length <= 65536
    ) {
      // Typing while the previous request is in flight: inserting "ab" once is inserting "a" then "b".
      // One request per round trip instead of one per key, so a burst no longer queues behind itself.
      last.command = { type: 'text', text: last.command.text + command.text };
      return last.promise;
    }
    const replaceable = (value: BrowserViewerCommand) =>
      value.type === 'preferences' || (value.type === 'mouse' && value.event.type === 'mouseMoved');
    if (last && replaceable(last.command) && replaceable(command) && last.command.type === command.type) {
      // Intermediate pointer positions and resize observations are obsolete.
      // Never coalesce clicks, keys or navigation.
      last.command = command;
      return last.promise;
    }
    if (this.commands.length >= 128) throw new Error('Browser input queue is full');
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.commands.push({ command, promise, resolve, reject });
    void this.sendCommands();
    return promise;
  }

  private async sendCommands() {
    if (this.sending) return;
    this.sending = true;
    const resource = new BaseResource({ ...this.options, abortSignal: this.commandAbort.signal });
    try {
      while (this.commands.length) {
        const next = this.commands.shift()!;
        try {
          if (this.disposed) throw new Error('Browser viewer disposed');
          await resource.request(this.path.replace('/browser/stream?', '/browser/commands?'), {
            method: 'POST',
            body: next.command,
          });
          next.resolve();
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  /**
   * One WebSocket for this viewer's input and events. Commands are sent at once, in order, without waiting for the
   * previous answer; the server checks sign-in once when the socket opens. The token travels as a WebSocket
   * subprotocol, never in the URL. When the server closes the socket because the sign-in expired, it reconnects
   * once with a fresh token.
   */
  async connect(options: {
    token: () => string | Promise<string>;
    onEvent: (event: BrowserViewerEvent) => void;
    onError: (error: Error) => void;
    signal?: AbortSignal;
  }): Promise<{ command(command: BrowserViewerCommand): Promise<void>; close(): void }> {
    const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Socket) throw new Error('WebSocket is not available');
    const base = String(this.options.baseUrl).replace(/\/$/, '').replace(/^http/, 'ws');
    const url = `${base}${this.apiPrefix}${this.path.replace('/browser/stream?', '/browser/socket?')}`;
    const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    let seq = 0;
    let socket: WebSocket | undefined;
    let closed = false;
    const failPending = (error: Error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      options.signal?.removeEventListener('abort', close);
      failPending(new Error('Browser socket closed'));
      socket?.close(1000);
    };
    const open = async (): Promise<void> => {
      const token = await options.token();
      const next = new Socket(url, [BROWSER_SOCKET_PROTOCOL, `${BROWSER_SOCKET_TOKEN_PREFIX}${token}`]);
      socket = next;
      await new Promise<void>((resolve, reject) => {
        next.onopen = () => resolve();
        next.onerror = () => reject(new Error('Browser socket failed to open'));
        next.onclose = event => reject(new Error(`Browser socket refused (${event.code})`));
      });
      next.onmessage = message => {
        if (typeof message.data !== 'string') return;
        let event: BrowserViewerEvent | { type: 'ack' | 'command-error'; seq: number; message?: string };
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (event.type === 'ack' || event.type === 'command-error') {
          const entry = pending.get(event.seq);
          pending.delete(event.seq);
          if (event.type === 'ack') entry?.resolve();
          else entry?.reject(new Error(event.message ?? 'Browser command failed'));
          return;
        }
        const viewerEvent = event as BrowserViewerEvent;
        options.onEvent(viewerEvent);
        if (viewerEvent.type === 'closed') close();
      };
      next.onerror = () => {};
      next.onclose = event => {
        if (closed || socket !== next) return;
        failPending(new Error('Browser socket closed'));
        if (event.code === BROWSER_SOCKET_TOKEN_EXPIRED) {
          // A fresh sign-in keeps the same view; anything else is the viewer's error to handle.
          open().catch(error => {
            if (!closed) {
              closed = true;
              options.onError(error instanceof Error ? error : new Error(String(error)));
            }
          });
          return;
        }
        closed = true;
        options.onError(new Error(`Browser socket closed (${event.code})`));
      };
    };
    if (options.signal?.aborted) throw new Error('Browser socket aborted');
    options.signal?.addEventListener('abort', close, { once: true });
    this.commandAbort.signal.addEventListener('abort', close, { once: true });
    await open();
    return {
      command: command => {
        if (closed || !socket || socket.readyState !== 1) return Promise.reject(new Error('Browser socket closed'));
        if (pending.size >= 512) return Promise.reject(new Error('Browser input queue is full'));
        const id = ++seq;
        const answer = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
        socket.send(JSON.stringify({ seq: id, command }));
        return answer;
      },
      close,
    };
  }

  /** Stop this handle's pending input; does not close the remote browser. */
  dispose() {
    this.disposed = true;
    this.commandAbort.abort();
  }

  /** No implicit reconnect or browser launch. The caller retains explicit cancellation. */
  async subscribe(options: {
    onEvent: (event: BrowserViewerEvent) => void;
    onError: (error: Error) => void;
    signal?: AbortSignal;
  }): Promise<{ unsubscribe: () => void }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.options.abortSignal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      this.options.abortSignal?.removeEventListener('abort', abort);
    };
    if (options.signal?.aborted || this.options.abortSignal?.aborted) abort();
    const resource = new BaseResource({ ...this.options, abortSignal: controller.signal });
    let response: Response;
    try {
      response = await resource.request<Response>(this.path, { stream: true });
      if (!response.body) throw new Error('Browser stream has no body');
    } catch (error) {
      cleanup();
      throw error;
    }
    const reader = response.body!.getReader();
    const unsubscribe = () => {
      abort();
      void reader.cancel().catch(() => {});
      cleanup();
    };
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) {
            if (!controller.signal.aborted) throw new Error('Browser stream ended');
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 32 * 1024 * 1024) throw new Error('Browser frame exceeds stream limit');
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = block
              .split(/\r?\n/)
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const event = JSON.parse(data) as BrowserViewerEvent;
            if (event.type === 'error') {
              options.onError(new Error(event.message));
              unsubscribe();
              return;
            }
            options.onEvent(event);
            if (event.type === 'closed') {
              unsubscribe();
              return;
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) options.onError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        unsubscribe();
        reader.releaseLock();
      }
    })();
    return { unsubscribe };
  }
}
