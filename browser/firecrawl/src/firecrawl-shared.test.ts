import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemoryStore } from '@mastra/core/storage';
import { Firecrawl } from 'firecrawl';
import { chromium } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { FirecrawlBrowser } from './firecrawl-browser';
import { FirecrawlAgentBrowserThreadManager } from './firecrawl-thread-manager';
import type { FirecrawlAgentBrowserThreadManagerConfig } from './firecrawl-thread-manager';

const executable = process.env.BROWSER_TEST_EXECUTABLE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function remoteChrome() {
  const profile = await mkdtemp(path.join(tmpdir(), 'mastra-firecrawl-'));
  const child = spawn(
    executable,
    ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test Chromium did not expose CDP')), 15000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.stderr.on('data', chunk => {
        const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
    });
    const inspector = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    return {
      endpoint,
      inspector,
      async close() {
        // Closing an attached Playwright connection only disconnects it. Ask this
        // private Chromium to exit so its own children release the profile too.
        await Promise.race([
          inspector.newBrowserCDPSession().then(session => session.send('Browser.close')).catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 3000)),
        ]);
        await Promise.race([
          inspector.close().catch(() => undefined),
          new Promise<void>(resolve => setTimeout(resolve, 3000)),
        ]);
        child.kill();
        await Promise.race([
          new Promise<void>(resolve =>
            child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve()),
          ),
          new Promise<void>(resolve => setTimeout(resolve, 3000)),
        ]);
        // Delete only the private directory this fixture created under the temporary folder.
        if (
          path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) ||
          !path.basename(profile).startsWith('mastra-firecrawl-')
        ) {
          throw new Error('Test profile cleanup escaped its owned directory');
        }
        await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

describe('shared Firecrawl native browser integration', () => {
  it.skipIf(!existsSync(executable))(
    'keeps viewer preferences, trusted activity and saved tabs through close/reopen',
    async () => {
      console.info('Firecrawl fixture: starting private Chromium');
      let remote = await remoteChrome();
      const remotes = [remote];
      const server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Native browser fixture</title><label>Name<input id="name"></label>');
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
      const url = `http://127.0.0.1:${address.port}/`;
      const storage = new InMemoryStore();
      const memory = (await storage.getStore('memory'))!;
      await memory.saveThread({
        thread: { id: 'chat', resourceId: 'owner', title: 'Fixture', createdAt: new Date(), updatedAt: new Date() },
      });
      let nextId = 0;
      const create = vi.spyOn(Firecrawl.prototype, 'browser').mockImplementation(async () => {
        if (nextId > 0) {
          remote = await remoteChrome();
          remotes.push(remote);
        }
        return { success: true, id: `session-${++nextId}`, cdpUrl: remote.endpoint };
      });
      const deleted = vi.fn();
      const preparedUrls: string[] = [];
      class CheckedManager extends FirecrawlAgentBrowserThreadManager {
        override async restoreBrowserState(
          ...args: Parameters<FirecrawlAgentBrowserThreadManager['restoreBrowserState']>
        ) {
          const [manager, state, strict, preparePage] = args;
          await super.restoreBrowserState(manager, state, strict, async page => {
            preparedUrls.push(page.url());
            await preparePage?.(page);
          });
        }
      }
      const createThreadManager = vi.fn(
        (options: FirecrawlAgentBrowserThreadManagerConfig) => new CheckedManager(options),
      );
      const remove = vi
        .spyOn(Firecrawl.prototype, 'deleteBrowser')
        .mockResolvedValueOnce({ success: false, error: 'deletion unavailable' })
        .mockResolvedValue({ success: true, sessionDurationMs: 41000, creditsBilled: 2 });
      const browser = new FirecrawlBrowser({
        apiKey: 'offline-test-key',
        apiUrl: url,
        scope: 'shared',
        observeUserActivity: true,
        idleTimeoutMs: 120000,
        savedTabs: { storage, threadId: 'chat', resourceId: 'owner' },
        restoreTabsOnLaunch: true,
        firecrawl: { ttl: 600, profile: { name: 'offline-private-profile', saveChanges: true } },
        sessionLifecycle: { deleted },
        createThreadManager,
      });
      try {
        expect(createThreadManager).toHaveBeenCalledOnce();
        browser.setCurrentThread('chat');
        console.info('Firecrawl fixture: opening native hosted browser');
        await browser.configureViewer({ width: 390, height: 720, deviceScaleFactor: 1, locale: 'en-US' });
        await browser.ensureReady();
        const result = await browser.goto({ url });
        expect(result).not.toHaveProperty('error');
        const page = remote.inspector
          .contexts()[0]!
          .pages()
          .find(page => page.url() === url)!;
        expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
          width: 390,
          height: 720,
        });
        console.info('Firecrawl fixture: checking trusted input');
        const activity = browser.getActivityState();
        await page.locator('#name').pressSequentially('Native input');
        await vi.waitFor(() =>
          expect(browser.getActivityState().lastActivityAt).toBeGreaterThan(activity.lastActivityAt),
        );
        console.info('Firecrawl fixture: checking failed provider cleanup');
        await page.evaluate(() => {
          document.cookie = 'native_profile_fixture=saved; Max-Age=900; Path=/';
        });
        expect(await page.evaluate(() => document.cookie)).toContain('native_profile_fixture=saved');
        expect((await browser.getBrowserState())?.tabs.map(tab => tab.url)).toContain(url);
        await expect(browser.close()).rejects.toThrow('cleanup');
        // Local CDP disconnect must leave the provider's context and cookies
        // intact for its own saved-profile deletion path.
        expect(await page.evaluate(() => document.cookie)).toContain('native_profile_fixture=saved');
        expect((await memory.getThreadById({ threadId: 'chat' }))?.metadata?.mastra_browser_saved_tabs).toMatchObject({
          tabs: expect.arrayContaining([{ url }]),
        });
        expect(browser.getActivityState().status).toBe('error');
        expect(remove).toHaveBeenCalledOnce();
        expect(deleted).not.toHaveBeenCalled();
        await expect(browser.assertCleanupSettled()).rejects.toThrow('deletion failed');
        await browser.close();
        expect((await memory.getThreadById({ threadId: 'chat' }))?.metadata?.mastra_browser_saved_tabs).toMatchObject({
          tabs: expect.arrayContaining([{ url }]),
        });
        expect(remove).toHaveBeenCalledTimes(2);
        expect(deleted).toHaveBeenCalledOnce();
        console.info('Firecrawl fixture: reopening saved tabs');
        browser.setCurrentThread('chat');
        await browser.ensureReady();
        expect((await browser.getBrowserState())?.tabs.map(tab => tab.url)).toContain(url);
        expect(preparedUrls).toContain('about:blank');
        expect(browser.getActivityState().incarnation).not.toBe(activity.incarnation);
        expect(browser.getActivityState().idleDeadlineAt).toBeGreaterThan(Date.now());
        expect(create).toHaveBeenCalledWith({
          ttl: 600,
          profile: { name: 'offline-private-profile', saveChanges: true },
        });
        await browser.close();
      } finally {
        await browser.close().catch(() => undefined);
        create.mockRestore();
        remove.mockRestore();
        for (const instance of remotes) await instance.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
    120000,
  );
});
