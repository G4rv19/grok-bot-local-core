'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AgentStore } = require('../runtime/agent-store.cjs');
const { AgentSkills } = require('../runtime/agent-skills.cjs');
const { AgentRuntime } = require('../runtime/agent-runtime.cjs');
const { AgentHarness } = require('../runtime/agent-harness.cjs');
const { AgentTasks } = require('../runtime/agent-tasks.cjs');
const { LocalGateway } = require('../runtime/local-gateway.cjs');
const { cleanRoutingText, taskTool } = require('../runtime/task-presentation.cjs');
const contract = require('./fixtures/gateway-contract.cjs');
const message = text => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
const call = (id, name, args) => ({ type: 'function_call', namespace: 'grok_bot', name, call_id: id, arguments: JSON.stringify(args) });
const until = async condition => { for (let i = 0; i < 1000; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Task did not settle'); };
function create(directory, provider, native = {}) {
  const store = new AgentStore(directory), skills = new AgentSkills(store);
  let harness;
  const gateway = new LocalGateway({ dataDir: directory, contract, runModel: args => harness.run(args) });
  gateway.contextStore = store; gateway.skills = skills; gateway.tasks = new AgentTasks({ dataDir: directory, gateway });
  const runtime = new AgentRuntime({ store, skills, provider, gateway, nativeTools: { catalog: [], images: () => [], authorize: async () => {}, ...native }, getPermission: () => 'always', getModel: () => 'fixture', modelCatalog: async () => [{ slug: 'fixture', context_window: 1000000 }] });
  harness = new AgentHarness({ runtime, store, retryDelays: [0, 0, 0] });
  return { store, skills, runtime, harness, gateway };
}
function fixture(t, provider, native) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-harness-'));
  const f = { ...create(directory, provider, native), directory };
  f.parent = f.gateway.create({ name: 'Coordinator' }).agent; f.worker = f.gateway.create({ name: 'Marketing' }).agent;
  t.after(async () => { f.gateway.close(); await until(() => f.gateway.jobs.size === 0); fs.rmSync(directory, { recursive: true, force: true }); });
  return f;
}
function seed(f, tool, execution) {
  const task = { id: crypto.randomUUID(), from: f.parent.id, to: f.worker.id, prompt: 'Continue the saved work', title: 'Saved work', ancestry: [f.parent.id], status: 'working', background: true, createdAt: Date.now(), result: null };
  f.gateway.tasks.tasks.set(task.id, task);
  const entry = f.gateway.append(f.worker.id, 'user', task.prompt, { taskId: task.id, fromAgent: { id: f.parent.id, name: f.parent.name, kind: 'agent' } });
  task.turnId = entry.id; f.gateway.tasks.save(task);
  f.store.commit(f.worker.id, 'import', []); f.store.begin(f.worker.id, entry.id, task.prompt);
  if (tool) f.store.commit(f.worker.id, 'items', { turnId: entry.id, items: [tool] });
  if (execution) f.store.commit(f.worker.id, 'execution', { callId: `${entry.id}:${tool.call_id}`, turnId: entry.id, name: tool.name, arguments: tool.arguments, ...execution });
  f.gateway.tasks = new AgentTasks({ dataDir: f.directory, gateway: f.gateway });
  return f.gateway.tasks.get(task.id);
}

test('delegated work continues beyond 60 rounds with one task, a saved plan and no duplicate user message', async t => {
  let rounds = 0;
  const f = fixture(t, { complete: async () => rounds < 65 ? { output: [call(`step-${rounds}`, 'checkpoint_task', { note: `Verified stage ${++rounds}`, next_steps: ['Finish remaining stages'] })] } : message('Campaign complete') });
  const task = await f.gateway.tasks.delegate({ from: f.parent.id, to: f.worker.id, title: 'Campaign', prompt: 'Complete the campaign' });
  assert.equal(task.status, 'completed'); assert.equal(task.result, 'Campaign complete'); assert.equal(rounds, 65);
  assert.equal(task.lastMilestone, 'Verified stage 65');
  const state = f.store.load(f.worker.id), turn = state.turns[0];
  assert.equal(state.turns.length, 1); assert.equal(turn.steps, 66); assert.ok(turn.checkpoints > 65);
  assert.equal(turn.checkpoint.note, 'Verified stage 65');
  const entries = f.gateway.visibleEntries(f.worker.id);
  assert.equal(entries.filter(entry => entry.role === 'user').length, 1);
  assert.equal(entries[0].fromAgent.name, 'Coordinator'); assert.equal(entries[0].content, 'Complete the campaign');
});

test('restart restores a confirmed tool result without executing the write again', async t => {
  let writes = 0;
  const f = fixture(t, { complete: async args => {
    assert.ok(args.input.some(item => item.type === 'function_call_output' && item.output.includes('confirmed')));
    return message('Recovered confirmed work');
  } }, { write: async () => { writes++; throw new Error('Must not run again'); } });
  const marker = path.join(f.directory, 'written-once'); fs.writeFileSync(marker, 'ONE');
  const task = seed(f, call('write-once', 'write_file', { path: 'written-once', content: 'ONE' }), { status: 'done', result: { confirmed: true } });
  await f.gateway.tasks.start(); await until(() => task.status === 'completed');
  assert.equal(writes, 0); assert.equal(fs.readFileSync(marker, 'utf8'), 'ONE');
  assert.equal(f.gateway.entries(f.worker.id).filter(entry => entry.role === 'user').length, 1);
});

test('unknown side effects pause on restart, then continue through inspection without replay', async t => {
  let writes = 0, reads = 0, requests = 0;
  const f = fixture(t, { complete: async args => {
    requests++;
    assert.ok(args.input.some(item => item.type === 'function_call_output' && item.output.includes('unknown outcome')));
    return reads ? message('Existing output inspected; no duplicate write') : { output: [call('inspect', 'read_file', { path: 'marker' })] };
  } }, { write: async () => { writes++; }, read: async () => { reads++; return fs.readFileSync(path.join(f.directory, 'marker'), 'utf8'); } });
  fs.writeFileSync(path.join(f.directory, 'marker'), 'ONE');
  const task = seed(f, call('uncertain-write', 'write_file', { path: 'marker', content: 'ONE' }), { status: 'started' });
  await f.gateway.tasks.start(); await until(() => task.status === 'paused');
  assert.equal(requests, 0); assert.equal(writes, 0); assert.match(task.error, /unknown/);
  await f.gateway.tasks.resume(task.id, f.parent.id, true); await until(() => task.status === 'completed');
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(fs.readFileSync(path.join(f.directory, 'marker'), 'utf8'), 'ONE');
});

test('a restored parent reattaches to its existing delegation rather than creating another child', async t => {
  const f = fixture(t, { complete: async args => {
    assert.ok(args.input.some(item => item.type === 'function_call_output' && item.output.includes('Existing child result')));
    return message('Parent finished');
  } });
  const parentTurn = 'parent-turn'; f.store.commit(f.worker.id, 'import', []); f.store.begin(f.worker.id, parentTurn, 'Finish the task');
  const delegated = call('delegation-call', 'delegate_task', { agent_id: f.parent.id, prompt: 'Get the result' });
  f.store.commit(f.worker.id, 'items', { turnId: parentTurn, items: [delegated] });
  f.store.commit(f.worker.id, 'execution', { callId: `${parentTurn}:${delegated.call_id}`, turnId: parentTurn, status: 'started', name: 'delegate_task' });
  const task = { id: crypto.randomUUID(), from: f.worker.id, to: f.parent.id, prompt: 'Get the result', ancestry: [f.worker.id], key: `${f.worker.id}:${parentTurn}:${delegated.call_id}`, status: 'completed', result: 'Existing child result', createdAt: Date.now() };
  f.gateway.tasks.tasks.set(task.id, task); f.gateway.tasks.save(task);
  const result = await f.harness.run({ agent: f.worker, history: [{ role: 'user', content: 'Finish the task' }], turnId: parentTurn, resume: true, signal: new AbortController().signal, onActivity: () => {}, onTool: () => {} });
  assert.equal(result, 'Parent finished'); assert.equal(f.gateway.tasks.tasks.size, 1); assert.equal(f.gateway.entries(f.parent.id).length, 0);
});

test('transient model failures resume from confirmed outputs and never repeat a completed action', async t => {
  let requests = 0, writes = 0;
  const f = fixture(t, { complete: async args => {
    if (requests++ === 0) return { output: [call('write', 'write_file', { path: 'fixture', content: 'ONE' })] };
    if (requests === 2) { const error = new Error('Temporary model connection failure'); error.retryable = true; throw error; }
    assert.ok(args.input.some(item => item.type === 'function_call_output' && item.output.includes('written')));
    return message('Done after reconnecting');
  } }, { write: async () => { writes++; return { written: true }; } });
  const task = await f.gateway.tasks.delegate({ from: f.parent.id, to: f.worker.id, prompt: 'Write once' });
  assert.equal(task.status, 'completed'); assert.equal(writes, 1); assert.equal(requests, 3);
  assert.ok(f.store.load(f.worker.id).turns[0].checkpoints >= 1);
});

test('closing and reopening resumes safe delegated work and delivers a clean result to its owner', async t => {
  let entered = false;
  const f = fixture(t, { complete: async ({ signal }) => {
    entered = true; signal.throwIfAborted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('App closed')), { once: true }));
  } });
  const task = await f.gateway.tasks.delegate({ from: f.parent.id, to: f.worker.id, prompt: 'Continue across restart', wait: false });
  await until(() => entered); f.gateway.close(); await until(() => f.gateway.jobs.size === 0);
  assert.equal(f.gateway.tasks.get(task.id).status, 'queued');
  const reopened = create(f.directory, { complete: async () => message('Finished after reopening') });
  f.gateway = reopened.gateway;
  await reopened.gateway.tasks.start(); await until(() => reopened.gateway.tasks.get(task.id).status === 'completed');
  assert.equal(reopened.gateway.entries(f.worker.id).filter(entry => entry.role === 'user').length, 1);
  const notice = reopened.gateway.visibleEntries(f.parent.id).at(-1);
  assert.equal(notice.fromAgent.name, 'Marketing'); assert.equal(notice.content, 'Finished after reopening'); assert.ok(!notice.content.includes(task.id));
  assert.equal(reopened.store.load(f.worker.id).turns.length, 1);
});

test('pause remains paused after restart and explicit resume preserves the same task', async t => {
  let entered = false;
  const f = fixture(t, { complete: async ({ signal }) => { entered = true; signal.throwIfAborted(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Paused')), { once: true })); } });
  const task = await f.gateway.tasks.delegate({ from: f.parent.id, to: f.worker.id, prompt: 'Pause this work', wait: false });
  await until(() => entered); f.gateway.tasks.pause(task.id, f.parent.id); await until(() => f.gateway.jobs.size === 0);
  assert.equal(f.gateway.tasks.get(task.id).status, 'paused'); assert.equal(f.gateway.tasks.get(task.id).error, null);
  assert.equal(f.gateway.entries(f.worker.id).at(-1).content, 'Paused. Progress is saved.');
  const reopened = create(f.directory, { complete: async () => message('Continued saved work') }); f.gateway = reopened.gateway;
  await reopened.gateway.tasks.start(); assert.equal(reopened.gateway.jobs.size, 0);
  await reopened.gateway.tasks.resume(task.id, f.parent.id); await until(() => reopened.gateway.tasks.get(task.id).status === 'completed');
  assert.equal(reopened.gateway.tasks.tasks.size, 1);
});

test('A2A presentation uses names and author metadata while preserving internal records', async t => {
  const f = fixture(t, { complete: async () => message('Done') });
  const task = seed(f);
  const raw = `I’m Marketing (\`${f.worker.id}\`). Task ${task.id} is complete.`;
  const clean = cleanRoutingText(raw, f.gateway);
  assert.ok(!clean.includes(f.worker.id)); assert.ok(!clean.includes(task.id)); assert.match(clean, /Marketing/);
  const artifact = `[Result](/workspaces/${f.worker.id}/report.md)`;
  assert.equal(cleanRoutingText(artifact, f.gateway), artifact, 'Real artifact links must remain usable');
  const view = taskTool({ name: 'delegate_task', arguments: JSON.stringify({ agent_id: f.worker.id }) }, { ...task, status: 'completed', result: raw }, f.gateway);
  assert.equal(view.name, 'Working with Marketing'); assert.ok(!JSON.stringify(view).includes(task.id));
  f.gateway.append(f.parent.id, 'assistant', raw);
  assert.equal(f.gateway.entries(f.parent.id).at(-1).content, raw);
  assert.equal(f.gateway.visibleEntries(f.parent.id).at(-1).content, clean);
  const Ajv = require('ajv/dist/2020'); const validate = new Ajv({ strict: false }).compile({ $defs: contract.$defs, ...contract.methods.openAgentTail.reply });
  assert.equal(validate({ entries: f.gateway.visibleEntries(f.worker.id) }), true, JSON.stringify(validate.errors));
});

test('stopping a waiting coordinator stops its child and releases both running jobs', async t => {
  let workerEntered = false, f;
  f = fixture(t, { complete: async ({ instructions, signal }) => {
    if (instructions.startsWith('You are Coordinator')) return { output: [call('delegate', 'delegate_task', { agent_id: f.worker.id, prompt: 'Wait for cancellation' })] };
    workerEntered = true; signal.throwIfAborted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  } });
  await f.gateway.send({ agentId: f.parent.id, prompt: 'Delegate the task' });
  await until(() => workerEntered);
  f.gateway.jobs.get(f.parent.id).abort();
  await until(() => f.gateway.jobs.size === 0);
  assert.equal(f.gateway.tasks.list()[0].status, 'canceled'); assert.equal(f.gateway.tasks.waiters.size, 0);
});

test('bounded retry exhaustion pauses a delegated task instead of claiming completion', async t => {
  let requests = 0;
  const f = fixture(t, { complete: async () => { requests++; const error = new Error('Temporary connection failure'); error.retryable = true; throw error; } });
  const task = await f.gateway.tasks.delegate({ from: f.parent.id, to: f.worker.id, prompt: 'Keep the work durable' });
  assert.equal(task.status, 'paused'); assert.equal(task.result, null); assert.equal(requests, 4);
  assert.match(task.error, /connection/); assert.ok(f.store.load(f.worker.id).turns[0].checkpoints >= 3);
});

test('a checkpoint interrupted before its acknowledgment is safely recovered', async t => {
  const f = fixture(t, { complete: async args => {
    assert.ok(args.input.some(item => item.type === 'function_call_output' && item.output.includes('saved')));
    return message('Continued from the saved plan');
  } });
  const task = seed(f, call('checkpoint', 'checkpoint_task', { note: 'Plan saved', next_steps: ['Continue'] }), { status: 'started' });
  await f.gateway.tasks.start(); await until(() => task.status === 'completed');
  assert.equal(f.store.load(f.worker.id).turns[0].checkpoint.note, 'Plan saved');
});

test('a completed result left in the outbox is delivered once across repeated restarts', async t => {
  const f = fixture(t, { complete: async () => message('Unused') });
  const task = seed(f); task.status = 'completed'; task.result = 'Saved result'; task.delivered = false; f.gateway.tasks.save(task);
  await f.gateway.tasks.start();
  assert.equal(f.gateway.entries(f.parent.id).filter(entry => entry.fromAgent).length, 1);
  task.delivered = false; f.gateway.tasks.save(task);
  f.gateway.tasks = new AgentTasks({ dataDir: f.directory, gateway: f.gateway });
  await f.gateway.tasks.start();
  assert.equal(f.gateway.entries(f.parent.id).filter(entry => entry.fromAgent).length, 1);
});

test('a task paused before its first model request can start after the connection is restored', async t => {
  const f = fixture(t, { complete: async () => message('Connected and finished') });
  let catalogRequests = 0;
  f.runtime.modelCatalog = async () => { if (!catalogRequests++) throw new Error('Reconnect the account'); return [{ slug: 'fixture', context_window: 1000000 }]; };
  const task = await f.gateway.tasks.delegate({ from: f.parent.id, to: f.worker.id, prompt: 'Start after reconnecting' });
  assert.equal(task.status, 'paused'); assert.equal(f.store.load(f.worker.id).turns.length, 0);
  await f.gateway.tasks.resume(task.id, f.parent.id); await until(() => task.status === 'completed' || f.gateway.tasks.get(task.id).status === 'completed');
  assert.equal(f.gateway.entries(f.worker.id).filter(entry => entry.role === 'user').length, 1);
  assert.equal(f.gateway.tasks.get(task.id).result, 'Connected and finished');
});
