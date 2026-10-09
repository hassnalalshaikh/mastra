/** Provenance attached by Session when it normalizes a submitted file. */
export function attachmentInputOptions(kind: 'file' | 'source', filename?: string) {
  return { mastra: { attachmentInput: { version: 1, kind, ...(filename ? { filename } : {}) } } };
}
