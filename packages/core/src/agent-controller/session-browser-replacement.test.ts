import { describe, expect, it, vi } from 'vitest';
import type { MastraBrowser } from '../browser';
import { createTestController } from './test-utils';

const browser = () => {
  const close = vi.fn().mockResolvedValue(undefined);
  return {
    close,
    retire: vi.fn(() => close()),
    getActivityState: () => ({ activeOperations: 0 }),
  } as unknown as MastraBrowser;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('owned Session browser replacement', () => {
  it('closes the previous provider and transfers deletion ownership without changing the chat', async () => {
    const first = browser();
    const second = browser();
    const controller = createTestController({ browser: async () => first });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'user', scope: 'chat', threadId: 'chat' });
    const id = session.identity.getId();
    const subscription = session.stream;
    await expect(controller.replaceSessionBrowser(session, { browser: async () => second })).resolves.toBe(second);
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.retire).toHaveBeenCalledOnce();
    expect(session.browser).toBe(second);
    expect(session.identity.getId()).toBe(id);
    expect(session.thread.getId()).toBe('chat');
    expect(session.stream).toBe(subscription);
    expect(await controller.getSessionByResource('user', 'chat')).toBe(session);
    await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
  });

  it('keeps the old owner and does not create the next provider when closing fails', async () => {
    const first = browser();
    vi.mocked(first.close).mockRejectedValueOnce(new Error('provider deletion failed'));
    const factory = vi.fn(async () => browser());
    const controller = createTestController({ browser: async () => first });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'user', scope: 'chat' });
    await expect(controller.replaceSessionBrowser(session, { browser: factory })).rejects.toThrow(
      'provider deletion failed',
    );
    expect(session.browser).toBe(first);
    expect(factory).not.toHaveBeenCalled();
    await controller.replaceSessionBrowser(session, { browser: factory });
    expect(first.close).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
    await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
  });

  it('rejects simultaneous replacement and message startup while provider closure is pending', async () => {
    const first = browser();
    const closing = deferred();
    const started = deferred();
    vi.mocked(first.close).mockImplementationOnce(() => {
      started.resolve();
      return closing.promise;
    });
    const controller = createTestController({ browser: async () => first });
    await controller.init();
    const session = await controller.createSession({ resourceId: 'user', scope: 'chat' });
    const replacement = controller.replaceSessionBrowser(session, { browser: async () => browser() });
    await started.promise;
    await expect(controller.replaceSessionBrowser(session)).rejects.toThrow('in progress');
    await expect(session.sendMessage({ content: 'Start browsing' })).rejects.toThrow('browser replacement');
    await expect(session.queueMessage({ content: 'Queue browsing' })).rejects.toThrow('browser replacement');
    closing.resolve();
    await replacement;
    await controller.deleteSession({ resourceId: 'user', scope: 'chat' });
  });

  it('rejects active runs and preserves unrelated user/chat browsers', async () => {
    const controller = createTestController({ browser: async () => browser() });
    await controller.init();
    const first = await controller.createSession({ resourceId: 'user-a', scope: 'chat-a' });
    const other = await controller.createSession({ resourceId: 'user-b', scope: 'chat-b' });
    const otherBrowser = other.browser;
    const running = vi.spyOn(first.run, 'isRunning').mockReturnValue(true);
    await expect(controller.replaceSessionBrowser(first)).rejects.toThrow('active Session');
    expect(first.browser!.close).not.toHaveBeenCalled();
    running.mockRestore();
    await controller.replaceSessionBrowser(first);
    expect(other.browser).toBe(otherBrowser);
    expect(otherBrowser!.close).not.toHaveBeenCalled();
    await controller.deleteSession({ resourceId: 'user-a', scope: 'chat-a' });
    await controller.deleteSession({ resourceId: 'user-b', scope: 'chat-b' });
  });
});
