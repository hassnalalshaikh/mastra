/** Native invocation hook. It is never part of a tool's public input/context. */
export const TOOL_EXECUTION_START = Symbol('mastra.toolExecutionStart');

export type ToolExecutionStartOptions = {
  [TOOL_EXECUTION_START]?: (input: unknown) => Promise<void>;
  abortSignal?: AbortSignal;
};

export function executionStartHook(onStart: (input: unknown) => Promise<void>): ToolExecutionStartOptions {
  let started = false;
  return {
    [TOOL_EXECUTION_START]: async input => {
      if (started) return;
      started = true;
      await onStart(input);
    },
  };
}

/** Called at the innermost executor, after its final validation and policy gate. */
export async function notifyToolExecutionStart(options: ToolExecutionStartOptions | undefined, input: unknown) {
  // Keep the owner's abort reason (an AbortError DOMException when none was given).
  options?.abortSignal?.throwIfAborted();
  await options?.[TOOL_EXECUTION_START]?.(input);
  options?.abortSignal?.throwIfAborted();
}
