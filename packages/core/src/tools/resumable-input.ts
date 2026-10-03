import { isDeepStrictEqual } from 'node:util';
import { decode, encode } from '../events/codec/codec';

/** Internal, per-invocation state. Never included in a tool's public context or transcript. */
export const TOOL_INPUT_STATE = Symbol('mastra.toolInputState');

export type AcceptedToolInput = { encoded: string; toolName?: string; toolCallId?: string };

export interface ToolInputState {
  accepted?: AcceptedToolInput;
  captureError?: unknown;
}

export interface ToolInputOptions {
  [TOOL_INPUT_STATE]?: ToolInputState;
}

export function createToolInputState(suspendData: unknown, toolCallId?: string): ToolInputState {
  const accepted = (suspendData as { __mastraToolInput?: AcceptedToolInput } | undefined)?.__mastraToolInput;
  // An engine can hand every parallel call the step's suspend data. Saved input
  // belongs only to the invocation that recorded it.
  if (accepted?.toolCallId && toolCallId && accepted.toolCallId !== toolCallId) return {};
  return { accepted: accepted ? { ...accepted } : undefined };
}

export function captureToolInput(
  options: ToolInputOptions | undefined,
  input: unknown,
  identity?: { toolName: string; toolCallId?: string },
): void {
  const state = options?.[TOOL_INPUT_STATE];
  if (state?.accepted && identity) state.accepted = { ...state.accepted, ...identity };
  if (state && !state.accepted) {
    try {
      // Use the native codec so Date, Map, Set and explicit undefined survive
      // JSON-backed workflow stores too. A string prevents a transport codec
      // from decoding this snapshot before the tool is resumed.
      const encoded = JSON.stringify(encode(input));
      if (!isDeepStrictEqual(input, decode(JSON.parse(encoded)))) {
        throw new Error('Tool input contains values that cannot survive native snapshot storage.');
      }
      state.accepted = { encoded, ...identity };
    } catch (error) {
      // Non-suspending tools are not subject to snapshot persistence constraints.
      state.captureError = error;
    }
  }
}

export function persistedToolInput(
  state: ToolInputState,
  invocation?: { toolName: string; toolCallId: string },
): AcceptedToolInput | undefined {
  if (state.captureError) throw new Error('Cannot persist suspended tool input', { cause: state.captureError });
  // The builder records the tool's own name; the saved identity is the agent's
  // invocation (its tool key and call id), which is what a resume matches on.
  return state.accepted && invocation ? { ...state.accepted, ...invocation } : state.accepted;
}

export function restoreToolInput(
  options: (ToolInputOptions & { toolCallId?: string }) | undefined,
  rawInput: unknown,
  delegated = false,
): unknown {
  const accepted = options?.[TOOL_INPUT_STATE]?.accepted;
  if (!accepted) return rawInput; // Snapshots written before accepted input was persisted.
  // Saved input belongs to exactly one invocation. An engine that hands this
  // call another call's suspend data must not swap that call's input in.
  if (accepted.toolCallId && options?.toolCallId && accepted.toolCallId !== options.toolCallId) return rawInput;
  const input = decode(JSON.parse(accepted.encoded));
  // Delegation routing is supplied by the current native resume, not by the
  // original invocation. Keep it separate from the saved tool input.
  if (
    delegated &&
    input &&
    typeof input === 'object' &&
    rawInput &&
    typeof rawInput === 'object' &&
    'suspendedToolRunId' in rawInput
  ) {
    return { ...input, suspendedToolRunId: rawInput.suspendedToolRunId };
  }
  return input;
}
