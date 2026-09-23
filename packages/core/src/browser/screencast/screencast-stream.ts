/**
 * CDP-based ScreencastStream implementation.
 *
 * This provides a unified screencast implementation that works with any
 * CDP session provider (Playwright, Puppeteer, direct CDP, etc.).
 */

import { EventEmitter } from 'node:events';
import type { CdpSessionLike, CdpSessionProvider, ScreencastFrameData, ScreencastOptions } from './types';
import { SCREENCAST_DEFAULTS } from './types';

/** How long after user input live pictures are forwarded without a device-density capture. */
const INTERACTIVE_MS = 500;

/** Quiet time after the last live picture before one device-density capture replaces it. */
const SHARP_SETTLE_MS = 150;

/** Live pictures remembered as views of the current page. */
const SEEN_PICTURES = 4;

/** Nobody is touching a page that keeps changing on its own: at most about three sharp pictures a second. */
const SHARP_MIN_GAP_MS = 333;

/**
 * CDP screencast frame event data from Page.screencastFrame
 */
interface CdpScreencastFrame {
  data: string;
  sessionId: number;
  metadata?: {
    deviceWidth?: number;
    deviceHeight?: number;
    offsetTop?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    pageScaleFactor?: number;
    timestamp?: number;
  };
}

/**
 * ScreencastStream wraps CDP screencast with an event emitter interface.
 *
 * Works with any CDP session provider (Playwright, Puppeteer, direct CDP).
 *
 * @example
 * ```typescript
 * const stream = new ScreencastStream(cdpProvider, { quality: 80 });
 * stream.on('frame', (frame) => {
 *   console.log(`Frame: ${frame.viewport.width}x${frame.viewport.height}`);
 * });
 * await stream.start();
 * // Later...
 * await stream.stop();
 * ```
 */
export class ScreencastStream extends EventEmitter {
  /** Whether screencast is currently active */
  private active: boolean = false;
  private reconnecting?: Promise<void>;
  private reconnectAgain = false;
  private stopping = false;

  /** Resolved options with defaults applied (excludes threadId which is only used for page selection) */
  private options: Required<Omit<ScreencastOptions, 'threadId'>>;

  /** CDP session provider */
  private provider: CdpSessionProvider;

  /** Current CDP session */
  private cdpSession: CdpSessionLike | null = null;

  /** Frame handler reference (for cleanup) */
  private frameHandler: ((params: CdpScreencastFrame) => void) | null = null;

  /** Live pictures are forwarded directly until this time; device-density captures otherwise. */
  private interactiveUntil = 0;

  /** Cancels the pending sharp capture of the current CDP session. */
  private clearSettle: () => void = () => {};

  /** Lets Chrome send the next live picture without waiting for the capture in progress. */
  private releaseHeld: () => void = () => {};

  /**
   * Creates a new ScreencastStream.
   *
   * @param provider - CDP session provider (browser instance)
   * @param options - Screencast configuration options
   */
  constructor(provider: CdpSessionProvider, options?: ScreencastOptions) {
    super();
    this.provider = provider;
    // Extract threadId (used by caller for page selection) and merge remaining options
    const { threadId: _, ...cdpOptions } = options ?? {};
    this.options = { ...SCREENCAST_DEFAULTS, ...cdpOptions };
  }

  /**
   * Start the screencast.
   * If already active, returns immediately.
   */
  async start(): Promise<void> {
    if (!this.reconnecting) this.stopping = false;
    if (this.active) {
      return;
    }

    if (!this.provider.isBrowserRunning()) {
      throw new Error('Browser is not running');
    }

    try {
      // Get CDP session from provider
      this.cdpSession = await this.provider.getCdpSession();
      const session = this.cdpSession;
      const live = () => this.cdpSession === session && !this.stopping;
      const ack = (params: CdpScreencastFrame) =>
        void session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      let emitted = 0;
      let capturing = false;
      let pending: CdpScreencastFrame | undefined;
      let sharpAgain: CdpScreencastFrame | undefined;
      // Live pictures already known to show the page as it is now. A capture can make Chrome send a
      // slightly different live picture of the same page, so more than the latest one is remembered.
      let seen: string[] = [];
      let lastSharp: string | undefined;
      let settle: ReturnType<typeof setTimeout> | undefined;
      let cooldown: ReturnType<typeof setTimeout> | undefined;
      let cooling = false;
      let lastCaptureAt = 0;
      this.clearSettle = () => {
        clearTimeout(settle);
        clearTimeout(cooldown);
      };

      const emitFrame = (data: string, params: CdpScreencastFrame) => {
        emitted += 1;
        lastSharp = undefined;
        seen = [params.data];
        this.emit('frame', {
          data,
          timestamp: params.metadata?.timestamp ? params.metadata.timestamp * 1000 : Date.now(),
          viewport: {
            width: params.metadata?.deviceWidth ?? 0,
            height: params.metadata?.deviceHeight ?? 0,
            offsetTop: params.metadata?.offsetTop,
            scrollOffsetX: params.metadata?.scrollOffsetX,
            scrollOffsetY: params.metadata?.scrollOffsetY,
            pageScaleFactor: params.metadata?.pageScaleFactor,
          },
          sessionId: params.sessionId,
        } satisfies ScreencastFrameData);
      };

      // One device-density capture. A capture that finishes after a newer live picture is dropped.
      // Holding the acknowledgement paces Chrome to the capture; user input releases it at once.
      let held: CdpScreencastFrame | undefined;
      const release = () => {
        if (held) ack(held);
        held = undefined;
        if (cooling) {
          clearTimeout(cooldown);
          cooling = false;
        }
        const next = pending;
        pending = undefined;
        if (next) handle(next);
      };
      this.releaseHeld = () => {
        if (live()) release();
      };
      const sharpen = async (params: CdpScreencastFrame, acknowledge: boolean) => {
        capturing = true;
        lastCaptureAt = Date.now();
        if (acknowledge) held = params;
        const before = emitted;
        try {
          const data = await this.provider.captureFrame?.(this.options);
          if (!live() || emitted !== before) return;
          if (data !== undefined && data === lastSharp) {
            // Nothing changed on the page: this live picture is another view of the current one.
            if (!seen.includes(params.data)) seen = [...seen.slice(-(SEEN_PICTURES - 1)), params.data];
            return;
          }
          emitFrame(data ?? params.data, params);
          if (data !== undefined) lastSharp = data;
        } catch (error) {
          if (live()) this.emit('error', error);
        } finally {
          if (held === params) {
            ack(params);
            held = undefined;
          }
          capturing = false;
          const next = pending;
          const again = sharpAgain;
          pending = sharpAgain = undefined;
          if (next && live()) handle(next);
          else if (again && live()) void sharpen(again, false);
        }
      };

      const route = (params: CdpScreencastFrame) => {
        if (Date.now() < this.interactiveUntil) {
          // The user is driving the page: forward the live picture without a second capture.
          emitFrame(params.data, params);
          ack(params);
          clearTimeout(settle);
          settle = setTimeout(() => {
            if (!live()) return;
            // The page came to rest; new input opens the next live window.
            this.interactiveUntil = 0;
            if (capturing) sharpAgain = params;
            else void sharpen(params, false);
          }, SHARP_SETTLE_MS);
        } else if (capturing || cooling) {
          if (pending) ack(pending);
          pending = params;
        } else {
          const wait = lastCaptureAt + SHARP_MIN_GAP_MS - Date.now();
          if (wait <= 0) return void sharpen(params, true);
          // Pace a page that keeps changing on its own. The newest picture waits unacknowledged, so
          // Chrome pauses too; user input ends the wait at once (release).
          pending = params;
          cooling = true;
          cooldown = setTimeout(() => {
            cooling = false;
            const next = pending;
            pending = undefined;
            if (next && live()) handle(next);
          }, wait);
        }
      };

      const handle = (params: CdpScreencastFrame) => {
        // The same picture again: the echo of our own capture, or no visual change.
        if (seen.includes(params.data)) return ack(params);
        route(params);
      };

      // Set up frame handler
      this.frameHandler = (params: CdpScreencastFrame) => {
        if (this.provider.captureFrame) {
          handle(params);
          return;
        }
        const frameData: ScreencastFrameData = {
          data: params.data,
          // CDP provides timestamp in seconds, convert to milliseconds for consistency
          timestamp: params.metadata?.timestamp ? params.metadata.timestamp * 1000 : Date.now(),
          viewport: {
            width: params.metadata?.deviceWidth ?? 0,
            height: params.metadata?.deviceHeight ?? 0,
            offsetTop: params.metadata?.offsetTop,
            scrollOffsetX: params.metadata?.scrollOffsetX,
            scrollOffsetY: params.metadata?.scrollOffsetY,
            pageScaleFactor: params.metadata?.pageScaleFactor,
          },
          sessionId: params.sessionId,
        };

        this.emit('frame', frameData);

        // Acknowledge frame to continue receiving
        this.acknowledgeFrame(params.sessionId);
      };

      this.cdpSession.on('Page.screencastFrame', this.frameHandler);

      // Start screencast via CDP
      try {
        await this.cdpSession.send('Page.startScreencast', {
          format: this.options.format,
          quality: this.options.quality,
          maxWidth: this.options.maxWidth,
          maxHeight: this.options.maxHeight,
          everyNthFrame: this.options.everyNthFrame,
        });
      } catch (startError) {
        // Clean up handler before re-throwing to prevent resource leak
        if (this.cdpSession?.off) {
          try {
            this.cdpSession.off('Page.screencastFrame', this.frameHandler);
          } catch {
            // Ignore cleanup errors
          }
        }
        this.frameHandler = null;
        this.cdpSession = null;
        throw startError;
      }

      this.active = true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      throw err;
    }
  }

  /** Forward live pictures directly while the user drives the page; sharp pictures follow when it settles. */
  markInteractive(): void {
    this.interactiveUntil = Date.now() + INTERACTIVE_MS;
    this.releaseHeld();
  }

  /**
   * Acknowledge a frame to CDP (required to continue receiving frames).
   */
  private acknowledgeFrame(sessionId: number): void {
    if (!this.cdpSession) return;

    this.cdpSession.send('Page.screencastFrameAck', { sessionId }).catch(() => {
      // Ignore ack errors - session may be closed
    });
  }

  /**
   * Stop the screencast and release resources.
   * Safe to call even if browser/CDP session is already closed.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.reconnecting?.catch(() => {});
    if (!this.active) {
      return;
    }

    this.active = false;
    this.clearSettle();
    let hadError = false;

    // Clean up handler regardless of CDP state
    if (this.cdpSession && this.frameHandler && this.cdpSession.off) {
      try {
        this.cdpSession.off('Page.screencastFrame', this.frameHandler);
      } catch {
        // Ignore - session may be dead
      }
    }
    this.frameHandler = null;

    // Try to stop screencast via CDP (may fail if browser closed)
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
      } catch {
        // Browser/session already closed - this is expected in external close scenarios
        hadError = true;
      }
      await this.cdpSession.detach?.().catch(() => {});
      this.cdpSession = null;
    }

    this.emit('stop', hadError ? 'error' : 'manual');
  }

  /**
   * Check if screencast is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Emit a URL update event.
   * Browser providers call this when navigation is detected.
   */
  emitUrl(url: string): void {
    this.emit('url', url);
  }

  /**
   * Reconnect the screencast by stopping and restarting.
   * Use this when the active page/tab changes.
   *
   * @returns Promise that resolves when reconnection is complete
   * @throws Error if reconnection fails (also emits 'error' event)
   */
  async reconnect(): Promise<void> {
    if (this.stopping) return;
    if (this.reconnecting) {
      this.reconnectAgain = true;
      return this.reconnecting;
    }
    this.reconnecting = (async () => {
      do {
        this.reconnectAgain = false;
        await this.reconnectOnce();
      } while (this.reconnectAgain && !this.stopping);
    })().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  private async reconnectOnce(): Promise<void> {
    this.clearSettle();
    // Clean up existing session
    if (this.cdpSession && this.frameHandler && this.cdpSession.off) {
      try {
        this.cdpSession.off('Page.screencastFrame', this.frameHandler);
      } catch {
        // Ignore - session may be dead
      }
    }
    this.frameHandler = null;

    // Try to stop screencast on old session (may fail if session is dead)
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
      } catch {
        // Old session may already be detached - this is expected
      }
      await this.cdpSession.detach?.().catch(() => {});
      this.cdpSession = null;
    }

    // Mark as inactive so start() will work
    this.active = false;

    // Restart with fresh session from provider
    try {
      await this.start();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[ScreencastStream.reconnect] Failed to reconnect:', err);
      // Don't emit 'error' here - start() already emits it before rejecting
      throw err;
    }
  }
}
