import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastraClient } from '../client';

describe('edited conversation client command', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends one exact-thread command and leaves the source handle unchanged', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: 'edited' })));
    vi.stubGlobal('fetch', fetch);
    const client = new MastraClient({ baseUrl: 'http://localhost:4111' });
    const source = client.getAgentController('chat').session('owner', 'source-scope', { threadId: 'source' });
    const input = {
      messageId: 'message/1',
      content: 'Corrected',
      newThreadId: 'edited',
      newSessionScope: 'edited-scope',
    };
    expect(await source.editMessage(input)).toEqual({ id: 'edited' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('/threads/source/messages/message%2F1/edit');
    expect(url).toContain('sessionThreadId=source');
    expect(JSON.parse(init.body)).toEqual({
      content: 'Corrected',
      newThreadId: 'edited',
      newSessionScope: 'edited-scope',
    });
    await source.state();
    expect(fetch.mock.calls[1][0]).toContain('sessionThreadId=source');
  });
  it('rejects unbound session handles before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const session = new MastraClient({ baseUrl: 'http://localhost:4111' }).getAgentController('chat').session('owner');
    await expect(
      session.editMessage({ messageId: 'm', content: 'x', newThreadId: 'new', newSessionScope: 'new' }),
    ).rejects.toThrow('exact source thread');
    expect(fetch).not.toHaveBeenCalled();
  });
});
