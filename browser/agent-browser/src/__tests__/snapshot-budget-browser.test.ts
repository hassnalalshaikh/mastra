/**
 * Real Chromium: a long page's snapshot fits snapshotMaxChars, keeps every
 * form control, says what was left out, and a left-out link can still be
 * found with `find` and clicked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentBrowser } from '../agent-browser';

let canLaunchBrowser = true;
const probe = new AgentBrowser({ headless: true, scope: 'shared' });
try {
  await probe.ensureReady();
  await probe.close();
} catch (error) {
  try {
    await probe.close();
  } catch {
    // Ignore cleanup errors
  }
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Executable doesn't exist") ||
    message.includes('browserType.launch') ||
    message.includes('Cannot find module') ||
    message.includes('ENOENT')
  ) {
    canLaunchBrowser = false;
  } else {
    throw error;
  }
}

const links = Array.from({ length: 400 }, (_, i) => `<a href="#section-${i}" id="l${i}">Section link ${i}</a>`).join(
  ' ',
);
const page =
  'data:text/html,' +
  encodeURIComponent(
    `<title>Long page</title><input type="search" aria-label="Search the site"><p>${links}</p>` +
      '<button onclick="document.title=\'Sent\'">Send form</button>',
  );

describe.skipIf(!canLaunchBrowser)('AgentBrowser snapshot budget (real browser)', () => {
  let browser: AgentBrowser;

  beforeAll(async () => {
    browser = new AgentBrowser({ headless: true, timeout: 15_000, scope: 'shared', snapshotMaxChars: 2_000 });
    await browser.ensureReady();
    await browser.goto({ url: page });
  });

  afterAll(async () => {
    await browser.close();
  }, 10_000);

  it('keeps the page under the limit with every control and a way to see the rest', async () => {
    const result = await browser.snapshot({});
    if (!('snapshot' in result)) throw new Error(`snapshot failed: ${JSON.stringify(result)}`);
    expect(result.snapshot.length).toBeLessThanOrEqual(2_000);
    expect(result.snapshot).toMatch(/searchbox "Search the site" @e\d+/);
    expect(result.snapshot).toMatch(/button "Send form" @e\d+/);
    expect(result.elementCount).toBe(402);
    expect(result.shownElementCount).toBeLessThan(402);
    expect(result.hint).toContain('more elements not shown');
    expect(result.hint).toContain('find:');
  });

  it('finds a left-out link by its words and can act on it', async () => {
    const found = await browser.snapshot({ find: 'Section link 350' });
    if (!('snapshot' in found)) throw new Error(`snapshot failed: ${JSON.stringify(found)}`);
    const ref = /link "Section link 350" (@e\d+)/.exec(found.snapshot)?.[1];
    expect(ref).toBeDefined();
    const clicked = await browser.click({ ref: ref! });
    expect(clicked).toMatchObject({ success: true });
    const button = /button "Send form" (@e\d+)/.exec(
      ((await browser.snapshot({})) as { snapshot: string }).snapshot,
    )?.[1];
    await browser.click({ ref: button! });
    const after = await browser.snapshot({ showAll: true });
    if (!('snapshot' in after)) throw new Error('snapshot failed');
    expect(after.title).toBe('Sent');
    expect(after.shownElementCount).toBeUndefined();
  });
});
