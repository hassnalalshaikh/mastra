import type { MastraProviderMetadata } from './state/types';

/** Native result-commit metadata, shared by storage and Session display. */
export function withToolCompletionMetadata(metadata?: MastraProviderMetadata, runId?: string): MastraProviderMetadata {
  return {
    ...metadata,
    mastra: {
      ...metadata?.mastra,
      toolExecutionPending: false,
      toolCompletion: { completedAt: new Date().toISOString(), ...(runId ? { runId } : {}) },
    },
  };
}

export function getToolCompletion(
  metadata?: MastraProviderMetadata,
): { completedAt: string; runId?: string } | undefined {
  const value = metadata?.mastra?.toolCompletion;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const completedAt = value.completedAt;
  if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) return;
  return { completedAt, ...(typeof value.runId === 'string' ? { runId: value.runId } : {}) };
}
