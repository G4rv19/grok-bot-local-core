'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentStore } = require('../runtime/agent-store.cjs');
const { AgentSkills } = require('../runtime/agent-skills.cjs');
const { AgentRuntime } = require('../runtime/agent-runtime.cjs');
const { LocalGateway } = require('../runtime/local-gateway.cjs');
const contract = require('./fixtures/gateway-contract.cjs');
const response = message => ({ model: 'test-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message }], status: 'completed' }] });
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args), namespace: 'grok_bot' });

function fixture(t, provider, native = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-agent-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AgentStore(dataDir), skills = new AgentSkills(store);
  const gateway = new LocalGateway({ dataDir, contract, runModel: async () => '' });
  gateway.contextStore = store; gateway.skills = skills;
  const { agent } = gateway.create({ name: 'Memory Bot' });
  const runtime = new AgentRuntime({ store, skills, gateway, provider, nativeTools: { catalog: [], images: () => [], ...native },
    getPermission: () => 'always', getModel: () => 'test-model', modelCatalog: async () => [{ slug: 'test-model', context_window: 200000 }] });
  return { dataDir, store, skills, gateway, agent, runtime };
}
const runArgs = (agent, prompt, turnId = 'turn-1') => ({ agent, turnId, history: [{ id: turnId, kind: 'message', role: 'user', content: prompt }], signal: new AbortController().signal, onActivity: () => {}, onTool: () => {} });

test('agent owns app state, skill instructions, tool loop and durable memory across restart', async t => {
  let step = 0;
  const provider = { complete: async args => {
    assert.equal(args.model, 'test-model');
    assert.match(args.instructions, /Memory Bot/);
    assert.equal(args.tools[0].name, 'grok_bot');
    switch (step++) {
      case 0: return { output: [call('state-call', 'app_state', {}), call('memory-call', 'remember', { id: 'language', text: 'Use Australian English' })] };
      case 1:
        assert.ok(args.input.some(item => item.type === 'function_call_output' && item.call_id === 'state-call'));
        assert.match(args.instructions, /Use Australian English/);
        return { output: [call('skill-call', 'read_skill', { id: 'check' })] };
      case 2:
        assert.ok(args.input.some(item => item.type === 'function_call_output' && item.output.includes('Read the fixture before answering')));
        return response('Memory saved and skill loaded');
      default:
        assert.match(args.instructions, /Use Australian English/);
        assert.ok(args.input.some(item => item.type === 'function_call_output' && item.call_id === 'memory-call'));
        return response('I remember');
    }
  } };
  const f = fixture(t, provider);
  f.skills.save(f.agent, { name: 'check', description: 'Fixture check', body: 'Read the fixture before answering', trigger: null });
  assert.equal(await f.runtime.run(runArgs(f.agent, 'Remember my language and load check')), 'Memory saved and skill loaded');
  const reopened = new AgentStore(f.dataDir);
  f.runtime.store = reopened; f.runtime.skills = new AgentSkills(reopened);
  assert.equal(await f.runtime.run(runArgs(f.agent, 'What did I ask?', 'turn-2')), 'I remember');
  assert.equal(reopened.load(f.agent.id).memories[0].text, 'Use Australian English');
  assert.equal(reopened.load(f.agent.id).turns.length, 2);
  assert.ok(reopened.search(f.agent.id, 'Australian').length > 0);
});

test('compaction retains recent complete tool pairs and the full searchable journal', async t => {
  let summaries = 0;
  const f = fixture(t, { complete: async args => {
    assert.match(args.instructions, /context maintenance/);
    summaries++; return response('Earlier work: project identifier ORCHID-472. Commands completed successfully.');
  } });
  f.store.commit(f.agent.id, 'import', []);
  for (let i = 0; i < 7; i++) {
    f.store.begin(f.agent.id, `old-${i}`, `Project ORCHID-472 step ${i}: ${'context '.repeat(500)}`);
    f.store.commit(f.agent.id, 'items', { turnId: `old-${i}`, items: [call(`c-${i}`, 'read_file', { path: 'fixture.txt' }), { type: 'function_call_output', call_id: `c-${i}`, output: `result ${i}` }] });
    f.store.commit(f.agent.id, 'finish', { turnId: `old-${i}`, status: 'complete' });
  }
  f.store.begin(f.agent.id, 'current', 'Continue');
  await f.runtime.compact(f.agent, { slug: 'test-model', context_window: 14000 }, [], new AbortController().signal, () => {});
  assert.ok(summaries > 0);
  const state = f.store.load(f.agent.id);
  assert.equal(state.compactions, 1);
  assert.deepEqual(state.turns.map(turn => turn.id), ['old-6', 'current']);
  assert.ok(state.turns[0].items.some(item => item.call_id === 'c-6' && item.type === 'function_call_output'));
  assert.match(state.summary, /ORCHID-472/);
  assert.ok(f.store.search(f.agent.id, 'result 0').length);
});

test('interrupted tool calls are closed with an explicit unknown outcome, never replayed', t => {
  const f = fixture(t, {});
  f.store.commit(f.agent.id, 'import', []);
  f.store.begin(f.agent.id, 'interrupted', 'Write a file');
  f.store.commit(f.agent.id, 'items', { turnId: 'interrupted', items: [call('write-1', 'write_file', { path: 'x', content: 'x' })] });
  const reopened = new AgentStore(f.dataDir);
  reopened.begin(f.agent.id, 'new', 'Continue');
  const prior = reopened.load(f.agent.id).turns[0];
  assert.equal(prior.status, 'interrupted');
  assert.ok(prior.items.some(item => item.type === 'function_call_output' && item.call_id === 'write-1' && item.output.includes('Inspect current state')));
});

test('new conversations preserve saved memories and skill metadata', async t => {
  const Ajv = require('ajv/dist/2020');
  const ajv = new Ajv({ strict: false, allowUnionTypes: true });
  const f = fixture(t, {});
  f.store.remember(f.agent.id, 'Keep this preference', 'preference');
  const skills = await f.gateway.dispatch('createAgentWorkflow', { id: f.agent.id, spec: { name: 'Check', description: 'Check files', body: 'Read the files', trigger: null } });
  assert.equal(ajv.compile({ $defs: contract.$defs, ...contract.methods.createAgentWorkflow.reply })(skills), true);
  f.store.begin(f.agent.id, 'old', 'Hello');
  await f.gateway.dispatch('startFreshConversation', { id: f.agent.id });
  assert.equal(f.store.load(f.agent.id).turns.length, 0);
  assert.equal(f.store.load(f.agent.id).memories[0].id, 'preference');
  assert.ok(f.skills.list(f.agent).some(skill => skill.name === 'Check'));
  assert.ok(f.skills.read(f.agent, 'builtin-mac-control').body.includes('coordinate_token'));
  assert.ok(f.skills.list(f.agent).some(skill => skill.source === 'managed'));
});

test('active long tasks compact complete tool rounds and remain replayable after restart', async t => {
  const f = fixture(t, { complete: async () => response('Earlier tool rounds read ORCHID-472. Continue from the latest result.') });
  f.store.commit(f.agent.id, 'import', []);
  f.store.begin(f.agent.id, 'long-task', 'Inspect the large project');
  for (let i = 0; i < 6; i++) {
    f.store.commit(f.agent.id, 'items', { turnId: 'long-task', items: [call(`long-${i}`, 'read_file', { path: `file-${i}` }), { type: 'function_call_output', call_id: `long-${i}`, output: 'ORCHID-472 '.repeat(800) }] });
    f.store.commit(f.agent.id, 'round', { turnId: 'long-task' });
  }
  await f.runtime.compact(f.agent, { slug: 'test-model', context_window: 30000 }, [], new AbortController().signal, () => {});
  const reopened = new AgentStore(f.dataDir), state = reopened.load(f.agent.id);
  assert.equal(state.compactions, 1);
  assert.match(state.summary, /ORCHID-472/);
  assert.equal(state.turns[0].items[0].content, 'Inspect the large project');
  const items = reopened.input(f.agent.id);
  const calls = items.filter(item => item.type === 'function_call');
  assert.deepEqual(calls.map(item => item.call_id), ['long-5']);
  assert.ok(items.some(item => item.type === 'function_call_output' && item.call_id === 'long-5'));
  assert.ok(reopened.search(f.agent.id, 'file-0').length);
});
