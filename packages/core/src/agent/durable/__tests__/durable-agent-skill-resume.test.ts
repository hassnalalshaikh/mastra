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
  it.each(
    [
      { cold: false, removed: false },
      { cold: true, removed: false },
      { cold: false, removed: true },
      { cold: true, removed: true },
    ].flatMap(options => [
      { ...options, selectedContext: false },
      { ...options, selectedContext: true },
    ]),
  )(
    'uses current skills across approvals (cold=$cold, removed=$removed, selected=$selectedContext)',
    async ({ cold, removed, selectedContext }) => {
      const storage = new InMemoryStore();
      const skills = new Map([
        ['render', { name: 'render', description: 'Render instructions', instructions: marker }],
      ]);
      const workspace = {
        skills: {
          get: vi.fn(async (name: string) => skills.get(name)),
          listNames: async () => [...skills.keys()],
          list: async () => [...skills.values()],
          maybeRefresh: async () => {},
        },
      } as unknown as Workspace;
      const execute = vi.fn(async () => ({ ok: true }));
      const modelViews: Array<{ choice: unknown; permission: unknown }> = [];
      const toolViews: Array<{ choice: unknown; permission: unknown }> = [];
      let currentPermission = 'permission-initial';
      const changedModelDispatch = vi.fn(async () => {
        throw new Error('Incoming model choice must not replace the saved model');
      });
      const changedModel = new MockLanguageModelV2({ doStream: changedModelDispatch });
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
          ...(selectedContext
            ? {
                resumeRequestContextKeys: ['modelChoice'],
                resumeRequestContextSchema: z.object({ modelChoice: z.literal('model-a') }),
              }
            : {}),
          agent: new Agent({
            id: 'skill-resume',
            name: 'Skill resume',
            instructions: 'Load render once and run three commands.',
            model: selectedContext
              ? ({ requestContext }) => {
                  const choice = requestContext.get('modelChoice');
                  const permission = requestContext.get('currentPermission');
                  modelViews.push({ choice, permission });
                  expect(permission).toBe(currentPermission);
                  return choice === 'model-a' ? model : changedModel;
                }
              : model,
            inputProcessors: [processor],
            tools: {
              command: createTool({
                id: 'command',
                description: 'Run a command',
                inputSchema: z.object({}),
                requireApproval: true,
                execute: selectedContext
                  ? async (_input, context) => {
                      const choice = context?.requestContext?.get('modelChoice');
                      const permission = context?.requestContext?.get('currentPermission');
                      toolViews.push({ choice, permission });
                      expect(choice).toBe('model-a');
                      expect(permission).toBe(currentPermission);
                      return execute();
                    }
                  : execute,
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
          requestContext: selectedContext
            ? new RequestContext([
                ['modelChoice', 'model-a'],
                ['currentPermission', currentPermission],
              ])
            : new RequestContext(),
          maxSteps: 8,
        });
        const first = await drain(result);
        expect(first.at(-1)?.type).toBe('tool-call-approval');
        expect(execute).not.toHaveBeenCalled();
        if (removed) skills.clear();
        for (let command = 1; command <= 3; command++) {
          currentPermission = `permission-current-${command}`;
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
            requestContext: selectedContext
              ? new RequestContext([
                  ['modelChoice', 'model-b'],
                  ['currentPermission', currentPermission],
                ])
              : new RequestContext(),
          });
          const chunks = await drain(resumed);
          expect(chunks.filter(chunk => chunk.type === 'tool-error')).toHaveLength(0);
          expect(execute).toHaveBeenCalledTimes(removed ? 0 : command);
          if (selectedContext) {
            expect(modelViews).toContainEqual({ choice: 'model-a', permission: currentPermission });
            expect(changedModelDispatch).not.toHaveBeenCalled();
            if (!removed) expect(toolViews.at(-1)).toEqual({ choice: 'model-a', permission: currentPermission });
          }
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
        if (selectedContext) {
          expect(modelViews.every(view => view.choice === 'model-a')).toBe(true);
          expect(toolViews).toHaveLength(removed ? 0 : 3);
        }
      } finally {
        for (const process of processes.reverse()) {
          process.processor.dispose();
          await process.mastra.shutdown();
        }
        globalRunRegistry.clear();
      }
    },
  );
});
