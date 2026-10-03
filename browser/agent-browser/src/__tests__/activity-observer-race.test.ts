import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BrowserActivityObserver } from '../activity-observer';

// A navigation during an install destroys the target context (Chrome: "Cannot find context with
// specified id"). The observer must report it and keep going, never fail its start.
function racingContext() {
  const session = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate')
        throw new Error('Protocol error (Runtime.evaluate): Cannot find context with specified id');
      return {};
    }),
    detach: vi.fn(async () => undefined),
  });
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, frames: () => [] });
  const context = Object.assign(new EventEmitter(), {
    pages: () => [page],
    newCDPSession: vi.fn(async () => session),
  });
  return { context, session };
}

describe('browser activity observation during a page change', () => {
  it('reports a destroyed context instead of failing', async () => {
    const { context, session } = racingContext();
    const failure = vi.fn();
    const observer = new BrowserActivityObserver(context as any, vi.fn(), failure);
    await expect(observer.start()).resolves.toBeUndefined();
    expect(failure).toHaveBeenCalledTimes(1);
    session.emit('DOM.documentUpdated');
    await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(2));
    await observer.stop();
    session.emit('DOM.documentUpdated');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(failure).toHaveBeenCalledTimes(2);
  });
});
