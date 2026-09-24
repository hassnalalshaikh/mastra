import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { BrowserAgentAction, MastraBrowser } from './browser';
import { BrowserViewer } from './viewer';

function fixture() {
  const agent: { act?: (action: BrowserAgentAction) => void; detach: () => void } = { detach: vi.fn() };
  const stream = Object.assign(new EventEmitter(), {
    stop: vi.fn(async () => {}),
    reconnect: vi.fn(async () => {}),
    markInteractive: vi.fn(),
  });
  const browser = {
    startScreencastIfBrowserActive: vi.fn(async () => stream),
    getBrowserState: vi.fn(async () => ({ tabs: [{ url: 'about:blank' }], activeTabIndex: 0 })),
    getActivityState: vi.fn(() => ({ incarnation: 'launch-one' })),
    getScreencastFormat: () => 'png',
    getViewerViewport: () => undefined,
    onBrowserClosed: vi.fn(() => vi.fn()),
    onAgentAction: vi.fn((listener: (action: BrowserAgentAction) => void) => {
      agent.act = listener;
      return agent.detach;
    }),
    isBrowserRunning: vi.fn(() => true),
    executeViewerCommand: vi.fn(async () => {}),
  };
  return { stream, browser, agent, viewer: new BrowserViewer(browser as unknown as MastraBrowser, 'thread-one') };
}

describe('native shared browser viewer', () => {
  it('shares one capture and stops it only after the last viewer disconnects', async () => {
    const { stream, browser, viewer } = fixture();
    const first = vi.fn();
    const second = vi.fn();
    const [releaseFirst, releaseSecond] = await Promise.all([viewer.subscribe(first), viewer.subscribe(second)]);
    expect(browser.startScreencastIfBrowserActive).toHaveBeenCalledTimes(1);
    stream.emit('frame', { data: 'frame', viewport: { width: 640, height: 800 } });
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: 'frame', format: 'png' }));
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: 'frame' }));
    await releaseFirst();
    await releaseFirst();
    expect(stream.stop).not.toHaveBeenCalled();
    await releaseSecond();
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it('fails without launching when no browser is active', async () => {
    const { browser, viewer } = fixture();
    browser.startScreencastIfBrowserActive.mockResolvedValueOnce(null as never);
    await expect(viewer.subscribe(vi.fn())).rejects.toThrow('not running');
    expect(browser.executeViewerCommand).not.toHaveBeenCalled();
  });

  it('marks user input as interactive, but not size or language preferences', async () => {
    const { stream, viewer } = fixture();
    const release = await viewer.subscribe(vi.fn());
    await viewer.command(
      { type: 'preferences', preferences: { width: 800, height: 600, deviceScaleFactor: 2, locale: 'en' } },
      'launch-one',
    );
    expect(stream.markInteractive).not.toHaveBeenCalled();
    await viewer.command({ type: 'mouse', event: { type: 'mouseWheel', x: 1, y: 1, deltaY: 100 } }, 'launch-one');
    expect(stream.markInteractive).toHaveBeenCalledTimes(1);
    await release();
  });

  it('rejects commands queued for an old launch and preserves order', async () => {
    const { browser, viewer } = fixture();
    let finish!: () => void;
    browser.executeViewerCommand.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const first = viewer.command({ type: 'text', text: 'a' }, 'launch-one');
    const second = viewer.command({ type: 'text', text: 'b' }, 'launch-one');
    await vi.waitFor(() => expect(browser.executeViewerCommand).toHaveBeenCalledTimes(1));
    browser.getActivityState.mockReturnValue({ incarnation: 'launch-two' });
    finish();
    await first;
    await expect(second).rejects.toThrow('connection changed');
    expect(browser.executeViewerCommand).toHaveBeenCalledTimes(1);
  });
  it('shows each agent action on the current picture and keeps it on later frames', async () => {
    const { stream, browser, agent, viewer } = fixture();
    const listener = vi.fn();
    const release = await viewer.subscribe(listener);
    expect(browser.onAgentAction).toHaveBeenCalledWith(expect.any(Function), 'thread-one');
    stream.emit('frame', { data: 'before', viewport: { width: 640, height: 800 } });
    const action: BrowserAgentAction = { seq: 1, kind: 'click', box: { x: 10, y: 20, width: 100, height: 30 } };
    agent.act!(action);
    // The last picture is republished at once with the action, so the cursor never waits for the page.
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'frame', data: 'before', agentAction: action }),
    );
    // A viewer that drops obsolete frames still receives the latest action on the next one.
    stream.emit('frame', { data: 'after', viewport: { width: 640, height: 800 } });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ data: 'after', agentAction: action }));
    await release();
    expect(agent.detach).toHaveBeenCalledTimes(1);
  });

  it('adds no action to frames until the agent acts', async () => {
    const { stream, viewer } = fixture();
    const listener = vi.fn();
    const release = await viewer.subscribe(listener);
    stream.emit('frame', { data: 'frame', viewport: { width: 640, height: 800 } });
    expect(listener.mock.lastCall?.[0]).not.toHaveProperty('agentAction');
    await release();
  });
});
