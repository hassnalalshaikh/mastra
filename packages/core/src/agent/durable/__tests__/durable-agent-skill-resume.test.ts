import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '../../../mastra';
import { SkillSearchProcessor } from '../../../processors';
import { createToolSkillPolicy } from '../../../processors/processors/tool-skill-dependencies';
import { RequestContext } from '../../../request-context';
import { InMemoryStore } from '../../../storage';
import { createTool } from '../../../tools';
import type { Workspace } from '../../../workspace';
import { Agent } from '../../agent';
import { createDurableAgent } from '../create-durable-agent';
import { globalRunRegistry } from '../run-registry';

const marker = 'Use the loaded render instructions for every command.';

async function drain(result: { fullStream: ReadableStream<any> }) {
  const chunks: any[] = [];
  for await (const chunk of result.fullStream) {
    chunks.push(chunk);
    if (chunk.type === 'tool-call-approval') break;
  }
  return chunks;
}

describe('loaded skills across durable approval resumes', () => {
  it.each([
    { cold: false, removed: false },
    { cold: true, removed: false },
    { cold: false, removed: true },
    { cold: true, removed: true },
  ])('uses current skills across approvals (cold=$cold, removed=$removed)', async ({ cold, removed }) => {
    const storage = new InMemoryStore();
    const skills = new Map([['render', { name: 'render', description: 'Render instructions', instructions: marker }]]);
    const workspace = {
      skills: {
        get: vi.fn(async (name: string) => skills.get(name)),
        listNames: async () => [...skills.keys()],
        list: async () => [...skills.values()],
        maybeRefresh: async () => {},
      },
    } as unknown as Workspace;
    const execute = vi.fn(async () => ({ ok: true }));
    const prompts: string[] = [];
    let turn = 0;
    const model = new MockLanguageModelV2({
      doStream: async options => {
        prompts.push(JSON.stringify(options.prompt));
        const index = turn++;
        const call = index < 4;
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            ...(call
              ? [
                  {
                    type: 'tool-call' as const,
                    toolCallId: `call-${index}`,
                    toolName: index === 0 ? 'load_skill' : 'command',
                    input: index === 0 ? JSON.stringify({ skillName: 'render' }) : '{}',
                  },
                ]
              : [
                  { type: 'text-start' as const, id: 'done' },
                  { type: 'text-delta' as const, id: 'done', delta: 'Done.' },
                  { type: 'text-end' as const, id: 'done' },
                ]),
            {
              type: 'finish',
              finishReason: call ? 'tool-calls' : 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]),
          warnings: [],
        };
      },
    });
    const policy = createToolSkillPolicy({ command: ({ phase }) => (phase === 'execute' ? ['render'] : []) });
    const processes: Array<{
      mastra: Mastra;
      agent: ReturnType<typeof createDurableAgent>;
      processor: SkillSearchProcessor;
    }> = [];
    const start = () => {
      const processor = new SkillSearchProcessor({ workspace, trackReadiness: true, ttl: 0 });
      const agent = createDurableAgent({
        agent: new Agent({
          id: 'skill-resume',
          name: 'Skill resume',
          instructions: 'Load render once and run three commands.',
          model,
          inputProcessors: [processor],
          tools: {
            command: createTool({
              id: 'command',
              description: 'Run a command',
              inputSchema: z.object({}),
              requireApproval: true,
              execute,
            }),
          },
        }),
      });
      const mastra = new Mastra({ agents: { agent }, storage, toolPolicy: policy, logger: false });
      const process = { mastra, agent, processor };
      processes.push(process);
      return process;
    };
    let process = start();
    try {
      const result = await process.agent.stream('Run the commands.', {
        requestContext: new RequestContext(),
        maxSteps: 8,
      });
      const first = await drain(result);
      expect(first.at(-1)?.type).toBe('tool-call-approval');
      expect(execute).not.toHaveBeenCalled();
      if (removed) skills.clear();
      for (let command = 1; command <= 3; command++) {
        if (cold) {
          await vi.waitFor(async () =>
            expect((await process.agent.listSuspendedRuns()).runs.some(run => run.runId === result.runId)).toBe(true),
          );
          globalRunRegistry.clear();
          process = start();
        }
        const resumed = await process.agent.approveToolCall({
          runId: result.runId,
          toolCallId: `call-${command}`,
          requestContext: new RequestContext(),
        });
        const chunks = await drain(resumed);
        expect(chunks.filter(chunk => chunk.type === 'tool-error')).toHaveLength(0);
        expect(execute).toHaveBeenCalledTimes(removed ? 0 : command);
        if (removed) expect(JSON.stringify(chunks)).toContain('REQUIRED_SKILL_UNAVAILABLE');
        if (command < 3) expect(chunks.at(-1)?.type).toBe('tool-call-approval');
      }
      expect(turn).toBe(5);
      expect(prompts[1]).toContain(marker);
      for (const prompt of prompts.slice(2)) {
        if (removed) expect(prompt).not.toContain(marker);
        else expect(prompt).toContain(marker);
      }
      expect(prompts.join('\n')).not.toContain('MISSING_REQUIRED_SKILL');
    } finally {
      for (const process of processes.reverse()) {
        process.processor.dispose();
        await process.mastra.shutdown();
      }
      globalRunRegistry.clear();
    }
  });
});
