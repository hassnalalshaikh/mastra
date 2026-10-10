import type { AgentBrowserSession, AgentBrowserThreadManagerConfig } from '@mastra/agent-browser';
import { AgentBrowserThreadManager } from '@mastra/agent-browser';
import { resolveViewportSize, DEFAULT_BROWSER_VIEWPORT } from '@mastra/core/browser';
import { BrowserManager } from 'agent-browser';
import type { BrowserLaunchOptions } from 'agent-browser';
import type { Firecrawl } from 'firecrawl';
import { FirecrawlSessions } from './firecrawl-sessions';
import type { FirecrawlBrowserSessionOptions } from './types';

export interface FirecrawlAgentBrowserSession extends AgentBrowserSession {
  firecrawlSessionId?: string;
}

export interface FirecrawlAgentBrowserThreadManagerConfig extends AgentBrowserThreadManagerConfig {
  firecrawl: Firecrawl;
  resolveWebSocketUrl: (url: string) => Promise<string>;
  sessionOptions?: FirecrawlBrowserSessionOptions;
  /** @internal Shared native provider ownership, including partially connected sessions. */
  sessions?: FirecrawlSessions;
}

export class FirecrawlAgentBrowserThreadManager extends AgentBrowserThreadManager {
  private readonly remoteSessions: FirecrawlSessions;
  private readonly resolveWebSocketUrl: (url: string) => Promise<string>;
  private readonly sessionOptions: FirecrawlBrowserSessionOptions;

  constructor(config: FirecrawlAgentBrowserThreadManagerConfig) {
    super(config);
    this.remoteSessions = config.sessions ?? new FirecrawlSessions(config.firecrawl);
    this.resolveWebSocketUrl = config.resolveWebSocketUrl;
    this.sessionOptions = config.sessionOptions ?? {};
  }

  protected override async createSession(threadId: string): Promise<FirecrawlAgentBrowserSession> {
    const savedState = this.getSavedBrowserState(threadId);
    const session: FirecrawlAgentBrowserSession = { threadId, createdAt: Date.now(), browserState: savedState };
    if (this.scope !== 'thread') return session;
    const created = await this.remoteSessions.create(this.sessionOptions, threadId);
    session.firecrawlSessionId = created.id;
    const manager = new BrowserManager();
    try {
      const launchOptions: BrowserLaunchOptions = {
        headless: this.browserConfig.headless ?? true,
        viewport: resolveViewportSize(this.browserConfig.viewport) ?? DEFAULT_BROWSER_VIEWPORT,
        profile: this.browserConfig.profile,
        executablePath: this.browserConfig.executablePath,
        storageState: this.browserConfig.storageState,
        cdpUrl: await this.resolveWebSocketUrl(created.cdpUrl),
      };
      await manager.launch(launchOptions);
      session.manager = manager;
      this.threadManagers.set(threadId, manager);
      if (savedState?.tabs.length) await this.restoreBrowserState(manager, savedState);
      this.onBrowserCreated?.(manager, threadId);
      return session;
    } catch (error) {
      this.threadManagers.delete(threadId);
      const cleanup = await Promise.allSettled([manager.close(), this.remoteSessions.close(created.id)]);
      const errors = cleanup.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
      if (errors.length) throw new AggregateError([error, ...errors], 'Firecrawl connection and cleanup failed');
      throw error;
    }
  }

  protected override async doDestroySession(session: FirecrawlAgentBrowserSession): Promise<void> {
    let localError: unknown;
    if (this.scope === 'thread' && session.manager) {
      try {
        await session.manager.close();
      } catch (error) {
        localError = error;
      }
      this.threadManagers.delete(session.threadId);
    }
    if (session.firecrawlSessionId) await this.remoteSessions.close(session.firecrawlSessionId);
    if (localError) throw localError;
  }

  override async destroySession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId) as FirecrawlAgentBrowserSession | undefined;
    if (session?.firecrawlSessionId) this.remoteSessions.beginCleanup(session.firecrawlSessionId);
    await super.destroySession(threadId);
  }
}
