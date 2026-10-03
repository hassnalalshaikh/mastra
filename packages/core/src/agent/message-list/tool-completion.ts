import type { MastraDBMessage, MastraMessagePart, MastraProviderMetadata } from './state/types';

type ToolInvocationPart = Extract<MastraMessagePart, { type: 'tool-invocation' }>;

/** Terminal invocation states that close a tool call in the transcript. */
const TERMINAL_TOOL_STATES = new Set(['result', 'output-error', 'output-denied']);

/** Native completion record kept on a committed tool-invocation part. */
export type ToolCompletion = { completedAt: string; runId?: string };

export function getToolCompletion(metadata?: MastraProviderMetadata): ToolCompletion | undefined {
  const value = metadata?.mastra?.toolCompletion;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const completedAt = (value as Record<string, unknown>).completedAt;
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) return;
  const runId = (value as Record<string, unknown>).runId;
  return { completedAt, ...(typeof runId === 'string' ? { runId } : {}) };
}

/**
 * Whether a committed part is a real terminal outcome. A background dispatch
 * placeholder is committed as `result` while its task still runs; it completes
 * only when the task's own result replaces it.
 */
export function isCompletedToolOutcome(part: ToolInvocationPart): boolean {
  if (!TERMINAL_TOOL_STATES.has(part.toolInvocation.state)) return false;
  const mastra = part.providerMetadata?.mastra as Record<string, unknown> | undefined;
  if (mastra?.toolExecutionPending === true) return false;
  const backgroundTask = mastra?.backgroundTask as { status?: unknown } | undefined;
  return !backgroundTask || backgroundTask.status === 'completed' || backgroundTask.status === 'failed';
}

/**
 * Stamp the first terminal commit of a tool call. The time is the part's own
 * native `updatedAt` stamp, so storage and display read one clock. An existing
 * completion is never moved by a later re-merge (processor redaction, replay).
 * Provider-executed calls run inside the model step and stay in their row.
 */
export function stampToolCompletion(part: ToolInvocationPart, runId?: string): void {
  if ((part as { providerExecuted?: boolean }).providerExecuted === true) return;
  if (!isCompletedToolOutcome(part) || getToolCompletion(part.providerMetadata)) return;
  const completedAt = new Date(part.updatedAt ?? Date.now()).toISOString();
  part.providerMetadata = {
    ...part.providerMetadata,
    mastra: {
      ...part.providerMetadata?.mastra,
      toolCompletion: { completedAt, ...(runId ? { runId } : {}) },
    },
  };
}

/**
 * The committed record of one tool call, read back from the transcript after
 * the commit so a published chunk carries exactly what storage holds.
 */
export function findCommittedToolCompletion(
  /** This run's response messages; older turns can reuse a provider's call ids. */
  messages: MastraDBMessage[],
  toolCallId: string,
): { messageId: string; toolCompletion: ToolCompletion; waitingFor?: 'user' | 'external' } | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== 'assistant' || !Array.isArray(message.content?.parts)) continue;
    for (const part of message.content.parts) {
      if (part.type !== 'tool-invocation' || part.toolInvocation.toolCallId !== toolCallId) continue;
      const toolCompletion = getToolCompletion(part.providerMetadata);
      if (!toolCompletion) return undefined;
      const waitingFor = part.providerMetadata?.mastra?.toolSuspensionWaitingFor;
      return {
        messageId: message.id,
        toolCompletion,
        ...(waitingFor === 'user' || waitingFor === 'external' ? { waitingFor } : {}),
      };
    }
  }
  return undefined;
}

/** The newest assistant message holding a tool call, for engines that publish before they commit. */
export function findToolCallMessageId(messages: MastraDBMessage[], toolCallId: string): string | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== 'assistant' || !Array.isArray(message.content?.parts)) continue;
    if (
      message.content.parts.some(
        part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolCallId,
      )
    ) {
      return message.id;
    }
  }
  return undefined;
}

/** Copy a committed completion (and the call's wait kind) onto outgoing metadata, so live == stored. */
export function withCommittedToolCompletion<T extends MastraProviderMetadata | undefined>(
  metadata: T,
  toolCompletion: ToolCompletion,
  waitingFor?: 'user' | 'external',
): MastraProviderMetadata {
  return {
    ...metadata,
    mastra: {
      ...metadata?.mastra,
      toolCompletion,
      ...(waitingFor ? { toolSuspensionWaitingFor: waitingFor } : {}),
    },
  };
}

/** Two-level provider-metadata merge, the same rule a transcript commit applies. */
export function mergeToolProviderMetadata(
  original: MastraProviderMetadata | undefined,
  incoming: MastraProviderMetadata | undefined,
): MastraProviderMetadata | undefined {
  if (!original) return incoming;
  if (!incoming) return original;
  const merged: MastraProviderMetadata = { ...original };
  for (const [namespace, values] of Object.entries(incoming)) {
    const existing = merged[namespace];
    merged[namespace] =
      existing && typeof existing === 'object' && !Array.isArray(existing) && values && typeof values === 'object'
        ? { ...existing, ...values }
        : values;
  }
  return merged;
}
