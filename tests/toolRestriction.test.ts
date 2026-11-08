import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { bindScopeParent, scopeOf } from '@deepseek-ai/dsh-scope';
import { hostFixture, textResponse } from './hostFixture.ts';
import { registerScopedTool } from '../src/worldScope.ts';
import { hideGlobalTools } from '../src/life/toolRegistry.ts';

const probe = (name: string) => defineTool({
  name, description: `${name} probe`, parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  execute: async () => 'ok',
});

test('a restriction hides the named global tools alone, and lifts exactly', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, async function* (request): AsyncIterable<StreamChunk> {
    requests.push(request);
    yield* textResponse('ok');
  });
  const { agent } = await ctx.agents.create({ sessionId: SessionId('restrict'), agentOptions: { provider: 'test', model: 'test' } });
  if (!('restrict' in agent.ctx.tools)) { t.skip('tool restrictions belong to a later DSH'); return; }
  cleanup.push(ctx.tools.register(probe('global_probe')));
  cleanup.push(registerScopedTool(agent, probe('scoped_probe'), () => true));
  const ask = async () => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }));
    await agent.whenIdle();
  };
  const visible = (index: number, name: string) => requests[index].tools?.some(tool => tool.name === name) ?? false;

  await ask();
  assert.equal(visible(0, 'global_probe'), true, 'the global tool starts visible');

  // A name this host does not have must not turn the call into a throw.
  const lift = hideGlobalTools(agent, ['global_probe', 'no_such_tool']);
  await ask();
  assert.equal(visible(1, 'global_probe'), false, 'the named global tool is hidden');
  assert.equal(visible(1, 'scoped_probe'), true, 'a scoped registration is untouched');

  lift();
  await ask();
  assert.equal(visible(2, 'global_probe'), true, 'lifting the restriction brings it back');
});

test('a restriction reads the agent scope, so a tool inherited from an enclosing scope is hidden for it alone', async t => {
  const requests: GenerateOptions[] = [];
  const { ctx, cleanup } = await hostFixture(t, async function* (request): AsyncIterable<StreamChunk> {
    requests.push(request);
    yield* textResponse('ok');
  });
  const options = { agentOptions: { provider: 'test', model: 'test' } };
  const parent = (await ctx.agents.create({ sessionId: SessionId('parent'), ...options })).agent;
  const child = (await ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent, ...options })).agent;
  if (!('restrict' in child.ctx.tools)) { t.skip('tool restrictions belong to a later DSH'); return; }
  cleanup.push(parent.ctx.tools.register(probe('inherited_probe')));
  // A preset scope encloses the agents it serves; the fixture has none, so link one to get the same ancestry.
  const childScope = scopeOf(child.ctx)!;
  bindScopeParent(childScope, scopeOf(parent.ctx)!);
  const ask = async (agent: typeof parent) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }));
    await agent.whenIdle();
  };
  const visible = (index: number, name: string) => requests[index].tools?.some(tool => tool.name === name) ?? false;

  // A scope-less lookup sees the global layer alone, which is why the restriction has to name the agent's scope.
  assert.equal(parent.ctx.tools.get('inherited_probe'), undefined);
  assert.notEqual(child.ctx.tools.get('inherited_probe', childScope), undefined);

  const lift = hideGlobalTools(child, ['inherited_probe']);
  await ask(child);
  assert.equal(visible(0, 'inherited_probe'), false, 'the inherited tool is hidden for the child');
  await ask(parent);
  assert.equal(visible(1, 'inherited_probe'), true, 'the enclosing scope keeps it');
  lift();
});
