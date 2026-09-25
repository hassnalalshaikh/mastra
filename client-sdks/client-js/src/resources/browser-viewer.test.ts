import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentControllerSession } from './agent-controller';

describe('session browser client', () => {
  it.each([
    { x: 101 },
    { y: 101 },
    { modifiers: 2 },
    { deltaY: -10 },
    { deltaX: 10 },
    { deltaY: 10000 },
    { button: 'right' as const },
  ])('keeps distinct scroll boundaries: %j', async change => {
    const requests: any[] = [];
    let unblock!: () => void;
    const firstRequest = new Promise<void>(resolve => {
      unblock = resolve;
    });
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      if (requests.length === 1) await firstRequest;
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    const viewer = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    ).browser('launch');
    const barrier = viewer.command({ type: 'text', text: 'a' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const event = { type: 'mouseWheel' as const, x: 100, y: 100, deltaX: 0, deltaY: 10 };
    const first = viewer.command({ type: 'mouse', event });
    const second = viewer.command({ type: 'mouse', event: { ...event, ...change } });
    unblock();
    await Promise.all([barrier, first, second]);
    expect(requests).toHaveLength(3);
    expect(requests[1].event).toEqual(event);
    expect(requests[2].event).toEqual({ ...event, ...change });
    viewer.dispose();
  });

  it('combines a pending scroll burst without losing distance or delaying the next click', async () => {
    const requests: any[] = [];
    const release: Array<() => void> = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      await new Promise<void>(resolve => release.push(resolve));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    const viewer = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    ).browser('launch');
    const scroll = () =>
      viewer.command({ type: 'mouse', event: { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 10 } });
    const first = scroll();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const pending = Array.from({ length: 29 }, scroll);
    const click = viewer.command({ type: 'mouse', event: { type: 'mousePressed', x: 100, y: 100, button: 'left' } });
    release[0]();
    await first;
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].event.deltaY).toBe(290);
    release[1]();
    await Promise.all(pending);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].event.type).toBe('mousePressed');
    release[2]();
    await click;
    expect(requests.slice(0, 2).reduce((sum, request) => sum + request.event.deltaY, 0)).toBe(300);
    viewer.dispose();
  });

  it('sends text typed during a request as one request, in order, around keys that stay separate', async () => {
    const requests: any[] = [];
    const release: Array<() => void> = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      await new Promise<void>(resolve => release.push(resolve));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    const viewer = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    ).browser('launch');
    const typed = [viewer.command({ type: 'text', text: 'c' })];
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    for (const text of ['o', 'f', 'f']) typed.push(viewer.command({ type: 'text', text }));
    const backspace = { type: 'keyDown' as const, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 };
    typed.push(viewer.command({ type: 'keyboard', event: backspace }));
    typed.push(viewer.command({ type: 'keyboard', event: { ...backspace, type: 'keyUp' } }));
    for (const text of ['e', 'e']) typed.push(viewer.command({ type: 'text', text }));
    for (let i = 0; i < 4; i++) {
      release[i]();
      await vi.waitFor(() => expect(requests).toHaveLength(Math.min(5, i + 2)));
    }
    release[4]();
    await Promise.all(typed);
    expect(requests).toEqual([
      { type: 'text', text: 'c' },
      { type: 'text', text: 'off' },
      { type: 'keyboard', event: backspace },
      { type: 'keyboard', event: { ...backspace, type: 'keyUp' } },
      { type: 'text', text: 'ee' },
    ]);
    viewer.dispose();
  });

  it('keeps a pending text request within the command size limit', async () => {
    const requests: any[] = [];
    const release: Array<() => void> = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      await new Promise<void>(resolve => release.push(resolve));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    const viewer = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    ).browser('launch');
    const first = viewer.command({ type: 'text', text: 'a' });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const big = 'x'.repeat(65536);
    const pasted = viewer.command({ type: 'text', text: big });
    const next = viewer.command({ type: 'text', text: 'y' });
    for (let i = 0; i < 3; i++) {
      release[i]();
      if (i < 2) await vi.waitFor(() => expect(requests).toHaveLength(i + 2));
    }
    await Promise.all([first, pasted, next]);
    expect(requests.map(request => request.text.length)).toEqual([1, 65536, 1]);
    viewer.dispose();
  });

  describe('socket', () => {
    class FakeSocket {
      static instances: FakeSocket[] = [];
      readyState = 0;
      sent: any[] = [];
      onopen?: () => void;
      onerror?: () => void;
      onclose?: (event: { code: number }) => void;
      onmessage?: (event: { data: string }) => void;
      constructor(
        public url: string,
        public protocols: string[],
      ) {
        FakeSocket.instances.push(this);
      }
      send(data: string) {
        this.sent.push(JSON.parse(data));
      }
      close = vi.fn();
      open() {
        this.readyState = 1;
        this.onopen?.();
      }
      receive(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }
    const original = (globalThis as any).WebSocket;
    beforeEach(() => {
      FakeSocket.instances = [];
      (globalThis as any).WebSocket = FakeSocket;
    });
    afterEach(() => {
      (globalThis as any).WebSocket = original;
    });
    const viewer = () =>
      new AgentControllerSession(
        { baseUrl: 'https://test.invalid', fetch: vi.fn() },
        'code',
        'user:a',
        'thread:t',
        't',
      ).browser('launch');

    it('opens the socket with the token as a subprotocol, never in the URL, and sends input without waiting', async () => {
      const events = vi.fn();
      const connecting = viewer().connect({ token: () => 'jwt.token.one', onEvent: events, onError: vi.fn() });
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      const socket = FakeSocket.instances[0]!;
      expect(socket.url).toMatch(
        /^wss:\/\/test\.invalid\/api\/agent-controller\/code\/sessions\/user%3Aa\/browser\/socket\?/,
      );
      expect(socket.url).not.toContain('jwt.token.one');
      expect(socket.protocols).toEqual(['mastra.browser.v1', 'mastra.bearer.jwt.token.one']);
      socket.open();
      const connection = await connecting;
      const first = connection.command({ type: 'text', text: 'a' });
      const second = connection.command({ type: 'keyboard', event: { type: 'keyDown', key: 'Backspace' } });
      // Both left at once, in order, before any answer.
      expect(socket.sent).toEqual([
        { seq: 1, command: { type: 'text', text: 'a' } },
        { seq: 2, command: { type: 'keyboard', event: { type: 'keyDown', key: 'Backspace' } } },
      ]);
      socket.receive({ type: 'command-error', seq: 2, message: 'Browser connection changed' });
      socket.receive({ type: 'ack', seq: 1 });
      await expect(first).resolves.toBeUndefined();
      await expect(second).rejects.toThrow('Browser connection changed');
      socket.receive({ type: 'state', state: null, incarnation: 'launch' });
      expect(events).toHaveBeenCalledWith({ type: 'state', state: null, incarnation: 'launch' });
      connection.close();
      expect(socket.close).toHaveBeenCalledWith(1000);
    });

    it('reconnects once with a fresh token when the sign-in expires, and reports other closes', async () => {
      const tokens = ['a.b.one', 'a.b.two'];
      const errors = vi.fn();
      const connecting = viewer().connect({ token: () => tokens.shift()!, onEvent: vi.fn(), onError: errors });
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      FakeSocket.instances[0]!.open();
      const connection = await connecting;
      const lost = connection.command({ type: 'text', text: 'x' });
      FakeSocket.instances[0]!.onclose?.({ code: 4401 });
      await expect(lost).rejects.toThrow('Browser socket closed');
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
      expect(FakeSocket.instances[1]!.protocols[1]).toBe('mastra.bearer.a.b.two');
      FakeSocket.instances[1]!.open();
      await vi.waitFor(() => expect(FakeSocket.instances[1]!.onmessage).toBeTypeOf('function'));
      const after = connection.command({ type: 'text', text: 'y' });
      expect(FakeSocket.instances[1]!.sent.at(-1)).toMatchObject({ command: { type: 'text', text: 'y' } });
      expect(errors).not.toHaveBeenCalled();
      FakeSocket.instances[1]!.onclose?.({ code: 1011 });
      await expect(after).rejects.toThrow('Browser socket closed');
      expect(errors).toHaveBeenCalledWith(new Error('Browser socket closed (1011)'));
    });

    it('rejects when the server refuses the socket', async () => {
      const connecting = viewer().connect({ token: () => 'bad', onEvent: vi.fn(), onError: vi.fn() });
      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      FakeSocket.instances[0]!.onclose?.({ code: 1006 });
      await expect(connecting).rejects.toThrow('Browser socket refused (1006)');
    });
  });

  it('uses auth headers and exact thread identity, parses split SSE and cancels', async () => {
    const cancel = vi.fn();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              stream = c;
            },
            cancel,
          }),
        ),
    );
    const session = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', headers: { Authorization: 'Bearer test-only' }, fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    );
    const events = vi.fn();
    const errors = vi.fn();
    const subscription = await session.browser('launch').subscribe({ onEvent: events, onError: errors });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('sessionThreadId=t');
    expect(url).toContain('incarnation=launch');
    expect(url).not.toContain('Bearer');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-only' });
    const encoder = new TextEncoder();
    stream.enqueue(encoder.encode(': heartbeat\r\n\r\ndata: {"type":"sta'));
    stream.enqueue(encoder.encode('te","state":null,"incarnation":"launch"}\r\n\r\n'));
    await vi.waitFor(() => expect(events).toHaveBeenCalledWith({ type: 'state', state: null, incarnation: 'launch' }));
    subscription.unsubscribe();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not retry non-idempotent input on failure', async () => {
    const fetch = vi.fn(async () => new Response('failed', { status: 503 }));
    const session = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    );
    await expect(session.browser('launch').command({ type: 'text', text: 'hello' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toContain('/browser/commands?');
  });

  it('requires exact thread binding', () => {
    const session = new AgentControllerSession({ baseUrl: 'https://test.invalid' }, 'code', 'user:a');
    expect(() => session.browser('launch')).toThrow('sessionThreadId');
  });

  it('coalesces pending resize events while preserving text order and completion', async () => {
    const requests: any[] = [];
    const release: Array<() => void> = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      await new Promise<void>(resolve => release.push(resolve));
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    const viewer = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    ).browser('launch');
    const first = viewer.command({ type: 'text', text: 'a' });
    const prefs = { width: 640, height: 480, deviceScaleFactor: 1, locale: 'en-US' };
    let completed = false;
    const resize1 = viewer.command({ type: 'preferences', preferences: prefs }).then(() => {
      completed = true;
    });
    const resize2 = viewer.command({ type: 'preferences', preferences: { ...prefs, width: 900 } });
    const last = viewer.command({ type: 'text', text: 'b' });
    expect(completed).toBe(false);
    await vi.waitFor(() => expect(release).toHaveLength(1));
    release[0]();
    await first;
    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(requests[1]).toMatchObject({ type: 'preferences', preferences: { width: 900 } });
    expect(completed).toBe(false);
    release[1]();
    await Promise.all([resize1, resize2]);
    await vi.waitFor(() => expect(release).toHaveLength(3));
    release[2]();
    await last;
    expect(requests.map(item => item.type)).toEqual(['text', 'preferences', 'text']);
    viewer.dispose();
  });

  it('cancels in-flight input and rejects queued input when disposed', async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      await new Promise<void>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
      return new Response('{}');
    });
    const viewer = new AgentControllerSession(
      { baseUrl: 'https://test.invalid', fetch },
      'code',
      'user:a',
      'thread:t',
      't',
    ).browser('launch');
    const first = viewer.command({ type: 'text', text: 'a' });
    const second = viewer.command({ type: 'text', text: 'b' });
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    viewer.dispose();
    expect((await settled).map(item => item.status)).toEqual(['rejected', 'rejected']);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(viewer.command({ type: 'reload' })).rejects.toThrow('disposed');
  });
});
