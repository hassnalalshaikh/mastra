import { expect, it } from 'vitest';
import { Session } from 'official-base-session';
import { AGENT_CONTROLLER_TOOL_APPROVAL_ROUTE, AGENT_CONTROLLER_TOOL_SUSPENSION_ROUTE } from 'official-base-route';

it('official base returns success for stale and consumed approval commands', async () => {
  const session = new Session({id:'proof',ownerId:'owner',resourceId:'user'});
  const controller = {id:'controller',init:async()=>{},createSession:async()=>session};
  const mastra = {getAgentController:()=>controller};
  const settled = session.approval.arm({toolName:'tool',toolCallId:'current'});
  const command = (toolCallId:string) => AGENT_CONTROLLER_TOOL_APPROVAL_ROUTE.handler({mastra,controllerId:'controller',resourceId:'user',toolCallId,approved:true});
  expect(await command('stale')).toEqual({ok:true});
  expect(session.approval.isArmed()).toBe(true);
  expect(await command('current')).toEqual({ok:true});
  expect(await settled).toMatchObject({decision:'approve'});
  expect(await command('current')).toEqual({ok:true});
  expect(session.approval.isArmed()).toBe(false);
});

it('official base returns success for a missing suspension', async () => {
  const session = new Session({id:'proof',ownerId:'owner',resourceId:'user'});
  const controller = {id:'controller',init:async()=>{},createSession:async()=>session};
  const mastra = {getAgentController:()=>controller};
  expect(await AGENT_CONTROLLER_TOOL_SUSPENSION_ROUTE.handler({mastra,controllerId:'controller',resourceId:'user',toolCallId:'missing',resumeData:'answer'})).toEqual({ok:true});
  expect(session.suspensions.hasPending()).toBe(false);
});
