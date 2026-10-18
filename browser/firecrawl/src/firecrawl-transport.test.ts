import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Firecrawl } from 'firecrawl';
import { test } from 'vitest';
import { FirecrawlBrowser } from './firecrawl-browser';
import { FirecrawlSessions } from './firecrawl-sessions';
import { resolveCdpWebSocketUrl } from './resolve-cdp';

async function fixture(run: (url: string, seen: any[], mode: (value: number) => void, delay: (ms: number | null) => void) => Promise<void>) {
  const seen: any[] = [];
  let status = 502;
  let delayMs: number | null = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (delayMs === null) return;
    if (delayMs > 0) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delayMs!);
        res.once('close', () => { clearTimeout(timer); resolve(); });
      });
      if (res.destroyed) return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/sink') { res.end(JSON.stringify({ success: true, id: 'sink', cdpUrl: 'ws://127.0.0.1:1', webSocketDebuggerUrl: 'ws://127.0.0.1:1' })); return; }
    res.statusCode = status;
    if (status === 302) res.setHeader('location', '/sink');
    res.end(JSON.stringify(status === 200 ? (req.method === 'DELETE' ? { success: true } : { success: true, id: 'owned', cdpUrl: 'ws://127.0.0.1:1', webSocketDebuggerUrl: 'ws://127.0.0.1:1' }) : { success: false, error: 'inert fixture' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try { await run(`http://127.0.0.1:${address.port}`, seen, value => { status = value; }, value => { delayMs = value; }); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const bounded = { maxRetries: 1, maxRedirects: 0, timeoutMs: 1000 } as const;
const session = { ttl: 600, activityTtl: 60, streamWebView: false, profile: { name: 'owned-profile', saveChanges: true }, integration: 'inert-contract' };

for (const scope of ['shared', 'thread'] as const) {
  test(`native ${scope}: hung create honors timeout and makes one attempt`, async () => fixture(async (apiUrl, seen, mode, delay) => {
    mode(200); delay(null);
    const browser = new FirecrawlBrowser({ apiKey: 'inert', apiUrl, scope, clientOptions: { ...bounded, timeoutMs: 40 } } as any);
    browser.setCurrentThread('owned-thread');
    const started = performance.now();
    await assert.rejects(scope === 'shared' ? browser.ensureReady() : browser.getManagerForThread('owned-thread'), (error: any) => error.code === 'ETIMEDOUT');
    assert.equal(seen.length, 1);
    assert.ok(performance.now() - started < 1500);
  }));
  test(`native ${scope}: defaults preserved; configured 503 and 302 stop after one request`, async () => fixture(async (apiUrl, seen, mode) => {
    const defaultBrowser = new FirecrawlBrowser({ apiKey: 'inert', apiUrl, scope });
    defaultBrowser.setCurrentThread('owned-thread');
    await assert.rejects(scope === 'shared' ? defaultBrowser.ensureReady() : defaultBrowser.getManagerForThread('owned-thread'));
    assert.equal(seen.length, 3);
    for (const status of [503, 302]) {
      seen.length = 0; mode(status);
      const browser = new FirecrawlBrowser({ apiKey: 'inert', apiUrl, scope, clientOptions: bounded } as any);
      browser.setCurrentThread('owned-thread');
      await assert.rejects(scope === 'shared' ? browser.ensureReady() : browser.getManagerForThread('owned-thread'));
      assert.deepEqual(seen.map(x => x.path), ['/v2/browser']);
    }
  }));
  test(`native ${scope}: bounded client, admission once, canonical request identity`, async () => fixture(async (apiUrl, seen) => {
    let admissions = 0;
    const config = { apiKey: 'inert', apiUrl, scope, clientOptions: { ...bounded, apiKey: 'forbidden', apiUrl: 'http://127.0.0.1:1' }, firecrawl: structuredClone(session), sessionLifecycle: { beforeCreate: () => { admissions++; } } };
    const snapshot = JSON.stringify(config);
    const browser = new FirecrawlBrowser(config as any);
    browser.setCurrentThread('owned-thread');
    await assert.rejects(scope === 'shared' ? browser.ensureReady() : browser.getManagerForThread('owned-thread'));
    assert.equal(admissions, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authorization, 'Bearer inert');
    assert.deepEqual(seen[0].body, { ...session, origin: 'js-sdk@4.25.1' });
    assert.equal(JSON.stringify(config), snapshot);
  }));
  test(`native ${scope}: rejection by admission sends nothing`, async () => fixture(async (apiUrl, seen) => {
    const browser = new FirecrawlBrowser({ apiKey: 'inert', apiUrl, scope, sessionLifecycle: { beforeCreate: () => { throw new Error('admission refused'); } } });
    browser.setCurrentThread('owned-thread');
    await assert.rejects(scope === 'shared' ? browser.ensureReady() : browser.getManagerForThread('owned-thread'), /admission refused/);
    assert.equal(seen.length, 0);
  }));
}

test('native recovery cleanup forwards opt-in limits and rejects redirect', async () => fixture(async (apiUrl, seen, mode) => {
  await assert.rejects(FirecrawlBrowser.deleteProviderSession({ apiKey: 'inert', apiUrl, sessionId: 'owned', clientOptions: bounded } as any));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'DELETE');
  seen.length = 0; mode(302);
  await assert.rejects(FirecrawlBrowser.deleteProviderSession({ apiKey: 'inert', apiUrl, sessionId: 'owned', clientOptions: bounded } as any));
  assert.deepEqual(seen.map(x => x.path), ['/v2/browser/owned']);
}));

test('native default recovery cleanup keeps three attempts', async () => fixture(async (apiUrl, seen) => {
  await assert.rejects(FirecrawlBrowser.deleteProviderSession({ apiKey: 'inert', apiUrl, sessionId: 'owned' }));
  assert.equal(seen.length, 3);
}));

test('native recovery: hung delete honors timeout once; delayed delete succeeds', async () => fixture(async (apiUrl, seen, mode, delay) => {
  mode(200); delay(null);
  await assert.rejects(FirecrawlBrowser.deleteProviderSession({ apiKey: 'inert', apiUrl, sessionId: 'owned', clientOptions: { ...bounded, timeoutMs: 40 } } as any), (error: any) => error.code === 'ETIMEDOUT');
  assert.equal(seen.length, 1);
  seen.length = 0; delay(40);
  assert.equal((await FirecrawlBrowser.deleteProviderSession({ apiKey: 'inert', apiUrl, sessionId: 'owned', clientOptions: { ...bounded, timeoutMs: 500 } } as any)).success, true);
  assert.equal(seen.length, 1);
}));

test('native CDP discovery: default redirect follows; opt-in rejects; hung response times out', async () => fixture(async (apiUrl, seen, mode, delay) => {
  mode(302);
  assert.equal(await resolveCdpWebSocketUrl(apiUrl), 'ws://127.0.0.1:1');
  assert.deepEqual(seen.map(x => x.path), ['/json/version', '/sink']);
  seen.length = 0;
  await assert.rejects(resolveCdpWebSocketUrl(apiUrl, undefined, { timeoutMs: 500, maxRedirects: 0 }));
  assert.deepEqual(seen.map(x => x.path), ['/json/version']);
  seen.length = 0; mode(200); delay(40);
  assert.equal(await resolveCdpWebSocketUrl(apiUrl, undefined, { timeoutMs: 500, maxRedirects: 0 }), 'ws://127.0.0.1:1');
  seen.length = 0; delay(null);
  await assert.rejects(resolveCdpWebSocketUrl(apiUrl, undefined, { timeoutMs: 40, maxRedirects: 0 }), /Timeout resolving/);
  assert.deepEqual(seen.map(x => x.path), ['/json/version']);
  seen.length = 0;
  assert.equal(await resolveCdpWebSocketUrl('wss://owned.invalid/devtools', undefined, { timeoutMs: 40, maxRedirects: 0 }), 'wss://owned.invalid/devtools');
  assert.equal(seen.length, 0);
}));

test('native session lifecycle retains failed cleanup identity and retries only explicitly', async () => fixture(async (apiUrl, seen, mode) => {
  const events: string[] = [];
  const sessions = new FirecrawlSessions(new Firecrawl({ apiKey: 'inert', apiUrl, ...bounded }), {
    beforeCreate: () => { events.push('before'); }, created: () => { events.push('created'); }, deleted: () => { events.push('deleted'); },
  });
  mode(200);
  await sessions.create(session, 'owned-thread');
  assert.equal(sessions.owns('owned'), true);
  mode(503);
  await assert.rejects(sessions.close('owned'));
  assert.equal(sessions.owns('owned'), true);
  const count = seen.length;
  await assert.rejects(sessions.close('owned'));
  assert.equal(seen.length, count);
  mode(200); sessions.beginCleanup('owned');
  await sessions.close('owned');
  assert.equal(sessions.owns('owned'), false);
  assert.deepEqual(events, ['before', 'created', 'deleted']);
}));
