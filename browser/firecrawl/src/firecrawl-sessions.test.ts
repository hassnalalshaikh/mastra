import type { Firecrawl } from 'firecrawl';
import { describe, expect, it, vi } from 'vitest';
import { deleteFirecrawlBrowserSession, FirecrawlSessions } from './firecrawl-sessions';

const provider = () => ({
  browser: vi.fn().mockResolvedValue({ success: true, id: 'session-1', cdpUrl: 'wss://example.com/cdp' }),
  deleteBrowser: vi.fn().mockResolvedValue({ success: true, sessionDurationMs: 41000, creditsBilled: 2 }),
});

describe('native Firecrawl provider cleanup', () => {
  it('rejects an invalid recorded identity before sending a provider deletion', async () => {
    const api = provider();
    await expect(deleteFirecrawlBrowserSession(api as unknown as Firecrawl, '../another-resource')).rejects.toThrow(
      'Invalid Firecrawl session identity',
    );
    expect(api.deleteBrowser).not.toHaveBeenCalled();
  });
  it('awaits admission before calling the paid provider', async () => {
    const api = provider();
    const sessions = new FirecrawlSessions(api as unknown as Firecrawl, {
      beforeCreate: async () => {
        throw new Error('credits unavailable');
      },
    });
    await expect(sessions.create({})).rejects.toThrow('credits unavailable');
    expect(api.browser).not.toHaveBeenCalled();
  });

  it('retains failed deletion and does not retry or admit another profile writer inside the same cleanup', async () => {
    const api = provider();
    api.deleteBrowser.mockRejectedValueOnce(new Error('network failure'));
    const sessions = new FirecrawlSessions(api as unknown as Firecrawl);
    await sessions.create({ profile: { name: 'private-chat', saveChanges: true } });
    expect(sessions.owns('session-1')).toBe(true);
    await expect(sessions.close('session-1')).rejects.toThrow('network failure');
    await expect(sessions.closeAll()).rejects.toThrow('cleanup remains incomplete');
    await expect(sessions.assertCleanupSettled()).rejects.toThrow('network failure');
    await expect(sessions.create({})).rejects.toThrow('cleanup remains incomplete');
    expect(sessions.owns('session-1')).toBe(true);
    expect(api.deleteBrowser).toHaveBeenCalledOnce();
    expect(api.browser).toHaveBeenCalledOnce();
    sessions.beginCleanup();
    await sessions.closeAll();
    expect(sessions.owns('session-1')).toBe(false);
    expect(api.deleteBrowser).toHaveBeenCalledTimes(2);
    await sessions.assertCleanupSettled();
  });

  it('replays the confirmed provider receipt after an observation failure without deleting twice', async () => {
    const api = provider();
    const deleted = vi.fn().mockRejectedValueOnce(new Error('settlement unavailable')).mockResolvedValue(undefined);
    const sessions = new FirecrawlSessions(api as unknown as Firecrawl, { deleted });
    await sessions.create({}, 'private-chat');
    await expect(sessions.close('session-1')).rejects.toThrow('settlement unavailable');
    sessions.beginCleanup();
    await sessions.closeAll();
    expect(api.deleteBrowser).toHaveBeenCalledOnce();
    expect(deleted).toHaveBeenCalledTimes(2);
    expect(deleted).toHaveBeenLastCalledWith({
      sessionId: 'session-1',
      threadId: 'private-chat',
      receipt: { success: true, sessionDurationMs: 41000, creditsBilled: 2 },
    });
  });

  it('coalesces concurrent closes and refuses success=false receipts', async () => {
    const api = provider();
    api.deleteBrowser.mockResolvedValueOnce({ success: false, error: 'still active' });
    const deleted = vi.fn();
    const sessions = new FirecrawlSessions(api as unknown as Firecrawl, { deleted });
    await sessions.create({});
    const result = await Promise.allSettled([sessions.close('session-1'), sessions.close('session-1')]);
    expect(result.map(item => item.status)).toEqual(['rejected', 'rejected']);
    expect(api.deleteBrowser).toHaveBeenCalledOnce();
    expect(deleted).not.toHaveBeenCalled();
  });

  it('retains a partially created session when creation and deletion both fail', async () => {
    const api = provider();
    api.browser.mockResolvedValueOnce({ success: false, id: 'session-1', error: 'creation failed' });
    api.deleteBrowser.mockRejectedValueOnce(new Error('deletion failed'));
    const sessions = new FirecrawlSessions(api as unknown as Firecrawl);
    await expect(sessions.create({})).rejects.toThrow('creation and cleanup failed');
    sessions.beginCleanup();
    await sessions.closeAll();
    expect(api.deleteBrowser).toHaveBeenCalledTimes(2);
  });
});
