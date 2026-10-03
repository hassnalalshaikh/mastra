import { describe, expect, it } from 'vitest';
import { createSignal } from '../../signals';
import type { MastraDBMessage } from '../../types';
import { MessageList } from '../index';

// Real-time based: addSignal stamps signals after the latest transcript time.
let clock = Date.now() + 60_000;
const nextTime = () => new Date((clock += 1_000));

const user = (id: string, text: string): MastraDBMessage => ({
  id,
  role: 'user',
  content: { format: 2, parts: [{ type: 'text', text }] },
  createdAt: nextTime(),
});

const toolStep = (id: string, toolName: string, result: unknown): MastraDBMessage => ({
  id,
  role: 'assistant',
  content: {
    format: 2,
    parts: [
      {
        type: 'tool-invocation',
        toolInvocation: { state: 'result', toolCallId: `call-${id}`, toolName, args: {}, result },
      },
    ],
  },
  createdAt: nextTime(),
});

const stateSignal = (id: string, stateId: string, text: string) =>
  createSignal({
    id,
    type: 'state',
    tagName: 'state',
    attributes: { type: stateId },
    contents: text,
    metadata: { state: { id: stateId, cacheKey: text, mode: 'snapshot' } },
    createdAt: nextTime(),
  });

const promptText = (message: { role: string; content: unknown }) =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

describe('state signal placement in the model prompt', () => {
  it('reads the current state last when only tool steps followed it, and keeps storage order', () => {
    const list = new MessageList({ threadId: 't', resourceId: 'r' });
    list.add(user('u1', 'open the site and look'), 'input');
    list.add(toolStep('a1', 'browser_goto', { success: true }), 'response');
    list.addSignal(stateSignal('s1', 'browser', 'Browser is open. Active tab URL: https://example.com.'));
    list.add(
      toolStep('a2', 'browser_snapshot', { success: true, snapshot: '- link "Privacy policy" @e1573' }),
      'response',
    );

    const prompt = list.get.all.aiV5.prompt();
    const last = prompt.at(-1)!;
    expect(last.role).toBe('user');
    expect(promptText(last)).toContain('Browser is open. Active tab URL: https://example.com.');
    // The tool steps stay in order, both before the state.
    const toolRoles = prompt.filter(message => message.role === 'tool');
    expect(toolRoles).toHaveLength(2);
    expect(
      prompt.findIndex(message => message.role === 'tool' && promptText(message).includes('browser_snapshot')),
    ).toBeLessThan(prompt.length - 1);
    // Storage keeps the order it was recorded in.
    expect(list.get.all.db().map(message => message.id)).toEqual(['u1', 'a1', 's1', 'a2']);
  });

  it('moves only the newest state of each kind; an older state keeps its place', () => {
    const list = new MessageList({ threadId: 't', resourceId: 'r' });
    list.add(user('u1', 'go'), 'input');
    list.add(toolStep('a1', 'browser_goto', { success: true }), 'response');
    list.addSignal(stateSignal('s1', 'browser', 'Browser URL one.'));
    list.add(toolStep('a2', 'browser_click', { success: true }), 'response');
    list.addSignal(stateSignal('s2', 'browser', 'Browser URL two.'));
    list.add(toolStep('a3', 'browser_snapshot', { success: true }), 'response');

    const texts = list.get.all.aiV5.prompt().map(promptText);
    expect(texts.at(-1)).toContain('Browser URL two.');
    const one = texts.findIndex(text => text.includes('Browser URL one.'));
    const click = texts.findIndex(text => text.includes('browser_click'));
    expect(one).toBeGreaterThan(-1);
    expect(one).toBeLessThan(click);
  });

  it('leaves the prompt alone when the state is already last, or the user spoke after it', () => {
    const first = new MessageList({ threadId: 't', resourceId: 'r' });
    first.add(user('u1', 'go'), 'input');
    first.addSignal(stateSignal('s1', 'browser', 'Browser is open.'));
    expect(promptText(first.get.all.aiV5.prompt().at(-1)!)).toContain('Browser is open.');

    const followUp = new MessageList({ threadId: 't', resourceId: 'r' });
    followUp.add(user('u1', 'go'), 'input');
    followUp.add(toolStep('a1', 'browser_goto', { success: true }), 'response');
    followUp.addSignal(stateSignal('s1', 'browser', 'Browser is open.'));
    followUp.add(toolStep('a2', 'browser_snapshot', { success: true }), 'response');
    followUp.add(user('u2', 'thanks, which site was it?'), 'input');
    const texts = followUp.get.all.aiV5.prompt().map(promptText);
    expect(texts.at(-1)).toContain('thanks, which site was it?');
    expect(texts.findIndex(text => text.includes('Browser is open.'))).toBeLessThan(
      texts.findIndex(text => text.includes('browser_snapshot')),
    );
  });

  it('applies to every prompt path the agent loop uses', async () => {
    const list = new MessageList({ threadId: 't', resourceId: 'r' });
    list.add(user('u1', 'go'), 'input');
    list.add(toolStep('a1', 'browser_goto', { success: true }), 'response');
    list.addSignal(stateSignal('s1', 'browser', 'Browser is open.'));
    list.add(toolStep('a2', 'browser_snapshot', { success: true }), 'response');
    const llmPrompt = await list.get.all.aiV5.llmPrompt();
    expect(llmPrompt.at(-1)!.role).toBe('user');
    expect(JSON.stringify(llmPrompt.at(-1))).toContain('Browser is open.');
    expect(list.get.all.aiV5.model().at(-1)!.role).toBe('user');
  });
});
