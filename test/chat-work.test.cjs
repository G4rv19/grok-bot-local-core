"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { LocalGateway } = require("../runtime/local-gateway.cjs"),
  { AgentTasks } = require("../runtime/agent-tasks.cjs"),
  { Automations } = require("../runtime/automations.cjs"),
  { ChatWork, wallTime, scheduleLabel } = require("../runtime/chat-work.cjs"),
  { Connectors } = require("../runtime/connectors.cjs"),
  { ConnectionSettings } = require("../runtime/connection-settings.cjs");
const contract = require("./fixtures/gateway-contract.cjs");
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-chat-ui-")),
    gateway = new LocalGateway({
      dataDir,
      contract,
      runModel: async () => "Verified UI task result",
    });
  gateway.tasks = new AgentTasks({ dataDir, gateway });
  gateway.automations = new Automations({
    dataDir,
    gateway,
    now: () => Date.parse("2026-11-10T00:00:00Z"),
  });
  gateway.canRunAutomatic = () => false;
  const first = gateway.create({ name: "First" }).agent,
    second = gateway.create({ name: "Second" }).agent;
  t.after(() => {
    gateway.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, gateway, first, second, work: new ChatWork(gateway) };
}
test("chat controls use durable tasks, reject changed retries and stay scoped to their Bot", async (t) => {
  const f = fixture(t),
    events = [];
  f.gateway.workChanged = (...ids) => events.push(ids);
  const first = await f.work.dispatch({
    action: "start",
    agentId: f.first.id,
    prompt: "Verify chat control",
    title: "UI background check",
    nonce: "one",
  });
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].status, "queued");
  await f.work.dispatch({
    action: "start",
    agentId: f.first.id,
    prompt: "Verify chat control",
    title: "UI background check",
    nonce: "one",
  });
  assert.equal(f.gateway.tasks.list().length, 1);
  await assert.rejects(
    f.work.dispatch({
      action: "start",
      agentId: f.first.id,
      prompt: "Different",
      nonce: "one",
    }),
    /changed/,
  );
  assert.equal(f.work.snapshot(f.second.id).tasks.length, 0);
  await assert.rejects(
    f.work.dispatch({
      action: "pause",
      agentId: f.second.id,
      id: first.tasks[0].id,
    }),
    /another Bot/,
  );
  const paused = await f.work.dispatch({
    action: "pause",
    agentId: f.first.id,
    id: first.tasks[0].id,
  });
  assert.equal(paused.tasks[0].status, "paused");
  await f.work.dispatch({
    action: "resume",
    agentId: f.first.id,
    id: first.tasks[0].id,
  });
  await settle();
  const done = f.work.snapshot(f.first.id).tasks[0];
  assert.equal(done.status, "completed");
  assert.equal(done.result, "Verified UI task result");
  assert.equal(done.canStop, false);
  assert.ok(events.some((ids) => ids.includes(f.first.id)));
});
test("chat schedule forms save once, keep results after completion/restart and return schedule metadata", async (t) => {
  const f = fixture(t),
    request = {
      action: "saveSchedule",
      agentId: f.first.id,
      nonce: "schedule-request",
      spec: {
        name: "UI scheduled check",
        prompt: "Verify",
        frequency: "once",
        dateTime: "2026-11-11T09:30",
        timeZone: "UTC",
        missed: "once",
      },
    };
  const first = await f.work.dispatch(request);
  await f.work.dispatch(request);
  assert.equal(f.gateway.automations.list().length, 1);
  const card = first.schedules[0];
  assert.equal(card.status, "scheduled");
  assert.equal(card.label, "Once");
  assert.equal(card.nextRunAt, Date.parse("2026-11-11T09:30:00Z"));
  await assert.rejects(
    f.work.dispatch({
      ...request,
      spec: { ...request.spec, prompt: "Changed" },
    }),
    /changed/,
  );
  await assert.rejects(
    f.work.dispatch({
      action: "pauseSchedule",
      agentId: f.second.id,
      id: card.id,
    }),
    /Unknown/,
  );
  f.gateway.canRunAutomatic = () => true;
  await f.work.dispatch({
    action: "runSchedule",
    agentId: f.first.id,
    id: card.id,
  });
  await settle();
  const done = f.work.snapshot(f.first.id).schedules[0];
  assert.equal(done.status, "completed");
  assert.equal(done.result, "Verified UI task result");
  assert.equal(
    f.work.snapshot(f.first.id).tasks.length,
    0,
    "scheduled run is represented once",
  );
  f.gateway.automations = new Automations({
    dataDir: f.dataDir,
    gateway: f.gateway,
    now: () => Date.parse("2026-11-12T00:00:00Z"),
  });
  assert.equal(
    f.work.snapshot(f.first.id).schedules[0].result,
    "Verified UI task result",
  );
  const Ajv = require("ajv/dist/2020"),
    validate = new Ajv({ strict: false, allowUnionTypes: true }).compile({
      $defs: contract.$defs,
      ...contract.methods.getAgentAutomations.reply,
    });
  assert.equal(
    validate(f.gateway.automations.original(f.first.id)),
    true,
    JSON.stringify(validate.errors),
  );
  await f.work.dispatch({
    action: "removeSchedule",
    agentId: f.first.id,
    id: card.id,
  });
  assert.equal(f.work.snapshot(f.first.id).schedules.length, 0);
});
test("schedule wall times and readable repeat patterns respect zones and DST gaps", () => {
  assert.equal(
    wallTime("2026-11-11T09:30", "Australia/Brisbane"),
    "2026-11-10T23:30:00.000Z",
  );
  assert.throws(() => wallTime("2026-02-31T09:30", "UTC"), /valid date/);
  assert.throws(
    () => wallTime("2027-03-14T02:30", "America/New_York"),
    /does not exist/,
  );
  assert.match(scheduleLabel({ schedule: "0 9 * * 1-5" }), /Weekdays at 9:00/);
  assert.equal(scheduleLabel({ schedule: "*/15 * * * *" }), "Every 15 minutes");
});
test("connecting and changing one service preserves other MCP sessions and concurrent additions", async (t) => {
  const f = fixture(t),
    c = new Connectors({
      dataDir: f.dataDir,
      fetch,
      authorize: async () => {},
    }),
    service = new ConnectionSettings({
      connectors: c,
      loginGoogle: async () => assert.fail("unexpected login"),
    });
  t.after(() => c.close());
  await c.configure([
    {
      id: "fixture",
      name: "MCP Fixture",
      command: process.execPath,
      args: [path.join(__dirname, "fixtures/mcp-server.cjs")],
    },
  ]);
  await c.tools("fixture");
  const client = c.clients.get("fixture");
  const definition = (id) => ({
    id,
    name: id,
    kind: "cli",
    command: process.execPath,
    args: [],
    prefixes: ["read"],
  });
  await Promise.all([
    service.dispatch({ action: "add", definition: definition("first-cli") }),
    service.dispatch({ action: "add", definition: definition("second-cli") }),
  ]);
  assert.equal(c.config.length, 3);
  assert.equal(c.clients.get("fixture"), client);
  await service.dispatch({ action: "automatic", id: "fixture", enabled: true });
  assert.equal(c.clients.get("fixture"), client);
  await service.dispatch({ action: "remove", id: "first-cli" });
  assert.equal(c.clients.get("fixture"), client);
  const result = await c.call("fixture", "echo", {
    text: "SESSION_STILL_ALIVE",
  });
  assert.match(result.content[0].text, /SESSION_STILL_ALIVE/);
  const snapshot = await service.dispatch({ action: "test", id: "fixture" });
  assert.equal(
    snapshot.connections.find((x) => x.id === "fixture").status.toolCount,
    1,
  );
  assert.ok(!JSON.stringify(snapshot).includes("headers"));
});
