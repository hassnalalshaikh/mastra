import type { ThreadStateStorage } from '../../storage/domains/thread-state/base';
import type { MastraDBMessage } from './state/types';
import { getToolCompletion } from './tool-completion';

/** Bounded native display index. The source message remains the only copy of tool output. */
export const TOOL_COMPLETION_INDEX_TYPE = 'recent-tool-completions';
export const TOOL_COMPLETION_INDEX_LIMIT = 1024;
export type ToolCompletionIndexEntry = { messageId: string; completedAt: string };

export async function indexToolCompletions(store: ThreadStateStorage, messages: MastraDBMessage[]): Promise<void> {
  const byThread = new Map<string, ToolCompletionIndexEntry[]>();
  for (const message of messages) {
    if (!message.threadId || message.role !== 'assistant') continue;
    let latest: string | undefined;
    for (const part of message.content.parts) {
      if (part.type !== 'tool-invocation') continue;
      const completion = getToolCompletion(part.providerMetadata);
      if (completion && (!latest || completion.completedAt > latest)) latest = completion.completedAt;
    }
    if (!latest) continue;
    const entries = byThread.get(message.threadId) ?? [];
    entries.push({ messageId: message.id, completedAt: latest });
    byThread.set(message.threadId, entries);
  }
  for (const [threadId, incoming] of byThread) {
    const previous =
      (await store.getState<ToolCompletionIndexEntry[]>({ threadId, type: TOOL_COMPLETION_INDEX_TYPE })) ?? [];
    const byId = new Map(previous.map(entry => [entry.messageId, entry]));
    for (const entry of incoming) {
      const old = byId.get(entry.messageId);
      if (!old || entry.completedAt > old.completedAt) byId.set(entry.messageId, entry);
    }
    const value = [...byId.values()]
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .slice(0, TOOL_COMPLETION_INDEX_LIMIT);
    if (JSON.stringify(value) !== JSON.stringify(previous)) {
      await store.setState({ threadId, type: TOOL_COMPLETION_INDEX_TYPE, value });
    }
  }
}
