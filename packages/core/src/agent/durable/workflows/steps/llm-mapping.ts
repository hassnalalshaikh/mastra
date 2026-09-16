import { z } from 'zod';
import type { PubSub } from '../../../../events/pubsub';
import type { Mastra } from '../../../../mastra';
import { EntityType, SpanType } from '../../../../observability';
import type { ExportedSpan } from '../../../../observability';
import type { ChunkType } from '../../../../stream/types';
import { ChunkFrom } from '../../../../stream/types';
import { PUBSUB_SYMBOL } from '../../../../workflows/constants';
import { createStep } from '../../../../workflows/workflow';
import { MessageList } from '../../../message-list';
import { getToolCompletion, withToolCompletionMetadata } from '../../../message-list/tool-completion';
import { DurableStepIds } from '../../constants';
import { globalRunRegistry } from '../../run-registry';
import { emitChunkEvent } from '../../stream-adapter';
import type {
  DurableLLMStepOutput,
  DurableToolCallOutput,
  DurableAgenticExecutionOutput,
  SerializableDurableState,
} from '../../types';
import { applyToolPayloadTransformToChunk } from '../../utils/apply-tool-payload-transform';
import { rebuildRunToolsFromMastra } from '../../utils/resolve-runtime';
import { normalizeModelOutput } from './normalize-model-output';
import { flushMessagesBeforeSuspension, processChunkThroughOutputProcessors } from './tool-call';

/** Keep the dependency recovery contract in both model and stored tool output. */
function toolErrorOutput(error: NonNullable<DurableToolCallOutput['error']>): string | Record<string, unknown> {
  if (error.name !== 'ToolDependencyError') return error.message;
  return { ...error };
}

function toolErrorText(error: NonNullable<DurableToolCallOutput['error']>): string {
  const output = toolErrorOutput(error);
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Input schema for the durable LLM mapping step.
 * This combines the LLM execution output with tool call results.
 */
const durableLLMMappingInputSchema = z.object({
  llmOutput: z.any(), // DurableLLMStepOutput
  toolResults: z.array(z.any()), // DurableToolCallOutput[]
  runId: z.string(),
  agentId: z.string(),
  messageId: z.string(),
  state: z.any(), // SerializableDurableState
});

/**
 * Output schema for the durable LLM mapping step
 */
const durableLLMMappingOutputSchema = z.object({
  messageListState: z.any(),
  messageId: z.string(),
  stepResult: z.any(),
  toolResults: z.array(z.any()),
  output: z.object({
    text: z.string().optional(),
    toolCalls: z.array(z.any()).optional(),
    usage: z.any(),
    steps: z.array(z.any()),
  }),
  state: z.any(),
  delegationBailed: z.boolean().optional(),
  processorRetryCount: z.number().optional(),
  processorRetryFeedback: z.string().optional(),
});

/**
 * Create a durable LLM mapping step.
 *
 * This step:
 * 1. Takes the LLM execution output and tool call results
 * 2. Updates the message list with tool results
 * 3. Combines everything into the final iteration output
 *
 * This is the "merge" step that combines parallel tool call results
 * back into a single coherent state.
 */
export function createDurableLLMMappingStep() {
  return createStep({
    id: DurableStepIds.LLM_MAPPING,
    inputSchema: durableLLMMappingInputSchema,
    outputSchema: durableLLMMappingOutputSchema,
    execute: async params => {
      const { inputData, mastra, requestContext } = params;
      const {
        llmOutput,
        toolResults: rawToolResults,
        runId: _runId,
        agentId: _agentId,
        messageId,
        state,
      } = inputData as {
        llmOutput: DurableLLMStepOutput;
        toolResults: DurableToolCallOutput[];
        runId: string;
        agentId: string;
        messageId: string;
        state: SerializableDurableState;
      };
      // Match the regular agent: canceled calls stay incomplete and are not results
      // in memory, step events, final processors or completion callbacks.
      const toolResults = rawToolResults.filter(toolResult => !toolResult.aborted);

      // 1. Deserialize message list
      const messageList = new MessageList({
        threadId: state.threadId,
        resourceId: state.resourceId,
      });
      messageList.deserialize(llmOutput.messageListState);

      // This serialized LLM state predates resume-time metadata cleanup. Clear only
      // calls that reached mapping so recall cannot restore an already closed wait.
      for (const toolResult of rawToolResults) {
        const message = messageList.get.all
          .db()
          .findLast(message =>
            message.content.parts.some(
              part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === toolResult.toolCallId,
            ),
          );
        for (const key of ['pendingToolApprovals', 'suspendedTools']) {
          const entries = message?.content.metadata?.[key] as Record<string, { toolCallId?: string }> | undefined;
          if (!entries) continue;
          const remaining = Object.fromEntries(
            Object.entries(entries).filter(
              ([id, entry]) => id !== toolResult.toolCallId && entry?.toolCallId !== toolResult.toolCallId,
            ),
          );
          if (Object.keys(remaining).length === Object.keys(entries).length) continue;
          messageList.updateMessageMetadataByToolCallId(toolResult.toolCallId, {
            [key]: Object.keys(remaining).length ? remaining : undefined,
          });
        }
      }

      // A declined approval has no `result` but is fully resolved: persist it as `output-denied`
      // with the approval decision (rather than as a successful `result`) so it round-trips on
      // recall. Mirrors the non-durable llm-mapping-step.
      const isDeniedApproval = (toolResult: { approval?: { approved?: boolean } }) =>
        toolResult?.approval?.approved === false;

      // 2. Add tool results to message list
      // Look up tools from the in-process registry for toModelOutput support
      let registryEntry = globalRunRegistry.get(_runId);
      if (!registryEntry?.saveQueueManager && state.threadId && mastra) {
        const initData = params.getInitData() as any;
        await rebuildRunToolsFromMastra({
          messageList,
          mastra: mastra as Mastra,
          runId: _runId,
          agentId: _agentId,
          state,
          options: initData?.options ?? {},
          requestContext,
          requestContextEntries: initData?.requestContextEntries,
          logger: (mastra as Mastra)?.getLogger?.(),
        });
        registryEntry = globalRunRegistry.get(_runId);
      }
      const registryTools = registryEntry?.tools;

      // Rebuild the MODEL_STEP span early so MAPPING child spans can nest under it
      let stepSpan:
        | ReturnType<
            NonNullable<
              ReturnType<NonNullable<NonNullable<Mastra['observability']>['getSelectedInstance']>>
            >['rebuildSpan']
          >
        | undefined;
      if (llmOutput.stepSpanData) {
        try {
          const observability = (mastra as Mastra | undefined)?.observability?.getSelectedInstance({ requestContext });
          stepSpan = observability?.rebuildSpan(llmOutput.stepSpanData as ExportedSpan<SpanType.MODEL_STEP>);
        } catch {
          // Span bookkeeping must never break the merge step.
        }
      }

      const alreadyPublishedBackground = new Set<string>();
      if (toolResults.length > 0) {
        for (const toolResult of toolResults) {
          // A fast background job may finish before this serialized dispatch
          // acknowledgement reaches mapping. Preserve its committed output.
          const completed = toolResult.preliminary
            ? registryEntry?.messageList?.get.all
                .db()
                .flatMap(message => message.content.parts)
                .find(
                  part =>
                    part.type === 'tool-invocation' &&
                    part.toolInvocation.toolCallId === toolResult.toolCallId &&
                    getToolCompletion(part.providerMetadata),
                )
            : undefined;
          if (completed?.type === 'tool-invocation') {
            messageList.updateToolInvocation(completed);
            toolResult.providerMetadata = completed.providerMetadata as any;
            toolResult.result = 'result' in completed.toolInvocation ? completed.toolInvocation.result : undefined;
            alreadyPublishedBackground.add(toolResult.toolCallId);
            continue;
          }
          toolResult.providerMetadata = toolResult.preliminary
            ? {
                ...toolResult.providerMetadata,
                mastra: {
                  ...(toolResult.providerMetadata?.mastra as Record<string, unknown> | undefined),
                  toolExecutionPending: true,
                },
              }
            : (withToolCompletionMetadata(toolResult.providerMetadata as any, _runId) as any);
          if (isDeniedApproval(toolResult)) {
            messageList.updateToolInvocation({
              type: 'tool-invocation' as const,
              providerMetadata: toolResult.providerMetadata as any,
              toolInvocation: {
                state: 'output-denied' as const,
                toolCallId: toolResult.toolCallId,
                toolName: toolResult.toolName,
                args: toolResult.args,
                approval: {
                  id: toolResult.approval!.id,
                  approved: false,
                  reason: toolResult.approval!.reason,
                },
              },
            });
            continue;
          }

          const result = toolResult.error ? toolErrorOutput(toolResult.error) : toolResult.result;

          // Compute toModelOutput for successful tool results (Bug 9 parity).
          // Start from the existing providerMetadata so it's preserved even when
          // toModelOutput is absent or fails — otherwise provider-executed tools
          // or tools without a mapper lose their metadata.
          let providerMetadata: Record<string, unknown> | undefined = toolResult.providerMetadata as
            | Record<string, unknown>
            | undefined;
          if (
            !toolResult.error &&
            toolResult.result != null &&
            !toolResult.providerExecuted &&
            !toolResult.modelOutputComputed
          ) {
            const tool = registryTools?.[toolResult.toolName] as
              | { toModelOutput?: (output: unknown) => unknown }
              | undefined;

            if (tool?.toModelOutput) {
              const mappingSpan = stepSpan?.createChildSpan({
                type: SpanType.MAPPING,
                name: `tool output mapping: '${toolResult.toolName}'`,
                entityType: EntityType.TOOL,
                entityId: toolResult.toolName,
                entityName: toolResult.toolName,
                input: toolResult.result,
                attributes: {
                  mappingType: 'toModelOutput',
                  toolCallId: toolResult.toolCallId,
                },
              });
              try {
                let modelOutput = await tool.toModelOutput(toolResult.result);
                modelOutput = normalizeModelOutput(modelOutput);
                mappingSpan?.end({ output: modelOutput });

                // A nullish return means "no special mapping needed" — the raw result is
                // already what the model should see (see read-file.ts / sandboxToModelOutput).
                // Writing the key anyway would make the consumer in MessageList (which keys
                // off presence) override the real result with `undefined`, producing a tool
                // message with no `output`. Mirrors the non-durable llm-mapping-step.
                if (modelOutput != null) {
                  const existingMastra = (toolResult.providerMetadata as any)?.mastra;
                  providerMetadata = {
                    ...toolResult.providerMetadata,
                    mastra: { ...existingMastra, modelOutput },
                  };
                }
              } catch (err) {
                mappingSpan?.error({ error: err as Error, endSpan: true });
                // toModelOutput errors are non-fatal — the tool result is still usable
                (mastra as Mastra | undefined)
                  ?.getLogger?.()
                  ?.warn?.(`[DurableAgent] toModelOutput failed for tool "${toolResult.toolName}": ${err}`);
              }
            }
          }

          toolResult.providerMetadata = providerMetadata as any;
          const resultPart = {
            type: 'tool-invocation' as const,
            toolInvocation: {
              // A tool error must be recorded as `output-error` with the message in
              // `errorText` so the transcript/adapters read it as a failure rather than
              // a normal result. Successful results keep `state: 'result'` + `result`.
              ...(toolResult.error || toolResult.isError
                ? {
                    state: 'output-error' as const,
                    errorText: toolResult.error ? toolErrorText(toolResult.error) : JSON.stringify(result),
                  }
                : { state: 'result' as const, result }),
              toolCallId: toolResult.toolCallId,
              toolName: toolResult.toolName,
              args: toolResult.args,
              // Preserve the approval decision for an approved approval-gated tool so it
              // round-trips on recall as `approval: { approved: true }`.
              ...(toolResult.approval ? { approval: toolResult.approval } : {}),
            },
            ...(providerMetadata ? { providerMetadata: providerMetadata as any } : {}),
          };
          const updated = messageList.updateToolInvocation(resultPart);

          if (!updated) {
            messageList.add(
              [
                {
                  role: 'tool' as const,
                  content: [
                    {
                      type: 'tool-result' as const,
                      toolCallId: toolResult.toolCallId,
                      toolName: toolResult.toolName,
                      result,
                      isError: toolResult.error !== undefined || toolResult.isError === true,
                    },
                  ],
                },
              ],
              'response',
            );
            messageList.updateToolInvocation(resultPart);
          }
        }
      }

      // 2b. Sync the updated messageList back to the in-process registry.
      // The durable workflow deserializes a fresh MessageList on every step,
      // so updates (output-denied, tool results) are invisible to other
      // steps that read from the registry — in particular tool-call.ts's
      // doFlush() which persists messages before suspension. Without this
      // sync, a declined tool's output-denied state would never reach memory
      // if the workflow re-suspends on a subsequent iteration.
      if (registryEntry) {
        registryEntry.messageList = messageList;
      }

      // Commit native memory and the completion index before any terminal outcome is
      // visible. The durable tool step can finish on a different worker or after a
      // cold resume; its serialized output is not yet a saved conversation result.
      const pubsub = (params as any)[PUBSUB_SYMBOL] as PubSub | undefined;
      if (toolResults.length) {
        await flushMessagesBeforeSuspension({
          saveQueueManager: registryEntry?.saveQueueManager,
          messageList,
          memory: registryEntry?.memory,
          threadId: state.threadId,
          resourceId: state.resourceId,
          memoryConfig: state.memoryConfig,
          threadExists: state.threadExists,
          onThreadCreated: () => {
            state.threadExists = true;
          },
        });
        if (pubsub) {
          const logger = (mastra as Mastra | undefined)?.getLogger?.();
          for (const result of toolResults) {
            if (result.providerExecuted || alreadyPublishedBackground.has(result.toolCallId)) continue;
            const source = messageList.get.all
              .db()
              .findLast(message =>
                message.content.parts.some(
                  part => part.type === 'tool-invocation' && part.toolInvocation.toolCallId === result.toolCallId,
                ),
              );
            const payload = {
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              args: result.args,
              messageId: source?.id,
              providerMetadata: result.providerMetadata,
            };
            const chunk = (
              isDeniedApproval(result)
                ? { type: 'tool-output-denied', payload: { ...payload, approval: result.approval } }
                : result.error
                  ? { type: 'tool-error', payload: { ...payload, error: result.error } }
                  : {
                      type: 'tool-result',
                      payload: {
                        ...payload,
                        result: result.result,
                        isError: result.isError,
                        preliminary: result.preliminary,
                      },
                    }
            ) as ChunkType;
            const transformed = await applyToolPayloadTransformToChunk(
              { ...chunk, runId: _runId, from: ChunkFrom.AGENT } as ChunkType,
              { policy: registryEntry?.toolPayloadTransform, tools: registryTools, logger },
            );
            const processed = await processChunkThroughOutputProcessors(
              transformed,
              registryEntry,
              pubsub,
              _runId,
              _agentId,
              logger,
              messageList,
            );
            if (processed) await emitChunkEvent(pubsub, _runId, processed);
          }
        }
      }

      // 3. Determine if we should continue
      // When tool errors occur, always continue the agentic loop so the model
      // can see the error messages (already added to messageList above) and
      // self-correct. This matches the regular agent's behaviour where both
      // ToolNotFoundError and generic tool execution errors are recoverable.
      const hasToolErrors = toolResults.some(r => r.error !== undefined);
      const isContinued = hasToolErrors ? true : llmOutput.stepResult.isContinued;

      // Check if any delegation hook called ctx.bail(). The bail flag is
      // communicated via requestContext because Zod output validation strips
      // unknown fields from the tool result. We read it here and propagate
      // it on the serializable output so the dowhile predicate can stop.
      let delegationBailed = false;
      if (requestContext?.get('__mastra_delegationBailed')) {
        delegationBailed = true;
        requestContext.set('__mastra_delegationBailed', false);
      }

      // 4. Build the output
      const output: DurableAgenticExecutionOutput = {
        messageListState: messageList.serialize(),
        messageId,
        stepResult: {
          ...llmOutput.stepResult,
          isContinued,
        },
        toolResults,
        output: {
          text: llmOutput.text,
          toolCalls: llmOutput.toolCalls,
          usage: llmOutput.stepResult.totalUsage ?? {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          steps: [], // Steps are accumulated at the loop level
        },
        state: {
          ...state,
          threadExists: state.threadExists,
        },
        processorRetryCount: llmOutput.processorRetryCount,
        processorRetryFeedback: llmOutput.processorRetryFeedback,
        delegationBailed,
      };

      // Close the MODEL_STEP span for tool-calling iterations: the LLM step defers it so
      // tool calls can nest under it, and the tools have now run. No-ops without tool calls.
      // The span was already rebuilt earlier so MAPPING child spans could nest under it.
      if (stepSpan) {
        try {
          const pendingPayload = llmOutput.stepFinishPayload as any;
          stepSpan.end({
            output: {
              text: llmOutput.text,
              toolCalls: llmOutput.toolCalls,
            },
            attributes: {
              usage: pendingPayload?.output?.usage,
              finishReason: pendingPayload?.stepResult?.reason,
              isContinued: pendingPayload?.stepResult?.isContinued,
            },
          });
        } catch (error) {
          // Span bookkeeping must never break the merge step.
          (mastra as Mastra | undefined)
            ?.getLogger?.()
            ?.warn?.(`[DurableAgent] Failed to close model_step span: ${error}`);
        }
      }

      // Emit the deferred step-finish chunk for intermediate steps.
      // llm-execution defers step-finish emission for tool-calling steps so that
      // it arrives AFTER committed tool-result chunks (emitted above). This
      // matches the regular agent's chunk ordering which MastraModelOutput
      // relies on for correct step content reconstruction in onStepFinish.
      const deferredChunk = llmOutput.deferredStepFinishChunk as any;
      if (deferredChunk && pubsub) {
        try {
          // Build step content directly from this iteration's data.
          // We cannot rely on messageList.get.response.aiV5.modelContent(-1)
          // because each durable step deserializes a fresh MessageList, so
          // the MastraModelOutput's reference is stale. Instead, construct
          // the content array from the LLM output (text + tool calls) and
          // the tool results collected in this step.
          const stepContent: unknown[] = [];
          if (llmOutput.text) {
            stepContent.push({ type: 'text', text: llmOutput.text });
          }
          for (const tc of llmOutput.toolCalls ?? []) {
            stepContent.push({
              type: 'tool-call',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            });
          }
          for (const tr of toolResults ?? []) {
            stepContent.push({
              type: 'tool-result',
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              result: tr.error ? toolErrorOutput(tr.error) : tr.result,
              ...(tr.error ? { isError: true } : {}),
            });
          }

          const enrichedChunk = {
            ...deferredChunk,
            payload: {
              ...deferredChunk.payload,
              _durableStepContent: stepContent,
            },
          };
          await emitChunkEvent(pubsub, _runId, enrichedChunk);
        } catch (error) {
          (mastra as Mastra | undefined)
            ?.getLogger?.()
            ?.warn?.(`[DurableAgent] Failed to emit deferred step-finish: ${error}`);
        }
      }

      return output;
    },
  });
}
