import { MASTRA_RESOURCE_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BROWSER_SOCKET_PROTOCOL,
  BROWSER_SOCKET_TOKEN_EXPIRED,
  openControllerBrowserSocket,
  readBrowserSocketProtocols,
} from './agent-controller-browser-socket';

const jwt = (exp: number) =>
  ['e30', btoa(JSON.stringify({ exp })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'), 'sig'].join('.');

function fixture({ auth = true, rbac = false } = {}) {
  const release = vi.fn(async () => {});
  let emit: (event: any) => void = () => {};
  const commands: Array<{ command: any; finish: (error?: Error) => void }> = [];
  const viewer = {
    subscribe: vi.fn(async (listener: typeof emit) => {
      emit = listener;
      return release;
    }),
    command: vi.fn(
      (command: any) =>
        new Promise<void>((resolve, reject) => commands.push({ command, finish: e => (e ? reject(e) : resolve()) })),
    ),
  };
  const browser = {
    isBrowserRunning: () => true,
    getActivityState: () => ({ incarnation: 'one' }),
    getViewer: () => viewer,
  };
  const session = {
    identity: { getResourceId: () => 'user:a' },
    thread: { getId: () => 'thread-a', getById: vi.fn(async () => ({ resourceId: 'user:a' })) },
    browser,
  };
  const authenticateToken = vi.fn(async (token: string) =>
    token.startsWith('good') || token.split('.').length === 3 ? { id: 'a' } : null,
  );
  const mastra = {
    getAgentController: () => ({ getSessionByResource: vi.fn(async () => session) }),
    getServer: () => ({
      ...(auth
        ? { auth: { authenticateToken, mapUserToResourceId: (user: { id: string }) => `user:${user.id}` } }
        : {}),
      ...(rbac ? { rbac: {} } : {}),
    }),
    getLogger: () => undefined,
  };
  const sent: any[] = [];
  const transport = {
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
    close: vi.fn(),
    bufferedAmount: vi.fn(() => 0),
  };
  const open = (protocols: string, overrides: Record<string, unknown> = {}) =>
    openControllerBrowserSocket({
      mastra: mastra as any,
      controllerId: 'code',
      resourceId: 'user:a',
      sessionScope: 'thread:thread-a',
      sessionThreadId: 'thread-a',
      incarnation: 'one',
      protocols,
      path: '/api/agent-controller/code/sessions/user%3Aa/browser/socket',
      request: new Request('http://test.invalid/api/agent-controller/code/sessions/user%3Aa/browser/socket'),
      requestContext: new RequestContext(),
      getHeader: () => undefined,
      ...overrides,
    });
  return { open, viewer, commands, release, transport, sent, authenticateToken, emit: (event: any) => emit(event) };
}

afterEach(() => vi.useRealTimers());

describe('session browser socket', () => {
  it('reads the protocol and the bearer from the offered subprotocols, never from the URL', () => {
    expect(readBrowserSocketProtocols(`${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.abc.def.ghi`)).toEqual({
      speaksBrowserSocket: true,
      token: 'abc.def.ghi',
    });
    expect(readBrowserSocketProtocols('chat')).toEqual({ speaksBrowserSocket: false, token: null });
  });

  it.each([
    ['no protocol', 'mastra.bearer.good', 400],
    ['no token', BROWSER_SOCKET_PROTOCOL, 401],
    ['a bad token', `${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.bad`, 401],
  ])('refuses %s before anything is watched', async (_name, protocols, status) => {
    const f = fixture();
    await expect(f.open(protocols)).rejects.toMatchObject({ status });
    expect(f.viewer.subscribe).not.toHaveBeenCalled();
  });

  it('refuses another user and role-based deployments', async () => {
    const f = fixture();
    await expect(
      f.open(`${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.good`, { resourceId: 'user:b' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(fixture({ rbac: true }).open(`${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.good`)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('checks sign-in once, then runs commands in order without waiting and answers each one', async () => {
    const f = fixture();
    const socket = await f.open(`${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.good`);
    await socket.attach(f.transport);
    socket.receive(JSON.stringify({ seq: 1, command: { type: 'text', text: 'a' } }));
    socket.receive(
      JSON.stringify({ seq: 2, command: { type: 'keyboard', event: { type: 'keyDown', key: 'Backspace' } } }),
    );
    socket.receive(JSON.stringify({ seq: 3, command: { type: 'navigate', url: 'javascript:alert(1)' } }));
    // Both valid commands reached the viewer at once, in order; nothing waited for the first answer.
    expect(f.commands.map(c => c.command.type)).toEqual(['text', 'keyboard']);
    f.commands[1]!.finish(new Error('Browser connection changed'));
    f.commands[0]!.finish();
    await vi.waitFor(() => expect(f.sent).toHaveLength(3));
    expect(f.sent).toEqual(
      expect.arrayContaining([
        { type: 'command-error', seq: 3, message: 'Invalid browser command' },
        { type: 'command-error', seq: 2, message: 'Browser connection changed' },
        { type: 'ack', seq: 1 },
      ]),
    );
    expect(f.authenticateToken).toHaveBeenCalledTimes(1);
  });

  it('keeps only the newest waiting picture while the connection is slow', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const socket = await f.open(`${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.good`);
    await socket.attach(f.transport);
    f.transport.bufferedAmount.mockReturnValue(10 * 1024 * 1024);
    for (let i = 0; i < 50; i++)
      f.emit({ type: 'frame', data: String(i), format: 'jpeg', viewport: { width: 1, height: 1 } });
    f.emit({ type: 'state', state: null, incarnation: 'one' });
    expect(f.sent.map(m => m.type)).toEqual(['state']);
    f.transport.bufferedAmount.mockReturnValue(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.sent.map(m => m.data ?? m.type)).toEqual(['state', '49']);
    socket.dispose();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('closes with the sign-in-expired code when the token expires, and ends with the browser', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const socket = await f.open(`${BROWSER_SOCKET_PROTOCOL}, mastra.bearer.${jwt(Math.floor(Date.now() / 1000) + 60)}`);
    await socket.attach(f.transport);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.transport.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.transport.close).toHaveBeenCalledWith(BROWSER_SOCKET_TOKEN_EXPIRED, 'Sign-in expired');
    f.emit({ type: 'closed' });
    expect(f.sent.at(-1)).toEqual({ type: 'closed' });
    expect(f.transport.close).toHaveBeenLastCalledWith(1000, 'closed');
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('works without a configured auth provider, like the HTTP routes', async () => {
    const f = fixture({ auth: false });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, 'user:a');
    const socket = await f.open(BROWSER_SOCKET_PROTOCOL, { requestContext });
    await socket.attach(f.transport);
    expect(f.viewer.subscribe).toHaveBeenCalledTimes(1);
  });
});
