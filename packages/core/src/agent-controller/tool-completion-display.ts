import type { MastraDBMessage, MastraMessagePart } from '../agent/message-list/state/types';
import { getToolCompletion, isCompletedToolOutcome } from '../agent/message-list/tool-completion';
import type { ToolCompletion } from '../agent/message-list/tool-completion';
import type { AgentControllerEvent } from './types';

type ToolInvocationPart = Extract<MastraMessagePart, { type: 'tool-invocation' }>;

/** Stable display id of the row that shows one completed call at its completion time. */
export function toolCompletionRowId(sourceMessageId: string, toolCallId: string): string {
  return `${sourceMessageId}:tool-result:${encodeURIComponent(toolCallId)}`;
}

/**
 * The completion a part moves to, or undefined when the part stays in its row.
 * Human-input tools are conversation checkpoints, not late artifacts: their
 * answer updates the question in place, including after reload.
 */
export function displayedToolCompletion(part: MastraMessagePart): ToolCompletion | undefined {
  if (part.type !== 'tool-invocation') return;
  if (part.providerMetadata?.mastra?.toolSuspensionWaitingFor === 'user') return;
  // Questions saved before the wait kind was persisted on invocations.
  if (part.toolInvocation.toolName === 'ask_user' || part.toolInvocation.toolName === 'submit_plan') return;
  if (!isCompletedToolOutcome(part as ToolInvocationPart)) return;
  return getToolCompletion(part.providerMetadata);
}

/** Build the display row for one completed call. Stored history keeps the call/result pair untouched. */
export function toolCompletionRow(
  source: MastraDBMessage,
  part: ToolInvocationPart,
  completion: ToolCompletion,
): MastraDBMessage {
  return {
    ...source,
    id: toolCompletionRowId(source.id, part.toolInvocation.toolCallId),
    createdAt: new Date(completion.completedAt),
    content: {
      format: 2,
      parts: [part],
      metadata: {
        toolCompletion: { sourceMessageId: source.id, toolCallId: part.toolInvocation.toolCallId, ...completion },
      },
    },
  };
}

/**
 * Split one assistant message into its source row and one row per completed
 * call. Returns undefined when nothing moves, so callers keep the original row.
 */
export function splitCompletedToolMessage(
  message: MastraDBMessage,
): { source: MastraDBMessage; completed: MastraDBMessage[] } | undefined {
  if (
    message.role !== 'assistant' ||
    !Array.isArray(message.content?.parts) ||
    (message.content.metadata as Record<string, unknown> | undefined)?.toolCompletion
  ) {
    return;
  }
  const remaining: MastraMessagePart[] = [];
  const completed: MastraDBMessage[] = [];
  for (const part of message.content.parts) {
    const completion = displayedToolCompletion(part);
    if (!completion || part.type !== 'tool-invocation') {
      remaining.push(part);
      continue;
    }
    completed.push(toolCompletionRow(message, part, completion));
  }
  if (!completed.length) return;
  // The source row stays (possibly empty) so a row painted earlier under its id is replaced.
  return {
    source: { ...message, content: { ...message.content, parts: remaining, toolInvocations: undefined } },
    completed,
  };
}

/** Display-only rows ordered by time. Stored model history retains the original call/result pair. */
export function projectCompletedToolMessages(messages: MastraDBMessage[]): MastraDBMessage[] {
  const rows: MastraDBMessage[] = [];
  let moved = false;
  for (const message of messages) {
    const split = splitCompletedToolMessage(message);
    if (!split) {
      rows.push(message);
      continue;
    }
    moved = true;
    rows.push(split.source, ...split.completed);
  }
  if (!moved) return rows;
  // Stable sort: rows that share a time keep their stored order.
  return rows
    .map((row, index) => ({ row, index, time: new Date(row.createdAt).getTime() }))
    .sort((a, b) => a.time - b.time || a.index - b.index)
    .map(({ row }) => row);
}

type MessageEvent = Extract<AgentControllerEvent, { type: 'message_start' | 'message_update' | 'message_end' }>;
type MessageDelta = Extract<AgentControllerEvent, { type: 'message_update' }>['event'];

/** One subscriber-facing event; `display: false` rows are transcript rows, never the current answer. */
export type ProjectedMessageEvent = { event: MessageEvent; display: boolean };

/** Fold one compact delta into a message, with the same rules as the display state. */
function foldMessageDelta(message: MastraDBMessage, delta: MessageDelta): void {
  const parts = message.content.parts;
  if (delta.type === 'text-delta') {
    const textIndex = parts.findLastIndex(part => part.type === 'text');
    const textPart = parts[textIndex];
    if (textPart?.type === 'text') parts[textIndex] = { ...textPart, text: textPart.text + delta.delta };
    else parts.push({ type: 'text', text: delta.delta });
  } else if (delta.type === 'reasoning-delta') {
    const reasoningPart = parts[delta.index];
    if (reasoningPart?.type === 'reasoning') {
      const reasoning = reasoningPart.reasoning + delta.delta;
      parts[delta.index] = { ...reasoningPart, reasoning, details: [{ type: 'text', text: reasoning }] };
    }
  } else {
    parts[delta.index] = structuredClone(delta.part);
  }
}

function movedToolCallIds(message: MastraDBMessage): string[] {
  return message.content.parts.flatMap(part =>
    part.type === 'tool-invocation' && displayedToolCompletion(part) ? [part.toolInvocation.toolCallId] : [],
  );
}

function completionRowEvents(rows: MastraDBMessage[]): ProjectedMessageEvent[] {
  return rows.flatMap(message => [
    { event: { type: 'message_start' as const, message }, display: false },
    { event: { type: 'message_end' as const, id: message.id }, display: false },
  ]);
}

/**
 * Live side of the completion display. The run engine publishes one message
 * as a start snapshot plus id-addressed deltas; subscribers must see the same
 * rows a stored read returns. The projector keeps the raw message per id,
 * re-snapshots the source row (a repeated `message_start` replaces it) when a
 * call completes, publishes each completed call as its own settled row, and
 * re-indexes later deltas of the source row past the moved parts.
 */
export class LiveToolCompletionProjector {
  readonly #rows = new Map<string, { raw: MastraDBMessage; moved: string[] }>();

  /** Forget open rows, e.g. when a new run starts. */
  reset(): void {
    this.#rows.clear();
  }

  /** Projected events, or undefined to publish the event unchanged. */
  project(event: AgentControllerEvent): ProjectedMessageEvent[] | undefined {
    if (event.type === 'message_start') return this.#start(event);
    if (event.type === 'message_end') {
      this.#rows.delete(event.id);
      return;
    }
    if (event.type === 'message_update') return this.#update(event);
    return;
  }

  #start(event: Extract<AgentControllerEvent, { type: 'message_start' }>): ProjectedMessageEvent[] | undefined {
    const message = event.message;
    if (message.role !== 'assistant' || !Array.isArray(message.content?.parts)) {
      this.#rows.delete(message.id);
      return;
    }
    if ((message.content.metadata as Record<string, unknown> | undefined)?.toolCompletion) {
      // An already projected completion row (a late outcome): settled, never the current answer.
      this.#rows.delete(message.id);
      return [{ event, display: false }];
    }
    const raw = structuredClone(message);
    const split = splitCompletedToolMessage(raw);
    this.#rows.set(message.id, { raw, moved: movedToolCallIds(raw) });
    if (!split) return;
    return [{ event: { ...event, message: split.source }, display: true }, ...completionRowEvents(split.completed)];
  }

  #update(event: Extract<AgentControllerEvent, { type: 'message_update' }>): ProjectedMessageEvent[] | undefined {
    const tracked = this.#rows.get(event.id);
    if (!tracked) return;
    foldMessageDelta(tracked.raw, event.event);
    const moved = movedToolCallIds(tracked.raw);
    const previous = tracked.moved;
    tracked.moved = moved;
    const split = moved.length ? splitCompletedToolMessage(tracked.raw) : undefined;

    if (moved.length !== previous.length || moved.some((id, index) => id !== previous[index])) {
      // The set of moved calls changed: replace the source row and settle the new completion rows.
      const source = split?.source ?? structuredClone(tracked.raw);
      const fresh = (split?.completed ?? []).filter(row => {
        const toolCallId = (row.content.metadata as { toolCompletion?: { toolCallId?: string } } | undefined)
          ?.toolCompletion?.toolCallId;
        return toolCallId !== undefined && !previous.includes(toolCallId);
      });
      return [
        { event: { type: 'message_start', message: structuredClone(source) }, display: true },
        ...completionRowEvents(fresh),
      ];
    }
    if (!moved.length || event.event.type === 'text-delta') return;

    const rawIndex = event.event.index;
    const rawPart = tracked.raw.content.parts[rawIndex];
    if (rawPart?.type === 'tool-invocation' && moved.includes(rawPart.toolInvocation.toolCallId)) {
      // A settled row changed again: republish that row in place.
      const row = split?.completed.find(
        completed =>
          (completed.content.metadata as { toolCompletion?: { toolCallId?: string } } | undefined)?.toolCompletion
            ?.toolCallId === rawPart.toolInvocation.toolCallId,
      );
      return row ? completionRowEvents([row]) : [];
    }
    const shift = tracked.raw.content.parts
      .slice(0, rawIndex)
      .filter(part => part.type === 'tool-invocation' && moved.includes(part.toolInvocation.toolCallId)).length;
    return [{ event: { ...event, event: { ...event.event, index: rawIndex - shift } }, display: true }];
  }
}
