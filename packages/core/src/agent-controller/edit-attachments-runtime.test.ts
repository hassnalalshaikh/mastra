import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { Memory } from '../../../memory/src';
import { Agent } from '../agent';
import { createDurableAgent } from '../agent/durable';
import type { MastraDBMessage } from '../agent/message-list';
import { Mastra } from '../mastra';
import { InMemoryStore } from '../storage';
import { MastraLanguageModelV2Mock } from '../test-utils/llm-mock';
import { AgentController } from './agent-controller';
import rows from './edit-attachment-fixture.json';

// Real native Session, signal persistence, subscription and run. Deterministic
// model only; no provider, old tool, billing, browser or hosted write is used.
it.each([false, true])('native edit retains all five real formats with earlier history=%s', async withEarlier => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Network forbidden'); });
  const storage = new InMemoryStore({ id: randomUUID() });
  const memory = new Memory({ storage, options: { generateTitle: false, semanticRecall: false, observationalMemory: false } });
  const calls = vi.fn(async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] });
    stream.enqueue({ type: 'text-start', id: 'answer' });
    stream.enqueue({ type: 'text-delta', id: 'answer', delta: 'Edited.' });
    stream.enqueue({ type: 'text-end', id: 'answer' });
    stream.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    stream.close();
  } }) }));
  const agent = createDurableAgent({ agent: new Agent({ id: 'edit-attachment-proof', name: 'Edit proof', instructions: 'Answer.',
    memory, maxRetries: 0, model: new MastraLanguageModelV2Mock({ supportedUrls: { '*': [/^http/u] }, doStream: calls }) }) });
  const controller = new AgentController({ id: 'edit-controller', agent, storage, memory,
    modes: [{ id: 'chat', name: 'Chat', default: true }],
    disableBuiltinTools: ['ask_user', 'submit_plan', 'task_write', 'task_update', 'task_complete', 'task_check', 'subagent'] });
  const mastra = new Mastra({ agents: { agent }, agentControllers: { controller }, storage, logger: false,
    workers: false, scheduler: { enabled: false }, recovery: { durableAgents: 'off' } });
  const resourceId = 'owner', sourceThreadId = randomUUID(), newThreadId = randomUUID();
  const original = { ...rows[0], threadId: sourceThreadId, resourceId, createdAt: new Date(rows[0]!.createdAt) } as unknown as MastraDBMessage;
  try {
    await controller.init();
    await memory.createThread({ threadId: sourceThreadId, resourceId });
    const prior: MastraDBMessage[] = withEarlier ? [{ id: randomUUID(), role: 'user', threadId: sourceThreadId, resourceId,
      createdAt: new Date(original.createdAt.getTime() - 1), content: { format: 2, parts: [{ type: 'text', text: 'Earlier text.' }] } }] : [];
    await memory.saveMessages({ messages: [...prior, original] });
    const sourceBefore = await memory.recall({ threadId: sourceThreadId, resourceId, perPage: false });
    await controller.editMessage({ resourceId, sourceThreadId, messageId: original.id, content: 'Corrected.', newThreadId, newSessionScope: newThreadId });
    const edited = await controller.getSessionByResource(resourceId, newThreadId);
    expect(edited).toBeDefined();
    await vi.waitFor(async () => {
      const saved = (await memory.recall({ threadId: newThreadId, resourceId, perPage: false })).messages;
      expect(saved.some(row => row.role === 'assistant')).toBe(true);
      expect(edited!.displayState.get().isRunning).toBe(false);
    });
    const after = (await memory.recall({ threadId: newThreadId, resourceId, perPage: false })).messages;
    const replacement = after.find(row => row.role === 'signal' && row.content.parts.some(part => part.type === 'text' && part.text === 'Corrected.'))!;
    expect(replacement).toBeDefined();
    const text = JSON.stringify(replacement.content.parts);
    for (const marker of ['DOCUMENT-ONE', 'PRESENTATION-ONE', 'SHEET-ONE', 'TEXT-ONE']) expect(text).toContain(marker);
    expect(replacement.content.parts.filter(part => part.type === 'file')).toHaveLength(1);
    expect(replacement.content.parts.filter(part => part.type === 'text' && part.text.startsWith('[Attachment source '))).toHaveLength(5);
    expect(text).not.toContain('Harmless attachment test.');
    expect((await memory.recall({ threadId: sourceThreadId, resourceId, perPage: false })).messages).toEqual(sourceBefore.messages);
    expect(after.filter(row => row.content.parts.some(part => part.type === 'text' && part.text === 'Earlier text.'))).toHaveLength(withEarlier ? 1 : 0);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
  } finally { await mastra.shutdown(); network.mockRestore(); }
});

it('native Session stores and re-edits marked unnamed text with audio/video source parts', async () => {
  const storage = new InMemoryStore({ id: randomUUID() });
  const memory = new Memory({ storage, options: { generateTitle: false, semanticRecall: false, observationalMemory: false } });
  const calls = vi.fn(async () => ({ stream: new ReadableStream({ start(stream) {
    stream.enqueue({ type: 'stream-start', warnings: [] });
    stream.enqueue({ type: 'text-start', id: 'answer' }); stream.enqueue({ type: 'text-delta', id: 'answer', delta: 'Done.' });
    stream.enqueue({ type: 'text-end', id: 'answer' });
    stream.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); stream.close();
  } }) }));
  const agent = createDurableAgent({ agent: new Agent({ id: 'fresh-proof', name: 'Fresh proof', instructions: 'Answer.', memory,
    model: new MastraLanguageModelV2Mock({ doStream: calls }), maxRetries: 0 }) });
  const controller = new AgentController({ id: 'fresh-controller', agent, storage, memory, modes: [{ id: 'chat', name: 'Chat', default: true }] });
  const mastra = new Mastra({ agents: { agent }, agentControllers: { controller }, storage, logger: false,
    workers: false, scheduler: { enabled: false }, recovery: { durableAgents: 'off' } });
  const resourceId = 'owner', threadId = randomUUID(), editedId = randomUUID();
  try {
    await controller.init();
    const session = await controller.createSession({ resourceId, threadId, scope: threadId });
    const source = '[Referenced audio 1: voice](https://example.test/voice.mp3)\n\n[Referenced video 1: clip](https://example.test/clip.mp4)';
    await session.sendMessage({ content: 'Old editable text.', files: [{ data: 'data:text/plain;base64,Qm9keQ==', mediaType: 'text/plain', source }] });
    const before = (await memory.recall({ threadId, resourceId, perPage: false })).messages;
    const original = before.find(row => row.role === 'signal')!;
    expect(original.content.parts.filter(part => part.type === 'text' && part.providerMetadata?.mastra?.attachmentInput)).toHaveLength(2);
    await controller.editMessage({ resourceId, sourceThreadId: threadId, messageId: original.id,
      content: 'Changed text.', newThreadId: editedId, newSessionScope: editedId });
    await vi.waitFor(async () => expect((await memory.recall({ threadId: editedId, resourceId, perPage: false })).messages.some(row => row.role === 'assistant')).toBe(true));
    const saved = (await memory.recall({ threadId: editedId, resourceId, perPage: false })).messages;
    const replacement = saved.find(row => row.role === 'signal')!;
    expect(JSON.stringify(replacement.content.parts)).toContain('Body');
    expect(JSON.stringify(replacement.content.parts)).toContain(source.replaceAll('\n', '\\n'));
    expect(JSON.stringify(replacement.content.parts)).not.toContain('Old editable text.');
    expect((await memory.recall({ threadId, resourceId, perPage: false })).messages).toEqual(before);
    expect(calls).toHaveBeenCalledTimes(2);
  } finally { await mastra.shutdown(); }
});
