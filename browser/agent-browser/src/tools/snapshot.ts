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
      'Get accessibility tree snapshot of the page. Returns text-based representation with element refs like [ref=e1], [ref=e2] for targeting. Call it without find first. On a very long page it lists every form control and part of the rest, and the hint says how many elements were left out; only then use find (or showAll) to bring those into view.',
    inputSchema: snapshotInputSchema,
    execute: async (input, { agent }) => {
      const threadId = agent?.threadId;
      browser.setCurrentThread(threadId);
      await browser.ensureReady();
      return browser.snapshot(input, threadId);
    },
  });
}
