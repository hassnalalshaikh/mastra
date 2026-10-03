import type { LanguageModelV2 } from '@ai-sdk/provider-v5';
import { MockLanguageModelV2, convertArrayToReadableStream } from '@internal/ai-sdk-v5/test';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Mastra } from '../../../mastra';
import { MockMemory } from '../../../memory/mock';
import { SkillSearchProcessor } from '../../../processors/processors/skill-search';
import { ToolSearchProcessor } from '../../../processors/processors/tool-search';
import { createToolSkillPolicy } from '../../../processors/processors/tool-skill-dependencies';
import { RequestContext } from '../../../request-context';
import { InMemoryStore } from '../../../storage';
import { createTool } from '../../../tools';
import { Agent } from '../../agent';

type Call = [toolName: string, input: unknown] | undefined;

function scriptedModel(script: Call[], seen: string[][]) {
  return new MockLanguageModelV2({
    doStream: async ({ tools }) => {
      seen.push((tools ?? []).map(tool => tool.name));
      const call = script[seen.length - 1];
      return {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          ...(call
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallType: 'function',
                  toolCallId: `call-${seen.length}`,
                  toolName: call[0],
                  input: JSON.stringify(call[1]),
                },
              ]
            : [
                { type: 'text-start' as const, id: 'text' },
                { type: 'text-delta' as const, id: 'text', delta: 'Done.' },
                { type: 'text-end' as const, id: 'text' },
              ]),
          {
            type: 'finish',
            finishReason: call ? 'tool-calls' : 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      };
    },
  });
}

async function runScenario({
  policyOwner,
  rebuild,
  loadSkill,
}: {
  policyOwner: 'mastra' | 'agent';
  rebuild: boolean;
  loadSkill: boolean;
}) {
  const seen: string[][] = [];
  const execute = vi.fn(async () => ({ created: true }));
  const policy = createToolSkillPolicy({ gen_image: ['image-skill'] });
  const skill = { name: 'image-skill', description: 'Image rules', instructions: 'Image rules.' };
  const genImage = createTool({
    id: 'gen_image',
    description: 'Generate an image',
    inputSchema: z.object({}),
    execute,
  });
  const script: Call[] = [
    // An unknown name sends the durable tool-call step through the Mastra rebuild.
    rebuild ? ['default.gen_image', {}] : ['unrelated', {}],
    ...(loadSkill ? ([['load_skill', { skillName: 'image-skill' }]] as Call[]) : []),
    ['search_tools', { query: 'gen_image generate image' }],
    ...(loadSkill ? ([['gen_image', {}]] as Call[]) : []),
    undefined,
  ];
  const agent = new Agent({
    id: 'live-context-agent',
    name: 'Live context agent',
    instructions: 'Make images.',
    durable: true,
    model: scriptedModel(script, seen) as LanguageModelV2,
    memory: new MockMemory(),
    tools: {
      unrelated: createTool({
        id: 'unrelated',
        description: 'An unrelated helper',
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    },
    inputProcessors: [
      new SkillSearchProcessor({
        workspace: {
          skills: {
            listNames: async () => [skill.name],
            list: async () => [skill],
            get: async (name: string) => (name === skill.name ? skill : undefined),
            maybeRefresh: async () => {},
          },
        } as any,
        trackReadiness: true,
        ttl: 0,
      }),
      new ToolSearchProcessor({
        tools: { gen_image: genImage },
        storage: 'context',
        search: { topK: 4, minScore: 0, autoLoad: true },
        ttl: 0,
      }),
    ],
    ...(policyOwner === 'agent' ? { toolPolicy: policy } : {}),
  });
  const mastra = new Mastra({
    agents: { agent },
    ...(policyOwner === 'mastra' ? { toolPolicy: { resolve: async () => policy } } : {}),
    storage: new InMemoryStore(),
    logger: false,
  });
  try {
    const response = await mastra.getAgent('agent').stream('Make an image.', {
      memory: { thread: 'live-context-thread', resource: 'live-context-user' },
      // A JSON-safe entry lets the rebuild restore a second context object from the snapshot.
      requestContext: new RequestContext([['tenant', 'live-context-tenant']]),
      maxSteps: 8,
    });
    for await (const _chunk of response.fullStream) {
      // drain
    }
  } finally {
    await mastra.shutdown();
  }
  return { seen, script, execute };
}

describe('durable live request context after a tool rebuild', () => {
  const cases = (['mastra', 'agent'] as const).flatMap(policyOwner =>
    [false, true].map(rebuild => ({ policyOwner, rebuild })),
  );

  it.each(cases)(
    'a loaded skill admits the gated tool ($policyOwner policy, rebuild: $rebuild)',
    async ({ policyOwner, rebuild }) => {
      const { seen, script, execute } = await runScenario({ policyOwner, rebuild, loadSkill: true });
      expect(seen).toHaveLength(script.length);
      expect(seen.slice(0, 3).some(tools => tools.includes('gen_image'))).toBe(false);
      // After load_skill + search_tools in the same live run, the model must receive the tool.
      expect(seen[3]).toContain('gen_image');
      expect(execute).toHaveBeenCalledTimes(1);
    },
    30_000,
  );

  it.each(cases)(
    'an unloaded skill keeps the gated tool hidden ($policyOwner policy, rebuild: $rebuild)',
    async ({ policyOwner, rebuild }) => {
      const { seen, script, execute } = await runScenario({ policyOwner, rebuild, loadSkill: false });
      expect(seen).toHaveLength(script.length);
      // The rebuild must not drop the policy (fail-open) and expose the tool without its skill.
      expect(seen.some(tools => tools.includes('gen_image'))).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    },
    30_000,
  );
});

describe('durable direct skill-gated tool', () => {
  it.each(['mastra', 'agent'] as const)(
    'returns to the model after its skill loads ($0 policy)',
    async policyOwner => {
      const seen: string[][] = [];
      const execute = vi.fn(async () => ({ created: true }));
      const policy = createToolSkillPolicy({ gen_image: ['image-skill'] });
      const skill = { name: 'image-skill', description: 'Image rules', instructions: 'Image rules.' };
      const script: Call[] = [['load_skill', { skillName: 'image-skill' }], ['gen_image', {}], undefined];
      const agent = new Agent({
        id: 'direct-gated-agent',
        name: 'Direct gated agent',
        instructions: 'Make images.',
        durable: true,
        model: scriptedModel(script, seen) as LanguageModelV2,
        memory: new MockMemory(),
        // Directly boarded: not behind ToolSearchProcessor.
        tools: {
          gen_image: createTool({
            id: 'gen_image',
            description: 'Generate an image',
            inputSchema: z.object({}),
            execute,
          }),
        },
        inputProcessors: [
          new SkillSearchProcessor({
            workspace: {
              skills: {
                listNames: async () => [skill.name],
                list: async () => [skill],
                get: async (name: string) => (name === skill.name ? skill : undefined),
                maybeRefresh: async () => {},
              },
            } as any,
            trackReadiness: true,
            ttl: 0,
          }),
        ],
        ...(policyOwner === 'agent' ? { toolPolicy: policy } : {}),
      });
      const mastra = new Mastra({
        agents: { agent },
        ...(policyOwner === 'mastra' ? { toolPolicy: { resolve: async () => policy } } : {}),
        storage: new InMemoryStore(),
        logger: false,
      });
      try {
        const response = await mastra.getAgent('agent').stream('Make an image.', {
          memory: { thread: 'direct-gated-thread', resource: 'direct-gated-user' },
          requestContext: new RequestContext([['tenant', 'direct-gated-tenant']]),
          maxSteps: 6,
        });
        for await (const _chunk of response.fullStream) {
          // drain
        }
      } finally {
        await mastra.shutdown();
      }
      expect(seen).toHaveLength(script.length);
      // Hidden until its skill is ready, then visible in the next step of the same run.
      expect(seen[0]).not.toContain('gen_image');
      expect(seen[1]).toContain('gen_image');
      expect(execute).toHaveBeenCalledTimes(1);
    },
    30_000,
  );
});
