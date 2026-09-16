import type { MastraDBMessage, MastraMessagePart } from '../agent/message-list/state/types';
import { getToolCompletion } from '../agent/message-list/tool-completion';

/** Display-only rows. Stored model history retains the original call/result pair. */
export function projectCompletedToolMessages(messages: MastraDBMessage[]): MastraDBMessage[] {
  const rows: MastraDBMessage[] = [];
  for (const message of messages) {
    if (
      message.role !== 'assistant' ||
      !Array.isArray(message.content?.parts) ||
      message.content.metadata?.toolCompletion
    ) {
      rows.push(message);
      continue;
    }
    const remaining: MastraMessagePart[] = [];
    const completed: MastraDBMessage[] = [];
    for (const part of message.content.parts) {
      const completion =
        part.type === 'tool-invocation' &&
        ['result', 'output-error', 'output-denied'].includes(part.toolInvocation.state)
          ? getToolCompletion(part.providerMetadata)
          : undefined;
      if (!completion || part.type !== 'tool-invocation') {
        remaining.push(part);
        continue;
      }
      completed.push({
        ...message,
        id: `${message.id}:tool-result:${encodeURIComponent(part.toolInvocation.toolCallId)}`,
        createdAt: new Date(completion.completedAt),
        content: {
          format: 2,
          parts: [part],
          metadata: {
            toolCompletion: {
              sourceMessageId: message.id,
              toolCallId: part.toolInvocation.toolCallId,
              ...completion,
            },
          },
        },
      });
    }
    if (!completed.length) {
      rows.push(message);
      continue;
    }
    // Keep an empty original row in the wire so an earlier live call row is replaced.
    // Renderers can omit its empty body; it never carries a second artifact.
    rows.push({ ...message, content: { ...message.content, parts: remaining, toolInvocations: undefined } });
    rows.push(...completed);
  }
  return rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
