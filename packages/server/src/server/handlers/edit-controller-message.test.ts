import { MASTRA_RESOURCE_ID_KEY, MASTRA_THREAD_ID_KEY, RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';
import { EDIT_AGENT_CONTROLLER_MESSAGE_ROUTE } from './agent-controller';

describe('edited conversation route', () => {
  const input = {
    controllerId: 'chat',
    resourceId: 'owner',
    threadId: 'source',
    messageId: 'm1',
    content: 'Corrected',
    newThreadId: '9cf3eac6-dfb6-48cc-bcf5-4c07b4381ead',
    newSessionScope: 'new-scope',
  };
  it('uses trusted ownership and forwards one native edit command', async () => {
    const now = new Date();
    const editMessage = vi.fn().mockResolvedValue({
      id: input.newThreadId,
      resourceId: 'owner',
      title: 'Edited',
      createdAt: now,
      updatedAt: now,
    });
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_RESOURCE_ID_KEY, 'owner');
    requestContext.set(MASTRA_THREAD_ID_KEY, 'source');
    const result = await EDIT_AGENT_CONTROLLER_MESSAGE_ROUTE.handler({
      ...input,
      requestContext,
      mastra: { getAgentController: () => ({ editMessage }) },
      sessionThreadId: 'source',
    } as never);
    expect(result).toMatchObject({ id: input.newThreadId });
    expect(editMessage).toHaveBeenCalledWith({
      resourceId: 'owner',
      sourceThreadId: 'source',
      messageId: 'm1',
      content: 'Corrected',
      newThreadId: input.newThreadId,
      newSessionScope: 'new-scope',
      requestContext,
    });
  });
  it('rejects a source that conflicts with the authenticated thread scope', async () => {
    const editMessage = vi.fn();
    const requestContext = new RequestContext();
    requestContext.set(MASTRA_THREAD_ID_KEY, 'another-thread');
    await expect(
      EDIT_AGENT_CONTROLLER_MESSAGE_ROUTE.handler({
        ...input,
        requestContext,
        mastra: { getAgentController: () => ({ editMessage }) },
      } as never),
    ).rejects.toThrow();
    expect(editMessage).not.toHaveBeenCalled();
  });
  it('requires authentication and the native execute permission', () => {
    expect(EDIT_AGENT_CONTROLLER_MESSAGE_ROUTE.requiresAuth).toBe(true);
    expect(EDIT_AGENT_CONTROLLER_MESSAGE_ROUTE.requiresPermission).toBe('agent-controller:execute');
  });
});
