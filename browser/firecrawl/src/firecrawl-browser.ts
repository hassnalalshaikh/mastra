import type { AgentBrowserConfig } from '@mastra/agent-browser';
import { AgentBrowser } from '@mastra/agent-browser';
import { resolveViewportSize, DEFAULT_BROWSER_VIEWPORT } from '@mastra/core/browser';
import type { BrowserLaunchOptions } from 'agent-browser';
import { BrowserManager } from 'agent-browser';
import { Firecrawl } from 'firecrawl';
import { deleteFirecrawlBrowserSession, FirecrawlSessions } from './firecrawl-sessions';
import { FirecrawlAgentBrowserThreadManager } from './firecrawl-thread-manager';
import { resolveCdpWebSocketUrl } from './resolve-cdp';
import type { FirecrawlBrowserConfig, FirecrawlBrowserSessionOptions } from './types';

function toBaseConfig(config: FirecrawlBrowserConfig): AgentBrowserConfig {
  const { apiKey: _a, apiUrl: _u, firecrawl: _f, sessionLifecycle: _l, createThreadManager: _m, ...rest } = config;
  return rest as AgentBrowserConfig;
}

/**
 * Native hosted browser provider with retryable remote cleanup and provider usage observations.
 * @khayalek-known-mastra-violation KV-BR-002
 */
export class FirecrawlBrowser extends AgentBrowser {
  override readonly name = 'FirecrawlBrowser';
  override readonly provider = 'firecrawl/browser-sandbox';
  declare protected sharedManager: BrowserManager | null;
  private readonly sessions: FirecrawlSessions;
  private readonly sessionOpts: FirecrawlBrowserSessionOptions;

  /** Release one recorded provider resource during native workflow recovery; never launches a browser. */
  static async deleteProviderSession({
    apiKey,
    apiUrl,
    sessionId,
  }: {
    apiKey: string;
    apiUrl?: string;
    sessionId: string;
  }) {
    if (!apiKey) throw new Error('Firecrawl provider cleanup requires an API key');
    return deleteFirecrawlBrowserSession(new Firecrawl({ apiKey, apiUrl }), sessionId);
  }

  constructor(config: FirecrawlBrowserConfig) {
    const apiKey = config.apiKey ?? process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error('FirecrawlBrowser requires `apiKey` or FIRECRAWL_API_KEY');
    const firecrawl = new Firecrawl({ apiKey, apiUrl: config.apiUrl });
    const sessions = new FirecrawlSessions(firecrawl, config.sessionLifecycle);
    const sessionOpts = config.firecrawl ?? {};
    super({
      ...toBaseConfig(config),
      createThreadManager: opts => {
        const providerOptions = {
          ...opts,
          firecrawl,
          sessions,
          resolveWebSocketUrl: (url: string) => resolveCdpWebSocketUrl(url, opts.logger),
          sessionOptions: sessionOpts,
        };
        const manager =
          config.createThreadManager?.(providerOptions) ?? new FirecrawlAgentBrowserThreadManager(providerOptions);
        if (!(manager instanceof FirecrawlAgentBrowserThreadManager)) {
          throw new Error('FirecrawlBrowser requires a Firecrawl thread manager');
        }
        return manager;
      },
    });
    this.sessions = sessions;
    this.sessionOpts = sessionOpts;
  }

  protected override isRemoteThreadBrowser(): boolean {
    return true;
  }

  protected override async doLaunch(): Promise<void> {
    if (this.threadManager.getScope() === 'thread') {
      await super.doLaunch();
      return;
    }
    this.sessions.beginCleanup();
    await this.sessions.closeAll();
    await this.prepareBrowserLaunch();
    const created = await this.sessions.create(this.sessionOpts, this.getCurrentThread());
    this.sharedManager = new BrowserManager();
    try {
      const config = this.config as AgentBrowserConfig;
      const launchOptions: BrowserLaunchOptions = {
        headless: config.headless ?? true,
        viewport: resolveViewportSize(config.viewport) ?? DEFAULT_BROWSER_VIEWPORT,
        profile: config.profile,
        executablePath: config.executablePath,
        storageState: config.storageState,
        cdpUrl: await resolveCdpWebSocketUrl(created.cdpUrl, this.logger),
      };
      await this.sharedManager.launch(launchOptions);
      await this.initializeSharedBrowser(true);
    } catch (error) {
      try {
        await this.doClose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Firecrawl connection and cleanup failed');
      }
      throw error;
    }
  }

  protected override async doClose(): Promise<void> {
    this.sessions.beginCleanup();
    let localError: unknown;
    try {
      await super.doClose();
    } catch (error) {
      localError = error;
    }
    try {
      await this.sessions.closeAll();
    } catch (error) {
      if (localError) throw new AggregateError([localError, error], 'Firecrawl cleanup failed');
      throw error;
    }
    if (localError) throw localError;
  }

  override async closeThreadSession(threadId: string): Promise<void> {
    this.sessions.beginCleanup();
    await super.closeThreadSession(threadId);
  }

  async assertCleanupSettled(): Promise<void> {
    await this.sessions.assertCleanupSettled();
  }

  ownsProviderSession(sessionId: string): boolean {
    return this.sessions.owns(sessionId);
  }
}
