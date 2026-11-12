'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const { LocalGateway } = require('../runtime/local-gateway.cjs');
const contract = require('./fixtures/gateway-contract.cjs');
const ajv = new Ajv({ strict: false, allowUnionTypes: true });
function validator(schema) { return ajv.compile({ $defs: contract.$defs, ...schema }); }
const validators = new Map();
function check(method, value) {
  if (!validators.has(method)) validators.set(method, validator(contract.methods[method].reply));
  const validate = validators.get(method);
  assert.equal(validate(value), true, JSON.stringify(validate.errors)?.slice(0, 1800));
}

test('clears the original live activity overlay after a tool-using turn', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-local-activity-'));
  const gateway = new LocalGateway({ dataDir, contract, runModel: async ({ onActivity }) => {
    onActivity('cat verification.txt');
    return 'done';
  } });
  t.after(() => { gateway.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const activity = [];
  gateway.emit = (name, payload) => { if (name === 'agent-activity') activity.push(payload); };
  const { agent } = gateway.create({ name: 'Activity test' });
  await gateway.send({ agentId: agent.id, prompt: 'Read the fixture' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gateway.jobs.size, 0);
  assert.equal(gateway.agent(agent.id).isRunning, false);
  assert.ok(activity.some(event => event.live?.currentActivity?.kind === 'tool'));
  assert.equal(activity.at(-1).live.isRunning, false);
  assert.equal(activity.at(-1).live.isComposingMessage, false);
  assert.equal(validator(contract.events['agent-activity'])(activity.at(-1)), true);
});

test('loopback authorization, model round trip, dedupe, persistence', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-local-test-'));
  let modelCalls = 0;
  const gateway = await new LocalGateway({ dataDir, contract, runModel: async ({ history }) => {
    modelCalls++; assert.equal(history.at(-1).content, 'hello'); return 'local reply';
  } }).listen();
  t.after(() => { gateway.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal((await fetch(gateway.baseUrl + '/health')).status, 401);
  const headers = { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' };
  assert.deepEqual(await (await fetch(gateway.baseUrl + '/health', { headers })).json(), { ok: true });
  const api = async (method, args = {}) => {
    const response = await fetch(gateway.baseUrl + '/api/' + method, { method: 'POST', headers, body: JSON.stringify(args) });
    assert.equal(response.status, 200, await response.clone().text());
    const value = await response.json(); check(method, value); return value;
  };
  const events = [];
  const emit = gateway.emit.bind(gateway);
  gateway.emit = (name, payload) => { if (contract.events[name]) assert.equal(validator(contract.events[name])(payload), true, name); events.push({ name, payload }); emit(name, payload); };
  const { agent } = await api('createAgent', { name: 'Test', description: 'Contract fixture' });
  await api('listAgents'); await api('countAgents');
  await api('getHostStatus'); await api('getHostSettings'); await api('setHostSettings', { hasSeenOnboarding: true });
  await api('getMcpState'); await api('getAgentChannels', { id: agent.id });
  await api('sendPrompt', { agentId: agent.id, prompt: 'hello', clientNonce: 'test-nonce' });
  await new Promise(resolve => setImmediate(resolve));
  await api('sendPrompt', { agentId: agent.id, prompt: 'hello', clientNonce: 'test-nonce' });
  assert.equal(modelCalls, 1);
  await assert.rejects(gateway.send({ agentId: agent.id, prompt: 'different message', clientNonce: 'test-nonce' }), /different input/);
  const page = await api('openAgentTail', { id: agent.id, limit: 100 });
  await api('getAgentTranscriptWindow', { id: agent.id, limit: 100 });
  assert.deepEqual(page.entries.map(e => e.content), ['hello', 'local reply']);
  await api('promptAcceptanceStatus', { clientNonce: 'test-nonce', accountSlot: 'grokbot-local-user' });
  const reopened = new LocalGateway({ dataDir, contract, runModel: async () => '' });
  assert.equal(reopened.entries(agent.id).at(-1).content, 'local reply');
  assert.equal(fs.statSync(gateway.stateFile).mode & 0o777, 0o600);
  await assert.rejects(gateway.dispatch('ensureForeverBox', { id: agent.id }), /disabled/);
  await assert.rejects(gateway.dispatch('publishBotTemplate', {}), /not available/);
  assert.ok(events.some(e => e.name === 'transcript' && e.payload.type === 'appended'));
  gateway.appendTool(agent.id, { command: 'cat verification.txt', output: 'fixture output', exitCode: 0 });
  check('openAgentTail', { entries: gateway.entries(agent.id) });
});

test('the original live event stream remains subscribed after its GET request completes', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-local-sse-'));
  const gateway = await new LocalGateway({ dataDir, contract, runModel: async () => 'LIVE_REPLY' }).listen();
  const controller = new AbortController();
  t.after(() => { controller.abort(); gateway.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const response = await fetch(gateway.baseUrl + '/events', { headers: { Authorization: `Bearer ${gateway.token}` }, signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gateway.clients.size, 1, 'A live response must remain subscribed');
  const { agent } = gateway.create({ name: 'Live event fixture' });
  await gateway.send({ agentId: agent.id, prompt: 'Test live response' });
  let frames = '';
  while (!frames.includes('LIVE_REPLY')) {
    const result = await Promise.race([reader.read(), new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Live event delivery timed out')), 1000); timer.unref(); })]);
    frames += new TextDecoder().decode(result.value);
  }
  assert.match(frames, /appended/);
});
