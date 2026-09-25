import type { BrowserViewerPreferences, ScreencastOptions } from '@mastra/core/browser';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

/** Lowest quality a size limit may pick when the options name none. */
const DEFAULT_MIN_SHARP_QUALITY = 60;

/** Bytes of base64 image data. */
const decodedBytes = (data: string) =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/** Browser protocol settings, shared by the tools and viewer on the same context. */
export class ViewerPreferences {
  private current?: BrowserViewerPreferences;
  private pages = new Map<
    Page,
    {
      session: Promise<CDPSession>;
      applied?: BrowserViewerPreferences;
      pending: Promise<void>;
      /** Quality and scale that kept the last sharp picture of this page within the size limit. */
      fit?: { quality?: number; scale: number };
    }
  >();

  constructor(private context: BrowserContext) {
    context.on('page', page => {
      void this.apply(page).catch(() => {});
    });
    context.once('close', () => this.pages.clear());
  }

  get(page: Page): BrowserViewerPreferences | undefined {
    return this.pages.get(page)?.applied;
  }

  async capture(page: Page, options: ScreencastOptions): Promise<string | undefined> {
    await this.apply(page);
    const entry = this.pages.get(page);
    const preferences = entry?.applied;
    // A normal-density screen already gets full-size live pictures; capture one only when a
    // separate sharp format is configured (it is smaller and sharper than the live JPEG).
    if (!entry || !preferences || (preferences.deviceScaleFactor <= 1 && !options.sharp)) return undefined;
    // Chromium capture uses the emulation state of the calling CDP session.
    // Reuse the preference session; a second session can temporarily resize the
    // page while capturing, breaking input and tools during that interval.
    const session = await entry.session;
    const { width, height, deviceScaleFactor } = preferences;
    const sharp = options.sharp;
    const format = sharp?.format ?? options.format ?? 'jpeg';
    const maxQuality = format === 'png' ? undefined : (sharp?.quality ?? options.quality ?? 80);
    const minQuality = Math.min(maxQuality ?? 0, sharp?.minQuality ?? DEFAULT_MIN_SHARP_QUALITY);
    const maxScale = Math.min(
      1,
      (sharp?.maxWidth ?? options.maxWidth ?? 1280) / (width * deviceScaleFactor),
      (sharp?.maxHeight ?? options.maxHeight ?? 720) / (height * deviceScaleFactor),
    );
    const maxBytes = sharp?.maxBytes;
    // Start from what fitted this page last time, so a heavy page is captured once, not three times.
    let quality = maxBytes && entry.fit ? entry.fit.quality : maxQuality;
    let scale = maxBytes && entry.fit ? Math.min(maxScale, entry.fit.scale) : maxScale;
    const { layoutViewport } = await session.send('Page.getLayoutMetrics');
    const shoot = async () =>
      (
        await session.send('Page.captureScreenshot', {
          format,
          ...(quality !== undefined ? { quality } : {}),
          captureBeyondViewport: false,
          clip: { x: layoutViewport.pageX, y: layoutViewport.pageY, width, height, scale },
        })
      ).data;
    let data = await shoot();
    if (!maxBytes) return data;
    let bytes = decodedBytes(data);
    // Over the limit: first the lowest allowed quality, then a smaller picture.
    if (bytes > maxBytes && quality !== undefined && quality > minQuality) {
      quality = minQuality;
      data = await shoot();
      bytes = decodedBytes(data);
    }
    for (let attempt = 0; bytes > maxBytes && attempt < 2; attempt++) {
      // Bytes follow the pixel area; 0.9 leaves room for pages that do not shrink evenly.
      scale = Math.max(0.1, scale * Math.sqrt(maxBytes / bytes) * 0.9);
      data = await shoot();
      bytes = decodedBytes(data);
    }
    // Well under the limit: let the next picture of this page try the full sharpness again.
    entry.fit = bytes < maxBytes * 0.5 ? undefined : { quality, scale };
    return data;
  }

  async set(preferences: BrowserViewerPreferences) {
    const locale = Intl.getCanonicalLocales(preferences.locale)[0];
    if (
      !locale ||
      !Number.isInteger(preferences.width) ||
      !Number.isInteger(preferences.height) ||
      preferences.width < 240 ||
      preferences.width > 3840 ||
      preferences.height < 160 ||
      preferences.height > 2160 ||
      !Number.isFinite(preferences.deviceScaleFactor) ||
      preferences.deviceScaleFactor < 1 ||
      preferences.deviceScaleFactor > 2
    ) {
      throw new Error('Invalid browser viewer preferences');
    }
    this.current = { ...preferences, locale };
    await Promise.all(this.context.pages().map(page => this.apply(page)));
  }

  async apply(page: Page): Promise<void> {
    const preferences = this.current;
    if (!preferences || page.isClosed()) return;
    let entry = this.pages.get(page);
    if (!entry) {
      entry = { session: this.context.newCDPSession(page), pending: Promise.resolve() };
      this.pages.set(page, entry);
      page.once('close', () => this.pages.delete(page));
    }
    const target = entry;
    const work = target.pending.then(async () => {
      if (target.applied === preferences || page.isClosed()) return;
      const session = await target.session;
      // Playwright keeps screenshots and tool coordinates in the same CSS viewport.
      await page.setViewportSize({ width: preferences.width, height: preferences.height });
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: preferences.width,
        height: preferences.height,
        deviceScaleFactor: preferences.deviceScaleFactor,
        mobile: false,
      });
      if (target.applied?.locale !== preferences.locale) {
        const { userAgent } = await session.send('Browser.getVersion');
        await session.send('Emulation.setUserAgentOverride', { userAgent, acceptLanguage: preferences.locale });
        await session.send('Emulation.setLocaleOverride', { locale: preferences.locale });
      }
      target.applied = preferences;
      target.fit = undefined;
    });
    target.pending = work.catch(() => {});
    await work;
  }
}
