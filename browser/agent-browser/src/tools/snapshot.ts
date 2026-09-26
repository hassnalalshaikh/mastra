/**
 * browser_snapshot - Get accessibility tree snapshot
 */
import { createTool } from '@mastra/core/tools';
import type { AgentBrowser } from '../agent-browser';
import { snapshotInputSchema } from '../schemas';
import { BROWSER_TOOLS } from './constants';
export function createSnapshotTool(browser: AgentBrowser) {
  return createTool({
    id: BROWSER_TOOLS.SNAPSHOT,
    description:
      'Get accessibility tree snapshot of the page. Returns text-based representation with element refs like [ref=e1], [ref=e2] for targeting. On a very long page every form control is listed and the rest is shortened; use find to list the elements you need.',
    inputSchema: snapshotInputSchema,
    execute: async (input, { agent }) => {
      const threadId = agent?.threadId;
      browser.setCurrentThread(threadId);
      await browser.ensureReady();
      return browser.snapshot(input, threadId);
    },
  });
}
