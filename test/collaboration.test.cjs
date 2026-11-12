'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalGateway } = require('../runtime/local-gateway.cjs');
const { AgentTasks } = require('../runtime/agent-tasks.cjs');
const { Automations } = require('../runtime/automations.cjs');
const { Connectors } = require('../runtime/connectors.cjs');
const contract = require('./fixtures/gateway-contract.cjs');
function fixture(t, runModel) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-collaboration-'));
  const gateway = new LocalGateway({ dataDir, contract, runModel });
  gateway.tasks = new AgentTasks({ dataDir, gateway });
  t.after(() => { gateway.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, gateway };
}
test('A2A delegates to a distinct Bot and delivers its result with cycle prevention', async t => {
  const f = fixture(t, async ({ agent, history }) => {
    assert.equal(agent.name, 'Marketing'); assert.match(history.at(-1).content, /Draft a headline/);
    await assert.rejects(f.gateway.tasks.delegate({ from: child.id, to: parent.id, prompt: 'cycle' }), /loop/);
    return 'A headline from Marketing';
  });
  const parent = f.gateway.create({ name: 'Coordinator' }).agent, child = f.gateway.create({ name: 'Marketing' }).agent;
  const task = await f.gateway.tasks.delegate({ from: parent.id, to: child.id, prompt: 'Draft a headline' });
  assert.equal(task.status, 'completed'); assert.equal(task.result, 'A headline from Marketing');
  assert.equal(f.gateway.entries(child.id).at(-1).content, task.result);
  assert.equal(new AgentTasks({ dataDir: f.dataDir, gateway: f.gateway }).get(task.id).result, task.result);
});
test('local cron scheduling fires once, respects busy Bots, and persists completion', async t => {
  let calls = 0, time = Date.parse('2026-11-10T00:00:00Z');
  const f = fixture(t, async () => { calls++; return 'SCHEDULED_OK'; });
  const agent = f.gateway.create({ name: 'Scheduled' }).agent;
  const scheduler = new Automations({ dataDir: f.dataDir, gateway: f.gateway, now: () => time });
  f.gateway.automations = scheduler;
  const item = scheduler.save(agent.id, { name: 'Minute task', prompt: 'Check the fixture', schedule: '* * * * *', timeZone: 'UTC' });
  time += 60000;
  await scheduler.tick(); await scheduler.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(item.running, false); assert.equal(item.lastError, null);
  await f.gateway.dispatch('setAgentAutomationEnabled', { id: agent.id, automationId: item.id, isEnabled: false });
  time += 60000; await scheduler.tick(); assert.equal(calls, 1);
  assert.equal((await f.gateway.dispatch('listAllAutomations'))[0].automation.isEnabled, false);
  await f.gateway.dispatch('runAgentAutomationNow', { id: agent.id, automationId: item.id });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  const Ajv = require('ajv/dist/2020');
  const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile({ $defs: contract.$defs, ...contract.methods.getAgentAutomations.reply });
  assert.equal(validate(scheduler.original(agent.id)), true, JSON.stringify(validate.errors));
});
test('MCP discovers and calls a real stdio server without using Codex plugins', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mcp-'));
  let approved = 0;
  const connectors = new Connectors({ dataDir: directory, fetch, authorize: async () => { approved++; } });
  t.after(async () => { await connectors.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await connectors.configure([{ id: 'fixture', name: 'Test connector', command: process.execPath, args: [path.join(__dirname, 'fixtures/mcp-server.cjs')] }]);
  const tools = await connectors.tools('fixture'); assert.equal(tools[0].name, 'echo');
  const result = await connectors.call('fixture', 'echo', { text: 'CONNECTED' }, new AbortController().signal);
  assert.equal(result.content[0].text, 'MCP_FIXTURE:CONNECTED'); assert.equal(approved, 1);
  assert.ok(!JSON.stringify(connectors.describe()).includes('env'));
});

test('MCP HTTP transport discovers a real server and shares concurrent connection setup', async t => {
  const http = require('node:http');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { z } = require('zod');
  let initializations = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.method === 'initialize') initializations++;
    const mcp = new McpServer({ name: 'http-fixture', version: '1.0' });
    mcp.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: 'HTTP:' + text }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, message);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-http-mcp-'));
  const connectors = new Connectors({ dataDir: directory, fetch, authorize: async () => {} });
  t.after(async () => { await connectors.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  await connectors.configure([{ id: 'http', name: 'HTTP fixture', url: `http://127.0.0.1:${server.address().port}/mcp` }]);
  const [first, second] = await Promise.all([connectors.tools('http'), connectors.tools('http')]);
  assert.equal(first[0].name, 'echo'); assert.deepEqual(first, second); assert.equal(initializations, 1);
  const result = await connectors.call('http', 'echo', { text: 'CONNECTED' });
  assert.equal(result.content[0].text, 'HTTP:CONNECTED');
});
