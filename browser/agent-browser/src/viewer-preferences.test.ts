import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ViewerPreferences } from './viewer-preferences';

describe('viewer preferences in Chromium', () => {
  let browser: Browser;
  let context: BrowserContext;
  let baseUrl: string;
  const headers: string[] = [];
  const server = createServer((req, res) => {
    headers.push(String(req.headers['accept-language']));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      '<style>body{margin:0}.narrow{display:none}@media(max-width:500px){.narrow{display:block}}</style><input id="draft"><p class="narrow">Narrow layout</p><p>Browser text for frame proof</p>',
    );
  });
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ executablePath: process.env.MASTRA_TEST_BROWSER_EXECUTABLE, headless: true });
    context = await browser.newContext();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('reflows without reload, preserves input and sets real browser language', async () => {
    const page = await context.newPage();
    const settings = new ViewerPreferences(context);
    await settings.set({ width: 900, height: 700, deviceScaleFactor: 2, locale: 'ar-SA' });
    await page.goto(baseUrl);
    expect(headers.at(-1)).toMatch(/^ar-SA/);
    expect(await page.evaluate(() => navigator.language)).toBe('ar-SA');
    expect(await page.evaluate(() => new Intl.DateTimeFormat().resolvedOptions().locale)).toBe('ar-SA');
    await page.locator('#draft').fill('Unsaved input');
    await settings.set({ width: 390, height: 844, deviceScaleFactor: 2, locale: 'ar-SA' });
    expect(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([390, 844, 2]);
    expect(await page.locator('.narrow').isVisible()).toBe(true);
    expect(await page.locator('#draft').inputValue()).toBe('Unsaved input');
    const next = await context.newPage();
    await settings.apply(next);
    await next.goto(baseUrl);
    expect(await next.evaluate(() => [innerWidth, navigator.language])).toEqual([390, 'ar-SA']);
    expect(headers.at(-1)).toMatch(/^ar-SA/);

    await page.bringToFront();
    await page.evaluate(() => {
      const corner = document.createElement('div');
      corner.style.cssText = 'position:fixed;bottom:0;right:0;width:20px;height:20px;background:rgb(0,255,0)';
      document.body.append(corner);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const session = await context.newCDPSession(page);
    const data = (await settings.capture(page, { format: 'png', maxWidth: 4096, maxHeight: 4096 }))!;
    const png = Buffer.from(data, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([780, 1688]);
    const bottomPixel = await page.evaluate(async data => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + data;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(img.width - 2, img.height - 2, 1, 1).data];
    }, data);
    expect(bottomPixel).toEqual([0, 255, 0, 255]);
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 40,
      y: 10,
      button: 'left',
      clickCount: 1,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 40,
      y: 10,
      button: 'left',
      clickCount: 1,
    });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft');
    await page.keyboard.insertText(' Arabic input');
    expect(await page.locator('#draft').inputValue()).toContain('Arabic input');
    await page.evaluate(() => {
      document.body.style.height = '3000px';
      window.scrollTo(0, 500);
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const maxSize of [4096, 844]) {
      const scrolled = (await settings.capture(page, { format: 'png', maxWidth: maxSize, maxHeight: maxSize }))!;
      const dimensions = Buffer.from(scrolled, 'base64');
      expect([dimensions.readUInt32BE(16), dimensions.readUInt32BE(20)]).toEqual(
        maxSize === 4096 ? [780, 1688] : [390, 844],
      );
      expect(await page.evaluate(() => [innerWidth, innerHeight, scrollY])).toEqual([390, 844, 500]);
      const pixel = await page.evaluate(async data => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + data;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(image.width - 2, image.height - 2, 1, 1).data];
      }, scrolled);
      expect(pixel).toEqual([0, 255, 0, 255]);
    }
    await session.detach();
  }, 20000);

  it('captures the sharp picture in its own format and keeps it under the size limit', async () => {
    // A context of its own: one preference owner per context, as in the product.
    const own = await browser.newContext();
    const page = await own.newPage();
    const settings = new ViewerPreferences(own);
    await settings.set({ width: 900, height: 700, deviceScaleFactor: 2, locale: 'en-US' });
    await page.goto(baseUrl);
    // Dense small text in many colours: a heavy picture, like a long article.
    await page.evaluate(() => {
      const words = Array.from(
        { length: 4000 },
        (_, i) => `<span style="color:hsl(${(i * 37) % 360} 70% 35%)">w${(i * 7919) % 10007}</span>`,
      );
      document.body.innerHTML = `<div style="font:11px monospace;word-break:break-all">${words.join(' ')}</div>`;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bytes = (data: string) => Buffer.from(data, 'base64');
    const kind = (data: string) => bytes(data).subarray(8, 12).toString();
    const size = (data: string) => bytes(data).length;
    const full = (await settings.capture(page, {
      format: 'jpeg',
      quality: 85,
      maxWidth: 7680,
      maxHeight: 4320,
      sharp: { format: 'webp', quality: 90 },
    }))!;
    expect(kind(full)).toBe('WEBP');
    const maxBytes = Math.round(size(full) * 0.4);
    const sends: string[] = [];
    const session = await (settings as any).pages.get(page).session;
    const send = session.send.bind(session);
    session.send = (method: string, params?: unknown) => {
      if (method === 'Page.captureScreenshot') sends.push(method);
      return send(method, params);
    };
    const options = {
      format: 'jpeg' as const,
      quality: 85,
      maxWidth: 7680,
      maxHeight: 4320,
      sharp: { format: 'webp' as const, quality: 90, maxBytes },
    };
    const limited = (await settings.capture(page, options))!;
    expect(kind(limited)).toBe('WEBP');
    expect(size(limited)).toBeLessThanOrEqual(maxBytes);
    const attempts = sends.length;
    expect(attempts).toBeGreaterThan(1);
    // The next picture of the same page starts from what fitted: one capture.
    sends.length = 0;
    const again = (await settings.capture(page, options))!;
    expect(size(again)).toBeLessThanOrEqual(maxBytes);
    expect(sends).toHaveLength(1);
    // Without a sharp format, the screencast format is used as before.
    const jpeg = (await settings.capture(page, { format: 'jpeg', quality: 85, maxWidth: 7680, maxHeight: 4320 }))!;
    expect(bytes(jpeg).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await own.close();
  }, 20000);

  it('captures a normal-density screen only when a sharp format is configured', async () => {
    const own = await browser.newContext();
    const page = await own.newPage();
    const settings = new ViewerPreferences(own);
    await settings.set({ width: 800, height: 600, deviceScaleFactor: 1, locale: 'en-US' });
    await page.goto(baseUrl);
    const live = { format: 'jpeg' as const, quality: 60, maxWidth: 1440, maxHeight: 900 };
    expect(await settings.capture(page, live)).toBeUndefined();
    const sharp = (await settings.capture(page, {
      ...live,
      sharp: { format: 'webp', quality: 85, maxWidth: 7680, maxHeight: 4320 },
    }))!;
    const webp = Buffer.from(sharp, 'base64');
    expect(webp.subarray(8, 12).toString()).toBe('WEBP');
    const size = await page.evaluate(async data => {
      const image = new Image();
      image.src = 'data:image/webp;base64,' + data;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, sharp);
    expect(size).toEqual([800, 600]);
    await own.close();
  }, 20000);
});
