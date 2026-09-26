import { mastraDBMessageToSignal } from '../../signals';
import type { MastraDBMessage } from '../state/types';

const signalType = (message: MastraDBMessage): string | undefined => {
  const signal = message.content.metadata?.signal;
  if (signal && typeof signal === 'object' && !Array.isArray(signal)) {
    const type = (signal as Record<string, unknown>).type;
    if (typeof type === 'string') return type;
  }
  return message.type;
};

const isStateSignal = (message: MastraDBMessage) =>
  (message.role as string) === 'signal' && signalType(message) === 'state';

/** A turn the user started: a user message, or a user-message signal. */
const isUserTurn = (message: MastraDBMessage) => {
  if (message.role === 'user') return true;
  if ((message.role as string) !== 'signal') return false;
  const type = signalType(message);
  return type === 'user' || type === 'user-message';
};

const stateKey = (message: MastraDBMessage): string => {
  const signal = mastraDBMessageToSignal(message);
  const state = (signal.metadata as { state?: { id?: unknown } } | undefined)?.state;
  return typeof state?.id === 'string' ? state.id : (signal.tagName ?? 'state');
};

/**
 * Model prompt order for state signals (browser, task list, goal ...).
 *
 * A state signal describes the current state and is stored where it was recorded: at the start of
 * the step that first saw that state. When the following steps of the same run only add tool calls
 * and results, the prompt ends on a tool result with the user-role state message several turns
 * earlier. Gemini 3 Flash (through OpenRouter) then returns an empty reply every time for some short
 * tool results; the same request with the state message last does not.
 *
 * In the model prompt only (storage, recall and the transcript keep their order), the newest state
 * signal of each state that comes after the user's latest turn and is followed only by assistant
 * messages moves to the end, so the model reads the current state last. Earlier state signals and
 * any signal before the user's latest turn keep their place.
 */
export function moveCurrentStateSignalsToPromptEnd(messages: MastraDBMessage[]): MastraDBMessage[] {
  let lastUserTurn = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isUserTurn(messages[index]!)) {
      lastUserTurn = index;
      break;
    }
  }

  const newestByState = new Map<string, number>();
  for (let index = lastUserTurn + 1; index < messages.length; index++) {
    if (isStateSignal(messages[index]!)) newestByState.set(stateKey(messages[index]!), index);
  }
  if (newestByState.size === 0) return messages;

  const moving = new Set<number>();
  for (const index of newestByState.values()) {
    const later = messages.slice(index + 1);
    // Only past tool steps of this run: nothing a user said, and at least one assistant message.
    if (
      later.some(message => message.role === 'assistant') &&
      later.every(message => message.role === 'assistant' || isStateSignal(message))
    )
      moving.add(index);
  }
  if (moving.size === 0) return messages;

  return [...messages.filter((_, index) => !moving.has(index)), ...messages.filter((_, index) => moving.has(index))];
}
