import { toStandardSchema } from '../schema';
import type { PublicSchema } from '../schema';
import { RequestContext } from './index';

/** @internal */
export const REQUEST_CONTEXT_INPUT_SOURCE = Symbol.for('mastra.core.request-context.input-source');
// Runtime metadata only: JSON or RequestContext entries cannot opt into this policy.
const ORIGINAL_SELECTED_CONTEXT = Symbol.for('mastra.core.request-context.original-selected');

/** @internal Saved/build-time nonselected entries must not refill this prepared view. */
export function hasOriginalSelectedContext(context?: RequestContext): boolean {
  return !!originalSelectedKeys(context)?.length;
}

function originalSelectedKeys(context?: RequestContext): readonly string[] | undefined {
  type SelectedContext = RequestContext & { [ORIGINAL_SELECTED_CONTEXT]?: readonly string[] };
  return (
    (context as SelectedContext | undefined)?.[ORIGINAL_SELECTED_CONTEXT] ??
    (getRequestContextInputSource(context) as SelectedContext | undefined)?.[ORIGINAL_SELECTED_CONTEXT]
  );
}

/** @internal Keep native selected execution values when a tool validates the raw input view. */
export function getOriginalSelectedExecutionValues(context?: RequestContext): Record<string, unknown> | undefined {
  const keys = originalSelectedKeys(context);
  return keys?.length ? selectedEntries(context, keys) : undefined;
}

type RequestContextWithInputSource = RequestContext & {
  [REQUEST_CONTEXT_INPUT_SOURCE]?: RequestContext;
};

/**
 * Returns the input-form context that schema validation should consume.
 *
 * Schema-transformed execution views retain their source through a global
 * symbol so forwarding a view across tools or duplicated module instances does
 * not validate already-decoded values again.
 *
 * @internal
 */
export function getRequestContextInputSource(requestContext?: RequestContext): RequestContext | undefined {
  let current = requestContext as RequestContextWithInputSource | undefined;
  const seen = new Set<RequestContext>();

  while (current && !seen.has(current)) {
    seen.add(current);
    const source = current[REQUEST_CONTEXT_INPUT_SOURCE];
    if (!source) {
      return current;
    }
    current = source as RequestContextWithInputSource;
  }

  return current;
}

/** @internal */
export function getRequestContextInputValues(requestContext?: RequestContext): Record<string, any> {
  return getRequestContextInputSource(requestContext)?.all ?? {};
}

/** @internal Original selected values stored on a native durable run. */
export interface ResumeRequestContextSnapshot {
  resumeRequestContextKeys?: readonly string[];
  resumeRequestContextInputEntries?: Record<string, unknown>;
  requestContextEntries?: Record<string, unknown>;
}

/** @internal Do not downgrade a missing original binding to a runtime fallback. */
export class ResumeRequestContextError extends Error {
  constructor() {
    super('Durable resume requires complete original selected request context.');
    this.name = 'ResumeRequestContextError';
  }
}

/** @internal Copy the policy so a caller cannot change it after configuration. */
export function validateResumeRequestContextKeys(keys: readonly string[] = []): readonly string[] {
  if (!Array.isArray(keys)) throw new ResumeRequestContextError();
  const result = [...keys];
  if (
    result.some(
      key =>
        typeof key !== 'string' ||
        !key ||
        key.startsWith('mastra__') ||
        key === 'MastraMemory' ||
        key === 'controller' ||
        key === 'organizationId',
    ) ||
    new Set(result).size !== result.length
  )
    throw new ResumeRequestContextError();
  return Object.freeze(result);
}

// Each selected raw or completed map is bounded separately (32 MiB combined).
const MAX_SELECTED_CONTEXT_BYTES = 16 * 1024 * 1024;

// Selected values are required data, unlike the best-effort unselected snapshot.
// Walk descriptors without running accessors/toJSON and reject every JSON omission.
function copySelectedJSON(value: unknown): unknown {
  let budget = MAX_SELECTED_CONTEXT_BYTES;
  const ancestors = new Set<object>();
  const copy = (item: unknown): unknown => {
    if (--budget < 0) throw new ResumeRequestContextError();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      budget -= item.length;
      if (budget < 0) throw new ResumeRequestContextError();
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || !item || ancestors.has(item)) throw new ResumeRequestContextError();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new ResumeRequestContextError();
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).length) throw new ResumeRequestContextError();
      const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'));
      if (array && (keys.length !== (item as unknown[]).length || keys.some((key, index) => key !== String(index)))) {
        throw new ResumeRequestContextError();
      }
      const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
      for (const key of keys.sort(array ? undefined : (a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !('value' in descriptor)) throw new ResumeRequestContextError();
        budget -= key.length;
        if (budget < 0) throw new ResumeRequestContextError();
        Object.defineProperty(result, key, {
          value: copy(descriptor.value),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };
  let result: unknown;
  try {
    result = copy(value);
  } catch {
    throw new ResumeRequestContextError();
  }
  // Bound encoded bytes too, including escape expansion; no custom serializer.
  const encoded = JSON.stringify(result);
  if (
    encoded.length > MAX_SELECTED_CONTEXT_BYTES ||
    new TextEncoder().encode(encoded).byteLength > MAX_SELECTED_CONTEXT_BYTES
  )
    throw new ResumeRequestContextError();
  return result;
}

function selectedEntries(context: RequestContext | undefined, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!context?.has(key)) throw new ResumeRequestContextError();
    Object.defineProperty(result, key, {
      value: copySelectedJSON(context.getRaw(key)),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copySelectedJSON(result) as Record<string, unknown>;
}

/** @internal Validate before defaults, retaining the original input representation. */
export function captureResumeRequestContext(
  context: RequestContext | undefined,
  keys: readonly string[],
): ResumeRequestContextSnapshot | undefined {
  if (!keys.length) return undefined;
  const policy = validateResumeRequestContextKeys(keys);
  return {
    resumeRequestContextKeys: policy,
    resumeRequestContextInputEntries: selectedEntries(getRequestContextInputSource(context), policy),
    requestContextEntries: selectedEntries(context, policy),
  };
}

/** @internal Capture completed initial execution values, retaining the original raw input. */
export function finalizeResumeRequestContext(
  context: RequestContext,
  original: ResumeRequestContextSnapshot,
): ResumeRequestContextSnapshot {
  return { ...original, requestContextEntries: selectedEntries(context, original.resumeRequestContextKeys ?? []) };
}

/** @internal Saved selected execution values cannot change during a resumed preparation. */
export function assertResumeRequestContext(context: RequestContext, original?: ResumeRequestContextSnapshot): void {
  if (!original?.resumeRequestContextKeys?.length) return;
  const current = selectedEntries(context, original.resumeRequestContextKeys);
  const saved = selectedEntries(
    new RequestContext(Object.entries(original.requestContextEntries ?? {})),
    original.resumeRequestContextKeys,
  );
  if (JSON.stringify(current) !== JSON.stringify(saved)) throw new ResumeRequestContextError();
}

/** @internal Validation-only: a schema cannot replace or transform the saved binding. */
export async function validateResumeRequestContextSchema(
  original: ResumeRequestContextSnapshot | undefined,
  schema?: PublicSchema<Record<string, unknown>>,
): Promise<void> {
  if (!schema) return;
  if (!original?.resumeRequestContextKeys?.length) throw new ResumeRequestContextError();
  const entries = selectedEntries(
    new RequestContext(Object.entries(original.requestContextEntries ?? {})),
    original.resumeRequestContextKeys,
  );
  try {
    const result = await toStandardSchema(schema)['~standard'].validate(entries);
    if (result.issues) throw new ResumeRequestContextError();
  } catch {
    throw new ResumeRequestContextError();
  }
}

function readSavedSelectedContext(
  original: ResumeRequestContextSnapshot,
  requiredKeys?: readonly string[],
): { keys: readonly string[]; execution: Record<string, unknown>; input: Record<string, unknown> } {
  const keys = validateResumeRequestContextKeys(original.resumeRequestContextKeys);
  // A changed configuration cannot broaden or shrink the original restore authority.
  // Internal propagation omits this argument only after the native admission check.
  if (
    !keys.length ||
    (requiredKeys && (keys.length !== requiredKeys.length || requiredKeys.some(key => !keys.includes(key))))
  )
    throw new ResumeRequestContextError();
  const savedExecution = Object.create(null) as Record<string, unknown>;
  const savedInput = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const executionValue = Object.getOwnPropertyDescriptor(original.requestContextEntries ?? {}, key);
    const inputValue = Object.getOwnPropertyDescriptor(original.resumeRequestContextInputEntries ?? {}, key);
    if (
      !executionValue?.enumerable ||
      !('value' in executionValue) ||
      !inputValue?.enumerable ||
      !('value' in inputValue)
    )
      throw new ResumeRequestContextError();
    savedExecution[key] = executionValue.value;
    savedInput[key] = inputValue.value;
  }
  return {
    keys,
    execution: copySelectedJSON(savedExecution) as Record<string, unknown>,
    input: copySelectedJSON(savedInput) as Record<string, unknown>,
  };
}

/** @internal Reuse a restored native view only while both selected representations remain original. */
export function assertRestoredResumeRequestContext(
  context: RequestContext,
  original: ResumeRequestContextSnapshot,
): void {
  const markedKeys = originalSelectedKeys(context);
  if (!markedKeys?.length) throw new ResumeRequestContextError();
  const saved = readSavedSelectedContext(original, validateResumeRequestContextKeys(markedKeys));
  if (
    JSON.stringify(selectedEntries(context, saved.keys)) !== JSON.stringify(saved.execution) ||
    JSON.stringify(selectedEntries(getRequestContextInputSource(context), saved.keys)) !== JSON.stringify(saved.input)
  )
    throw new ResumeRequestContextError();
}

/** @internal Restore selected originals only; all other current values and absences win. */
export function restoreResumeRequestContext(
  original: ResumeRequestContextSnapshot,
  current?: RequestContext,
  requiredKeys?: readonly string[],
): RequestContext {
  const { keys, execution: clonedExecution, input: clonedInput } = readSavedSelectedContext(original, requiredKeys);
  const execution = new RequestContext(current?.entries());
  const input = new RequestContext(getRequestContextInputSource(current)?.entries());
  for (const key of keys) {
    execution.set(key, clonedExecution[key]);
    input.set(key, clonedInput[key]);
  }
  Object.defineProperty(execution, REQUEST_CONTEXT_INPUT_SOURCE, { value: input });
  Object.defineProperty(execution, ORIGINAL_SELECTED_CONTEXT, { value: keys });
  Object.defineProperty(input, ORIGINAL_SELECTED_CONTEXT, { value: keys });
  return execution;
}
