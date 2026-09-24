import type { StepFlowEntry } from '../..';
import { getEntryId } from '../../step-entry';
import type { RestartExecutionParams } from '../../types';
import { isSingleStepEntry } from '../../utils';
import { FOREACH_QUEUED } from './loop';

/**
 * Completes restart parameters for an evented run that was lost mid-execution.
 *
 * The evented engine records step results as they finish but, unlike the
 * default engine, never records its active position (`activePaths` /
 * `activeStepsPath`) or the running step's input while a run is `running`. A
 * run orphaned by a lost process therefore cannot be restarted from its
 * snapshot as is. The position is recovered from the step graph and the
 * recorded results instead:
 *
 * - the first entry without a finished result is the active entry;
 * - its input is the output of the entry before it (the run input for the
 *   first entry);
 * - for `parallel`, every branch without a finished result is active;
 * - for `foreach`, iterations that were in flight when the process stopped
 *   are queued again, finished iterations are kept.
 *
 * Nested workflows keep their recorded `nestedRunId`, so the processor's
 * nested restart path continues their own runs. Snapshots that already carry
 * an active position are returned unchanged. Positions that cannot be
 * recovered safely (conditional branches, loops, sleeps, or a run whose every
 * entry finished) throw, so the run is left as it is.
 */
export function resolveEventedRestartPosition({
  stepGraph,
  restart,
}: {
  stepGraph: StepFlowEntry[];
  restart: RestartExecutionParams;
}): RestartExecutionParams {
  if (restart.activePaths?.length) {
    return restart;
  }

  const results = { ...(restart.stepResults ?? {}) } as Record<string, any>;
  const finished = (result: any) => result?.status === 'success';
  // Keep the recorded metadata (a nested workflow's `nestedRunId`); drop a
  // stale error or output from an attempt that did not finish.
  const running = (result: any, input: unknown) => ({
    ...(result?.metadata ? { metadata: result.metadata } : {}),
    status: 'running',
    payload: result?.payload ?? input,
    startedAt: result?.startedAt ?? Date.now(),
  });
  let input: unknown = results.input;

  for (let index = 0; index < stepGraph.length; index++) {
    const entry = stepGraph[index]!;

    if (isSingleStepEntry(entry)) {
      const id = getEntryId(entry);
      if (finished(results[id])) {
        input = results[id].output;
        continue;
      }
      results[id] = running(results[id], input);
      return { ...restart, activePaths: [index], activeStepsPath: { [id]: [index] }, stepResults: results };
    }

    if (entry.type === 'parallel') {
      const active: Record<string, number[]> = {};
      const outputs: Record<string, unknown> = {};
      entry.steps.forEach((branch, branchIndex) => {
        const id = getEntryId(branch);
        if (finished(results[id])) {
          outputs[id] = results[id].output;
          return;
        }
        results[id] = running(results[id], input);
        active[id] = [index, branchIndex];
      });
      const activeIds = Object.keys(active);
      if (activeIds.length === 0) {
        input = outputs;
        continue;
      }
      return { ...restart, activePaths: active[activeIds[0]!]!, activeStepsPath: active, stepResults: results };
    }

    if (entry.type === 'foreach') {
      const id = getEntryId(entry.step);
      const result = results[id];
      const items = Array.isArray(result?.payload) ? result.payload : input;
      const output: unknown[] | undefined = Array.isArray(result?.output) ? result.output : undefined;
      // Completion comes from each iteration's recorded status, never from its
      // output value: an iteration that finished with no output is stored as
      // `null`, the same value as an iteration still in flight.
      const iterations: any[] = Array.isArray(result?.suspendPayload?.__workflow_meta?.foreachOutput)
        ? result.suspendPayload.__workflow_meta.foreachOutput
        : [];
      const done = (index: number) => iterations[index]?.status === 'success';
      const suspended = (index: number) =>
        iterations[index]?.status === 'suspended' || (output?.[index] as any)?.status === 'suspended';
      if (
        finished(result) &&
        output &&
        Array.isArray(items) &&
        output.length >= items.length &&
        items.every((_item, itemIndex) => done(itemIndex))
      ) {
        input = output;
        continue;
      }
      results[id] = output
        ? {
            ...result,
            payload: items,
            output: output.map((value, itemIndex) =>
              done(itemIndex) || suspended(itemIndex) ? value : { [FOREACH_QUEUED]: true },
            ),
          }
        : running(result, items);
      return { ...restart, activePaths: [index], activeStepsPath: { [id]: [index] }, stepResults: results };
    }

    throw new Error(
      `Cannot restart this evented run: the position of its active '${entry.type}' entry is not recorded`,
    );
  }

  throw new Error('Cannot restart this evented run: every step already finished');
}
