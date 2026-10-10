import type { BrowserDeleteResponse, Firecrawl } from 'firecrawl';
import type { FirecrawlBrowserSessionLifecycle, FirecrawlBrowserSessionOptions } from './types';

/** Native provider cleanup shared by a live browser and persisted workflow recovery. */
export async function deleteFirecrawlBrowserSession(
  firecrawl: Firecrawl,
  sessionId: string,
): Promise<BrowserDeleteResponse> {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId)) throw new Error('Invalid Firecrawl session identity');
  const receipt = await firecrawl.deleteBrowser(sessionId);
  if (!receipt.success) throw new Error(`Firecrawl deletion failed: ${receipt.error ?? 'Unconfirmed deletion'}`);
  return receipt;
}

/**
 * Retains provider identities and deletion receipts until cleanup and its observations settle.
 * @khayalek-known-mastra-violation KV-BR-002
 */
export class FirecrawlSessions {
  private readonly sessions = new Map<
    string,
    {
      threadId?: string;
      receipt?: BrowserDeleteResponse;
      closing?: Promise<void>;
      failed?: boolean;
    }
  >();

  constructor(
    private readonly firecrawl: Firecrawl,
    private readonly lifecycle?: FirecrawlBrowserSessionLifecycle,
  ) {}

  owns(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async create(options: FirecrawlBrowserSessionOptions, threadId?: string) {
    if ([...this.sessions.values()].some(session => session.failed)) {
      throw new Error('Firecrawl cleanup remains incomplete');
    }
    await this.lifecycle?.beforeCreate?.({ threadId });
    const result = await this.firecrawl.browser(options);
    if (result.id) this.sessions.set(result.id, { threadId });
    if (!result.success || !result.id || !result.cdpUrl) {
      const error = new Error(`Firecrawl browser(): ${result.error ?? 'Invalid browser session response'}`);
      if (result.id) {
        try {
          await this.close(result.id);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Firecrawl creation and cleanup failed');
        }
      }
      throw error;
    }
    try {
      await this.lifecycle?.created?.({ sessionId: result.id, threadId });
    } catch (error) {
      try {
        await this.close(result.id);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Firecrawl observation and cleanup failed');
      }
      throw error;
    }
    return { ...result, id: result.id, cdpUrl: result.cdpUrl };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.closing) return session.closing;
    session.closing = Promise.resolve().then(async () => {
      try {
        if (!session.receipt) {
          const receipt = await deleteFirecrawlBrowserSession(this.firecrawl, sessionId);
          session.receipt = receipt;
        }
        await this.lifecycle?.deleted?.({ sessionId, threadId: session.threadId, receipt: session.receipt });
        this.sessions.delete(sessionId);
      } catch (error) {
        session.failed = true;
        throw error;
      }
    });
    return session.closing;
  }

  /** Begin an explicit native cleanup attempt; nested cleanup shares the same failed promise. */
  beginCleanup(sessionId?: string): void {
    for (const [id, session] of this.sessions) {
      if (session.failed && (!sessionId || sessionId === id)) {
        session.closing = undefined;
        session.failed = false;
      }
    }
  }

  async assertCleanupSettled(): Promise<void> {
    const pending = [...this.sessions.values()].flatMap(session => (session.closing ? [session.closing] : []));
    await Promise.all(pending);
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)));
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, 'Firecrawl cleanup remains incomplete');
  }
}
