import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScreencastStream } from './screencast-stream';
import { SCREENCAST_DEFAULTS } from './types';
import type { CdpSessionLike, CdpSessionProvider, ScreencastFrameData } from './types';

/**
 * Creates a mock CDP session for testing.
 */
function createMockCdpSession(overrides?: Partial<CdpSessionLike>): CdpSessionLike {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
}

/**
 * Creates a mock CDP session provider for testing.
 */
function createMockProvider(overrides?: {
  cdpSession?: Partial<CdpSessionLike>;
  isBrowserRunning?: boolean;
}): CdpSessionProvider {
  const mockSession = createMockCdpSession(overrides?.cdpSession);
  return {
    getCdpSession: vi.fn().mockResolvedValue(mockSession),
    isBrowserRunning: vi.fn().mockReturnValue(overrides?.isBrowserRunning ?? true),
  };
}

describe('ScreencastStream', () => {
  it('bounds high-density capture and drops an in-flight frame after stop', async () => {
    let receive!: (frame: any) => void;
    const finish: Array<(value: string) => void> = [];
    const session = createMockCdpSession({
      on: vi.fn((_event, handler) => {
        receive = handler;
      }),
      detach: vi.fn(async () => {}),
    });
    const capture = new ScreencastStream(
      {
        getCdpSession: async () => session,
        isBrowserRunning: () => true,
        captureFrame: async () => new Promise(resolve => finish.push(resolve)),
      },
      { maxWidth: 1600, maxHeight: 1200, format: 'png' },
    );
    const frames = vi.fn();
    capture.on('frame', frames);
    await capture.start();
    for (let id = 0; id < 10; id++)
      receive({ data: `low-${id}`, sessionId: id, metadata: { deviceWidth: 800, deviceHeight: 600 } });
    expect(finish).toHaveLength(1);
    finish[0]('sharp');
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    expect(frames).toHaveBeenCalledTimes(1);
    expect(frames.mock.calls[0][0]).toMatchObject({ data: 'sharp', viewport: { width: 800, height: 600 } });
    await capture.stop();
    finish[1]('late');
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveBeenCalledTimes(1);
  });
  describe('live then sharp', () => {
    function sharpFixture() {
      let receive!: (frame: any) => void;
      const finish: Array<(value: string) => void> = [];
      const session = createMockCdpSession({
        on: vi.fn((_event, handler) => {
          receive = handler;
        }),
        detach: vi.fn(async () => {}),
      });
      const stream = new ScreencastStream({
        getCdpSession: async () => session,
        isBrowserRunning: () => true,
        captureFrame: async () => new Promise(resolve => finish.push(resolve)),
      });
      const frames = vi.fn();
      stream.on('frame', frames);
      const frame = (data: string, sessionId: number) =>
        receive({ data, sessionId, metadata: { deviceWidth: 800, deviceHeight: 600 } });
      const acked = (sessionId: number) =>
        vi
          .mocked(session.send)
          .mock.calls.some(
            ([method, params]) => method === 'Page.screencastFrameAck' && params?.sessionId === sessionId,
          );
      return { stream, finish, frames, frame, acked };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not capture again for the echo of its own capture', async () => {
      const { stream, finish, frames, frame, acked } = sharpFixture();
      await stream.start();
      frame('page', 1);
      finish[0]('sharp');
      await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(1));
      frame('page', 2);
      frame('page', 3);
      expect(finish).toHaveLength(1);
      expect(frames).toHaveBeenCalledTimes(1);
      expect(acked(2) && acked(3)).toBe(true);
      await stream.stop();
    });

    it('stops capturing when a still page answers each capture with a slightly different live picture', async () => {
      const { stream, finish, frames, frame } = sharpFixture();
      await stream.start();
      frame('view-a', 1);
      finish[0]('sharp');
      await vi.waitFor(() => expect(frames).toHaveBeenCalledTimes(1));
      frame('view-b', 2);
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(finish).toHaveLength(2);
      finish[1]('sharp');
      await new Promise(resolve => setTimeout(resolve, 0));
      frame('view-a', 3);
      frame('view-b', 4);
      expect(finish).toHaveLength(2);
      expect(frames).toHaveBeenCalledTimes(1);
      frame('view-c', 5);
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(finish).toHaveLength(3);
      finish[2]('changed');
      await vi.waitFor(() => expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['sharp', 'changed']));
      await stream.stop();
    });

    it('lets user input skip the capture in progress and forwards the waiting picture live', async () => {
      const { stream, finish, frames, frame, acked } = sharpFixture();
      await stream.start();
      frame('animation-1', 1);
      frame('animation-2', 2);
      expect(finish).toHaveLength(1);
      expect(acked(1) || acked(2)).toBe(false);
      stream.markInteractive();
      expect(acked(1) && acked(2)).toBe(true);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['animation-2']);
      finish[0]('stale');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['animation-2']);
      await stream.stop();
    });

    it('paces sharp pictures of a page that keeps changing while nobody touches it', async () => {
      vi.useFakeTimers();
      const { stream, finish, frames, frame, acked } = sharpFixture();
      await stream.start();
      frame('animation-1', 1);
      finish[0]('sharp-1');
      await vi.advanceTimersByTimeAsync(0);
      frame('animation-2', 2);
      frame('animation-3', 3);
      expect(finish).toHaveLength(1);
      expect(acked(3)).toBe(false);
      await vi.advanceTimersByTimeAsync(332);
      expect(finish).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(finish).toHaveLength(2);
      finish[1]('sharp-3');
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['sharp-1', 'sharp-3']);
      await stream.stop();
    });

    it('ends the pacing wait at once when the user drives the page', async () => {
      vi.useFakeTimers();
      const { stream, finish, frames, frame, acked } = sharpFixture();
      await stream.start();
      frame('animation-1', 1);
      finish[0]('sharp-1');
      await vi.advanceTimersByTimeAsync(0);
      frame('animation-2', 2);
      stream.markInteractive();
      expect(acked(2)).toBe(true);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['sharp-1', 'animation-2']);
      await vi.advanceTimersByTimeAsync(400);
      expect(finish).toHaveLength(2);
      await stream.stop();
    });

    it('keeps the sharp picture when the capture echo arrives inside the input window', async () => {
      vi.useFakeTimers();
      const { stream, finish, frames, frame } = sharpFixture();
      await stream.start();
      stream.markInteractive();
      frame('scroll', 1);
      await vi.advanceTimersByTimeAsync(150);
      finish[0]('sharp');
      await vi.advanceTimersByTimeAsync(0);
      frame('scroll-echo', 2);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['scroll', 'sharp']);
      await vi.advanceTimersByTimeAsync(333);
      expect(finish).toHaveLength(2);
      finish[1]('sharp');
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['scroll', 'sharp']);
      await stream.stop();
    });

    it('forwards live pictures while the user drives the page, then one sharp picture', async () => {
      vi.useFakeTimers();
      const { stream, finish, frames, frame } = sharpFixture();
      await stream.start();
      stream.markInteractive();
      frame('scroll-1', 1);
      frame('scroll-2', 2);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['scroll-1', 'scroll-2']);
      expect(finish).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(149);
      expect(finish).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(finish).toHaveLength(1);
      finish[0]('sharp');
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['scroll-1', 'scroll-2', 'sharp']);
      await stream.stop();
    });

    it('drops a sharp picture that finishes after a newer live picture', async () => {
      vi.useFakeTimers();
      const { stream, finish, frames, frame } = sharpFixture();
      await stream.start();
      frame('before', 1);
      expect(finish).toHaveLength(1);
      stream.markInteractive();
      frame('after', 2);
      finish[0]('stale');
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['after']);
      await vi.advanceTimersByTimeAsync(150);
      expect(finish).toHaveLength(2);
      finish[1]('sharp');
      await vi.advanceTimersByTimeAsync(0);
      expect(frames.mock.calls.map(([f]) => f.data)).toEqual(['after', 'sharp']);
      await stream.stop();
    });

    it('returns to sharp pictures when the user stops, and cancels the pending one on stop', async () => {
      vi.useFakeTimers();
      const { stream, finish, frame } = sharpFixture();
      await stream.start();
      stream.markInteractive();
      frame('live', 1);
      await stream.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(finish).toHaveLength(0);
      await stream.start();
      frame('animated', 2);
      expect(finish).toHaveLength(1);
      await stream.stop();
    });
  });

  it('serializes tab reconnects and releases a capture stopped while reconnecting', async () => {
    const first = createMockCdpSession({ detach: vi.fn(async () => {}) });
    const second = createMockCdpSession({ detach: vi.fn(async () => {}) });
    let connect!: (session: CdpSessionLike) => void;
    const pending = new Promise<CdpSessionLike>(resolve => {
      connect = resolve;
    });
    const getCdpSession = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(pending);
    const capture = new ScreencastStream({ getCdpSession, isBrowserRunning: () => true });
    await capture.start();
    const reconnect = capture.reconnect();
    const again = capture.reconnect();
    const stopped = capture.stop();
    connect(second);
    await Promise.all([reconnect, again, stopped]);
    expect(getCdpSession).toHaveBeenCalledTimes(2);
    expect(capture.isActive()).toBe(false);
    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(second.detach).toHaveBeenCalledTimes(1);
  });
  let provider: CdpSessionProvider;
  let stream: ScreencastStream;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createMockProvider();
    stream = new ScreencastStream(provider);
  });

  afterEach(async () => {
    if (stream.isActive()) {
      await stream.stop();
    }
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('applies default options when none provided', () => {
      const s = new ScreencastStream(provider);
      expect(s.isActive()).toBe(false);
    });

    it('accepts custom options', () => {
      const s = new ScreencastStream(provider, { quality: 50, format: 'png' });
      expect(s.isActive()).toBe(false);
    });
  });

  describe('start', () => {
    it('gets CDP session and starts screencast', async () => {
      await stream.start();

      expect(provider.getCdpSession).toHaveBeenCalledOnce();
      expect(stream.isActive()).toBe(true);
    });

    it('passes options to Page.startScreencast', async () => {
      const customStream = new ScreencastStream(provider, { quality: 50, maxWidth: 640 });
      await customStream.start();

      const mockSession = await provider.getCdpSession();
      expect(mockSession.send).toHaveBeenCalledWith('Page.startScreencast', {
        ...SCREENCAST_DEFAULTS,
        quality: 50,
        maxWidth: 640,
      });
    });

    it('registers frame handler on CDP session', async () => {
      await stream.start();

      const mockSession = await provider.getCdpSession();
      expect(mockSession.on).toHaveBeenCalledWith('Page.screencastFrame', expect.any(Function));
    });

    it('is a no-op if already active', async () => {
      await stream.start();
      await stream.start();
      expect(provider.getCdpSession).toHaveBeenCalledOnce();
    });

    it('throws if browser is not running', async () => {
      provider = createMockProvider({ isBrowserRunning: false });
      stream = new ScreencastStream(provider);

      await expect(stream.start()).rejects.toThrow('Browser is not running');
      expect(stream.isActive()).toBe(false);
    });

    it('emits error event on failure', async () => {
      const mockSession = createMockCdpSession({
        send: vi.fn().mockRejectedValue(new Error('CDP error')),
      });
      provider = {
        getCdpSession: vi.fn().mockResolvedValue(mockSession),
        isBrowserRunning: vi.fn().mockReturnValue(true),
      };
      stream = new ScreencastStream(provider);

      const errorHandler = vi.fn();
      stream.on('error', errorHandler);

      await expect(stream.start()).rejects.toThrow('CDP error');
      expect(errorHandler).toHaveBeenCalledOnce();
    });
  });

  describe('stop', () => {
    it('calls Page.stopScreencast on CDP session', async () => {
      await stream.start();
      const mockSession = await provider.getCdpSession();

      await stream.stop();

      expect(mockSession.send).toHaveBeenCalledWith('Page.stopScreencast');
      expect(stream.isActive()).toBe(false);
    });

    it('removes frame handler from CDP session', async () => {
      await stream.start();
      const mockSession = await provider.getCdpSession();

      await stream.stop();

      expect(mockSession.off).toHaveBeenCalledWith('Page.screencastFrame', expect.any(Function));
    });

    it('emits stop event with reason manual', async () => {
      await stream.start();
      const stopHandler = vi.fn();
      stream.on('stop', stopHandler);

      await stream.stop();

      expect(stopHandler).toHaveBeenCalledWith('manual');
    });

    it('is a no-op if already stopped', async () => {
      await stream.stop();
      expect(provider.getCdpSession).not.toHaveBeenCalled();
    });

    it('emits stop with error reason if stopScreencast fails', async () => {
      const mockSession = createMockCdpSession({
        send: vi.fn().mockImplementation((method: string) => {
          if (method === 'Page.stopScreencast') {
            return Promise.reject(new Error('CDP gone'));
          }
          return Promise.resolve();
        }),
      });
      provider = {
        getCdpSession: vi.fn().mockResolvedValue(mockSession),
        isBrowserRunning: vi.fn().mockReturnValue(true),
      };
      stream = new ScreencastStream(provider);

      await stream.start();

      const stopHandler = vi.fn();
      stream.on('stop', stopHandler);

      // Should not throw
      await expect(stream.stop()).resolves.toBeUndefined();
      expect(stream.isActive()).toBe(false);
      expect(stopHandler).toHaveBeenCalledWith('error');
    });
  });

  describe('frame events', () => {
    it('emits frame events from Page.screencastFrame', async () => {
      // Capture the frame handler
      let capturedHandler: ((params: any) => void) | undefined;
      const mockSession = createMockCdpSession({
        on: vi.fn().mockImplementation((event: string, handler: any) => {
          if (event === 'Page.screencastFrame') {
            capturedHandler = handler;
          }
        }),
      });
      provider = {
        getCdpSession: vi.fn().mockResolvedValue(mockSession),
        isBrowserRunning: vi.fn().mockReturnValue(true),
      };
      stream = new ScreencastStream(provider);

      const frameHandler = vi.fn();
      stream.on('frame', frameHandler);

      await stream.start();

      // Simulate a frame from CDP
      capturedHandler!({
        data: 'base64data',
        sessionId: 1,
        metadata: {
          deviceWidth: 1280,
          deviceHeight: 720,
          offsetTop: 0,
          scrollOffsetX: 0,
          scrollOffsetY: 100,
          pageScaleFactor: 1,
          timestamp: 12345,
        },
      });

      expect(frameHandler).toHaveBeenCalledOnce();
      const emittedFrame: ScreencastFrameData = frameHandler.mock.calls[0][0];
      expect(emittedFrame.data).toBe('base64data');
      expect(emittedFrame.viewport.width).toBe(1280);
      expect(emittedFrame.viewport.height).toBe(720);
      expect(emittedFrame.viewport.scrollOffsetY).toBe(100);
      expect(emittedFrame.sessionId).toBe(1);
      // CDP timestamp is in seconds, converted to milliseconds
      expect(emittedFrame.timestamp).toBe(12345 * 1000);
    });

    it('acknowledges frames via Page.screencastFrameAck', async () => {
      let capturedHandler: ((params: any) => void) | undefined;
      const mockSession = createMockCdpSession({
        on: vi.fn().mockImplementation((event: string, handler: any) => {
          if (event === 'Page.screencastFrame') {
            capturedHandler = handler;
          }
        }),
      });
      provider = {
        getCdpSession: vi.fn().mockResolvedValue(mockSession),
        isBrowserRunning: vi.fn().mockReturnValue(true),
      };
      stream = new ScreencastStream(provider);

      await stream.start();

      // Simulate a frame
      capturedHandler!({
        data: 'data',
        sessionId: 42,
        metadata: {},
      });

      expect(mockSession.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 42 });
    });

    it('uses Date.now() when frame has no timestamp', async () => {
      let capturedHandler: ((params: any) => void) | undefined;
      const mockSession = createMockCdpSession({
        on: vi.fn().mockImplementation((event: string, handler: any) => {
          if (event === 'Page.screencastFrame') {
            capturedHandler = handler;
          }
        }),
      });
      provider = {
        getCdpSession: vi.fn().mockResolvedValue(mockSession),
        isBrowserRunning: vi.fn().mockReturnValue(true),
      };
      stream = new ScreencastStream(provider);

      const frameHandler = vi.fn();
      stream.on('frame', frameHandler);

      await stream.start();

      const beforeTime = Date.now();
      capturedHandler!({
        data: 'data',
        sessionId: 2,
        metadata: {
          deviceWidth: 100,
          deviceHeight: 100,
          // no timestamp
        },
      });
      const afterTime = Date.now();

      const emittedFrame: ScreencastFrameData = frameHandler.mock.calls[0][0];
      expect(emittedFrame.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(emittedFrame.timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('isActive', () => {
    it('returns false before start', () => {
      expect(stream.isActive()).toBe(false);
    });

    it('returns true after start', async () => {
      await stream.start();
      expect(stream.isActive()).toBe(true);
    });

    it('returns false after stop', async () => {
      await stream.start();
      await stream.stop();
      expect(stream.isActive()).toBe(false);
    });
  });
});
