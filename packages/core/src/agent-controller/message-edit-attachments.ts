import type { AgentSignalContents } from '../agent/signals';
import { ErrorCategory, ErrorDomain, MastraError } from '../error';

type ContentPart = Exclude<AgentSignalContents, string>[number];

/** Provenance attached by Session when it normalizes a submitted file. */
export function attachmentInputOptions(kind: 'file' | 'source', filename?: string) {
  return { mastra: { attachmentInput: { version: 1, kind, ...(filename ? { filename } : {}) } } };
}

/**
 * Select attachment input only; editable user text is never retained.
 * @khayalek-known-mastra-violation KV-AG-004
 */
export function retainedEditAttachments(contents: AgentSignalContents): ContentPart[] {
  if (typeof contents === 'string') return [];
  const marked = (part: ContentPart) => {
    const input = part.providerOptions?.mastra?.attachmentInput;
    return input && typeof input === 'object' && !Array.isArray(input) && input.version === 1 &&
      (input.kind === 'file' || input.kind === 'source');
  };
  // Old Session rows have no marker. Their native normalized file shape and
  // corresponding original source name together identify an attachment.
  // A lone fenced block or an extra ordinary text part is not provenance.
  const sourceLines = new Map<string, string[]>();
  const first = contents[0];
  if (first?.type === 'text' && !marked(first)) {
    for (const match of first.text.matchAll(/^\[Attachment source \d+: ([^\r\n]+); [^;\]\r\n]+\]\(https?:\/\/[^\r\n]+\)[ \t\r]*$/gmu)) {
      const name = match[1]!.replace(/\s+/gu, ' ').trim();
      sourceLines.set(name, [...(sourceLines.get(name) ?? []), match[0].trim()]);
    }
  }
  const retained: ContentPart[] = [];
  const retainedNames = new Set<string>();
  for (let index = 0; index < contents.length; index++) {
    const part = contents[index]!;
    if (part.type === 'file' || marked(part)) {
      retained.push(part);
      if (part.type === 'file' && part.filename) retainedNames.add(part.filename.replace(/\s+/gu, ' ').trim());
      continue;
    }
    if (index === 0 || part.type !== 'text') continue;
    const inline = /^(?:\[File: ([^\r\n]+)\]|\[Attached file\])\n(`{3,})\n[\s\S]*\n\2$/u.exec(part.text);
    if (!inline) continue;
    const name = inline[1]?.replace(/\s+/gu, ' ').trim();
    if (!name || !sourceLines.has(name)) throw new MastraError({
      id: 'AGENT_CONTROLLER_EDIT_UNVERIFIED_ATTACHMENT', domain: ErrorDomain.AGENT,
      category: ErrorCategory.USER, text: 'Attachment provenance could not be verified', details: { status: 409 },
    });
    retained.push({ ...part, providerOptions: { ...part.providerOptions,
      mastra: { ...part.providerOptions?.mastra, ...attachmentInputOptions('file', name).mastra } } });
    retainedNames.add(name);
  }
  for (const name of retainedNames) {
    for (const text of sourceLines.get(name) ?? []) {
      retained.push({ type: 'text', text, providerOptions: attachmentInputOptions('source', name) });
    }
  }
  return retained;
}
