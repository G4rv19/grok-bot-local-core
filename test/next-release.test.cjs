"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Ajv = require("ajv/dist/2020");
const { LocalGateway } = require("../runtime/local-gateway.cjs");
const { AgentTasks } = require("../runtime/agent-tasks.cjs");
const { Automations } = require("../runtime/automations.cjs");
const { AgentStore } = require("../runtime/agent-store.cjs");
const { AgentSkills } = require("../runtime/agent-skills.cjs");
const { AgentRuntime } = require("../runtime/agent-runtime.cjs");
const { Attachments } = require("../runtime/attachments.cjs");
const { Connectors } = require("../runtime/connectors.cjs");
const { Background } = require("../runtime/background.cjs");
const cli = require("../runtime/cli-connections.cjs");
const contract = require("./fixtures/gateway-contract.cjs");
const settle = () => new Promise((resolve) => setImmediate(resolve));
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t, runModel) {
  const dataDir = temp(t),
    gateway = new LocalGateway({ dataDir, contract, runModel });
  gateway.tasks = new AgentTasks({ dataDir, gateway });
  t.after(() => gateway.close());
  return { dataDir, gateway };
}
function check(method, value) {
  const validate = new Ajv({ strict: false, allowUnionTypes: true }).compile({
    $defs: contract.$defs,
    ...contract.methods[method].reply,
  });
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);
test("attachments: chunks, retries, restart, ownership and transcript", async (t) => {
  const f = fixture(t, async ({ history }) => {
    assert.equal(history.filter((x) => x.kind === "user-attachment").length, 1);
    return "FILE_OK";
  });
  const bot = f.gateway.create({ name: "Files" }).agent,
    other = f.gateway.create({ name: "Other" }).agent;
  const bytes = Buffer.from("First part\nSecond part");
  const args = {
    agentId: bot.id,
    filename: "notes.txt",
    uploadId: "fixture-upload",
    totalSize: bytes.length,
  };
  let part = {
    ...args,
    offset: 0,
    bytesBase64: bytes.subarray(0, 5).toString("base64"),
  };
  assert.deepEqual(await f.gateway.dispatch("uploadAttachmentChunk", part), {
    committedPath: null,
  });
  assert.deepEqual(await f.gateway.dispatch("uploadAttachmentChunk", part), {
    committedPath: null,
  });
  const reopened = new Attachments(f.dataDir);
  const result = reopened.chunk({
    ...args,
    offset: 5,
    bytesBase64: bytes.subarray(5).toString("base64"),
  });
  check("uploadAttachmentChunk", result);
  assert.ok(result.committedPath);
  assert.equal(reopened.chunk(part).committedPath, result.committedPath);
  assert.throws(
    () =>
      reopened.chunk({
        ...part,
        bytesBase64: Buffer.from("wrong").toString("base64"),
      }),
    /differs/,
  );
  const read = await f.gateway.dispatch("readAttachmentText", {
    agentId: bot.id,
    path: result.committedPath,
  });
  check("readAttachmentText", read);
  assert.equal(read.text, bytes.toString());
  assert.throws(
    () => reopened.readText({ agentId: other.id, path: result.committedPath }),
    /different Bot/,
  );
  check(
    "readAttachmentChunk",
    reopened.readChunk({ path: result.committedPath, offset: 2, length: 5 }),
  );
  const probe = reopened.readChunk({
    path: result.committedPath,
    offset: 0,
    length: 0,
  });
  assert.equal(probe.bytesBase64, "");
  assert.equal(probe.totalSize, bytes.length);
  const image = reopened.upload({
    agentId: bot.id,
    filename: "pixel.png",
    bytesBase64: png.toString("base64"),
  });
  check("readAttachmentImage", reopened.readImage(image));
  assert.equal(reopened.parts(image.path, bot.id)[0].type, "input_image");
  const pdf = reopened.upload({
    agentId: bot.id,
    filename: "test.pdf",
    bytesBase64: Buffer.from("%PDF-1.7\nfixture").toString("base64"),
  });
  assert.equal(reopened.parts(pdf.path, bot.id)[0].type, "input_file");
  assert.throws(
    () =>
      reopened.upload({
        filename: "fake.png",
        bytesBase64: Buffer.from("bad").toString("base64"),
      }),
    /match/,
  );
  await f.gateway.send({
    agentId: bot.id,
    prompt: "",
    attachmentPaths: [result.committedPath],
    clientNonce: "file-nonce",
  });
  await settle();
  check("getAgentTranscript", f.gateway.entries(bot.id));
  await assert.rejects(
    f.gateway.send({
      agentId: bot.id,
      prompt: "",
      attachmentPaths: [image.path],
      clientNonce: "file-nonce",
    }),
    /different input/,
  );
  assert.equal(f.gateway.entries(bot.id).at(-1).content, "FILE_OK");
  const content = reopened.content(
    f.gateway.entries(bot.id)[1],
    f.gateway.entries(bot.id),
  );
  assert.equal(content[1].type, "grok_attachment");
  assert.match(
    reopened.hydrate([{ role: "user", content }], bot.id)[0].content[1].text,
    /Second part/,
  );
  assert.equal(
    reopened.content({ content: "old" }, [
      { kind: "user-attachment", file_path: image.path },
    ]),
    "old",
  );
});
test("attachment model path resolves bytes only at inference and keeps references in memory", async (t) => {
  const f = fixture(t);
  const agent = f.gateway.create({ name: "Attached model" }).agent;
  const store = new AgentStore(f.dataDir),
    skills = new AgentSkills(store);
  let seen = false;
  const runtime = new AgentRuntime({
    store,
    skills,
    gateway: f.gateway,
    getPermission: () => "always",
    getModel: () => "fixture",
    modelCatalog: async () => [{ slug: "fixture", context_window: 100000 }],
    nativeTools: { catalog: [], images: () => [] },
    provider: {
      complete: async (input) => {
        assert.match(input.input.at(-1).content[1].text, /ATTACHMENT_MODEL_OK/);
        seen = true;
        return {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Read it." }],
            },
          ],
        };
      },
    },
  });
  f.gateway.runModel = (args) => runtime.run(args);
  const ref = f.gateway.attachments.upload({
    agentId: agent.id,
    filename: "read.txt",
    bytesBase64: Buffer.from("ATTACHMENT_MODEL_OK").toString("base64"),
  });
  await f.gateway.send({
    agentId: agent.id,
    prompt: "Read this file",
    attachmentPaths: [ref.path],
  });
  await settle();
  assert.ok(seen);
  assert.ok(
    !JSON.stringify(store.input(agent.id)).includes("ATTACHMENT_MODEL_OK"),
  );
  assert.match(JSON.stringify(store.input(agent.id)), /grok_attachment/);
});
test("shared pstack installs at app root, reaches every Bot and can read bounded references", (t) => {
  const dir = temp(t),
    store = new AgentStore(dir),
    skills = new AgentSkills(store, {
      bundled: path.resolve("src/skill-packs/pstack"),
    });
  const agent = { id: "a", path: path.join(dir, "a") },
    other = { id: "b", path: path.join(dir, "b") };
  assert.equal(
    skills.list(agent).filter((x) => x.id.startsWith("pstack-")).length,
    26,
  );
  assert.equal(
    skills.list(other).filter((x) => x.id.startsWith("pstack-")).length,
    26,
  );
  assert.match(skills.shared.instructions(), /Prove It Works/);
  assert.match(skills.read(agent, "pstack-architect").body, /Architect/);
  assert.throws(
    () => skills.read(agent, "pstack-architect", "../../pack.json"),
    /outside/,
  );
  assert.ok(fs.existsSync(path.join(dir, "skills/AGENTS.md")));
});
test("scheduled task queues behind interactive work, runs once and retains a restart-safe occurrence key", async (t) => {
  let now = Date.parse("2026-11-10T01:00:00Z"),
    calls = 0;
  const f = fixture(t, async () => {
      calls++;
      return "SCHEDULE_OK";
    }),
    bot = f.gateway.create({ name: "Schedule" }).agent;
  const a = new Automations({
    dataDir: f.dataDir,
    gateway: f.gateway,
    now: () => now,
  });
  f.gateway.automations = a;
  const item = a.save(bot.id, {
    name: "Once",
    prompt: "Read workspace",
    runAt: new Date(now + 5000).toISOString(),
    timeZone: "Australia/Brisbane",
  });
  check("getAgentAutomations", a.original(bot.id));
  f.gateway.jobs.set(bot.id, new AbortController());
  now += 5000;
  await a.tick();
  await a.tick();
  assert.equal(calls, 0);
  assert.equal(f.gateway.tasks.list().length, 1);
  assert.equal(f.gateway.tasks.list()[0].status, "queued");
  assert.equal(item.isEnabled, false);
  f.gateway.jobs.delete(bot.id);
  await f.gateway.tasks.start();
  await settle();
  assert.equal(calls, 1);
  assert.equal(item.running, false);
  const restored = new Automations({
    dataDir: f.dataDir,
    gateway: f.gateway,
    now: () => now,
  });
  await restored.tick();
  assert.equal(calls, 1);
  // Simulate crash between task acceptance and scheduler acknowledgement.
  const recurring = a.save(bot.id, {
    name: "Cron",
    prompt: "Check",
    schedule: "* * * * *",
    timeZone: "UTC",
  });
  now = recurring.nextRunAt;
  const pending = {
    key: `schedule:${recurring.id}:${recurring.nextRunAt}`,
    scheduledAt: now,
  };
  recurring.pendingDispatch = pending;
  a.persist(recurring);
  await f.gateway.tasks.submit({
    agentId: bot.id,
    prompt: "Scheduled task: Cron\nCheck",
    title: "Cron",
    origin: { kind: "schedule", scheduleId: recurring.id },
    key: pending.key,
  });
  await settle();
  const reopened = new Automations({
    dataDir: f.dataDir,
    gateway: f.gateway,
    now: () => now,
  });
  f.gateway.automations = reopened;
  await reopened.tick();
  await reopened.tick();
  await settle();
  assert.equal(calls, 2);
  assert.equal(f.gateway.tasks.list().length, 2);
});
test("schedules validate timezones, prevent overlaps, catch up once and skip missed one-time work", async (t) => {
  let now = Date.parse("2026-11-10T01:00:00Z");
  const f = fixture(t, async () => "ok"),
    bot = f.gateway.create({}).agent;
  const a = new Automations({
    dataDir: f.dataDir,
    gateway: f.gateway,
    now: () => now,
  });
  f.gateway.automations = a;
  assert.throws(
    () => a.save(bot.id, { name: "Bad", prompt: "x", runAt: "tomorrow" }),
    /ISO/,
  );
  assert.throws(() =>
    a.save(bot.id, {
      name: "Bad",
      prompt: "x",
      schedule: "* * * * *",
      timeZone: "no-such-zone",
    }),
  );
  const item = a.save(bot.id, {
    name: "Skip",
    prompt: "x",
    runAt: new Date(now + 1000).toISOString(),
  });
  now += 120000;
  await a.tick();
  assert.equal(item.isEnabled, false);
  assert.equal(f.gateway.tasks.list().length, 0);
  const catchup = a.save(bot.id, {
    name: "Catch up",
    prompt: "x",
    runAt: new Date(now + 1000).toISOString(),
    missed: "once",
  });
  now += 120000;
  await a.tick();
  await assert.rejects(a.run(bot.id, catchup.id), /already/);
  await settle();
  assert.equal(f.gateway.tasks.list().length, 1);
  const next = a.next("0 9 * * *", "Australia/Brisbane");
  assert.equal(new Date(next).getUTCHours(), 23);
});
test("CLI connections run real argv without a shell and keep account commands outside the model interface", async (t) => {
  const dir = temp(t);
  let grants = [];
  const c = new Connectors({
    dataDir: dir,
    fetch,
    authorize: async (...args) => {
      grants.push(args[2]);
    },
  });
  t.after(() => c.close());
  const file = path.join(dir, "fixture.cjs");
  fs.writeFileSync(
    file,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
  );
  await c.add({
    id: "custom",
    name: "Custom",
    kind: "cli",
    command: process.execPath,
    args: [file],
    prefixes: ["read"],
  });
  assert.equal((await c.tools("custom"))[0].name, "run");
  const result = await c.call(
    "custom",
    "run",
    { argv: ["read", "$(touch /tmp/SHOULD_NOT_EXIST)", "hello world"] },
    undefined,
    { agent: { id: "a" } },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [
    "read",
    "$(touch /tmp/SHOULD_NOT_EXIST)",
    "hello world",
  ]);
  assert.equal(grants[0].capability, "connectionSetup");
  assert.equal(grants[1].capability, "connections");
  await assert.rejects(
    c.call("custom", "run", { argv: ["auth", "export"] }),
    /outside/,
  );
  assert.throws(
    () =>
      cli.checkArgs({ service: "gmail", prefixes: ["gmail", "schema"] }, [
        "schema",
        "drive.files.list",
      ]),
    /service/,
  );
  assert.throws(
    () =>
      cli.checkArgs({ service: "github", prefixes: ["api"] }, [
        "api",
        "https://evil.example",
      ]),
    /resource paths/,
  );
  assert.throws(
    () =>
      cli.checkArgs({ service: "github", prefixes: ["api"] }, [
        "api",
        "user",
        "--header",
        "Authorization: token x",
      ]),
    /headers/,
  );
  assert.ok(!JSON.stringify(c.describe()).includes("env"));
});
test("unattended grants, desktop ownership, lock waiting and cancellation are enforced by the host", async (t) => {
  const f = fixture(t),
    a = f.gateway.create({ name: "A" }).agent,
    b = f.gateway.create({ name: "B" }).agent;
  const background = new Background({
    dataDir: f.dataDir,
    gateway: f.gateway,
    electron: {},
  });
  f.gateway.tasks.running.set(a.id, { origin: { kind: "background" } });
  assert.equal(
    await background.authorize({ agent: a, capability: "workspace" }),
    true,
  );
  await assert.rejects(
    background.authorize({ agent: a, capability: "shell" }),
    /standing grant/,
  );
  await assert.rejects(
    background.authorize({ agent: a, capability: "connectionSetup" }),
    /standing grant/,
  );
  await assert.rejects(
    background.authorize({
      agent: a,
      capability: "connections",
      automatic: false,
    }),
    /standing grant/,
  );
  assert.equal(
    await background.authorize({
      agent: a,
      capability: "connections",
      automatic: true,
    }),
    true,
  );
  assert.equal(
    await background.authorize({ agent: b, capability: "shell" }),
    false,
  );
  await background.acquire(a);
  let acquired = false;
  const waiting = background.acquire(b).then(() => (acquired = true));
  await settle();
  assert.equal(acquired, false);
  background.release(a.id);
  await waiting;
  assert.equal(acquired, true);
  background.release(b.id);
  background.locked = true;
  const stop = new AbortController();
  const locked = background.acquire(a, stop.signal);
  stop.abort();
  await assert.rejects(locked);
  assert.equal(background.owner, null);
  let unlocked = false;
  const locked2 = background.acquire(a).then(() => (unlocked = true));
  await settle();
  assert.equal(unlocked, false);
  background.locked = false;
  background.wake();
  await locked2;
  assert.equal(unlocked, true);
});
test("pausing a queued job keeps the active Bot owner and one-time routine edits preserve the date", async (t) => {
  const f = fixture(t, async () => new Promise(() => {})),
    bot = f.gateway.create({}).agent;
  const active = await f.gateway.tasks.submit({
    agentId: bot.id,
    prompt: "Active",
  });
  const queued = await f.gateway.tasks.submit({
    agentId: bot.id,
    prompt: "Queued",
  });
  f.gateway.tasks.pause(queued.id);
  assert.equal(f.gateway.tasks.running.get(bot.id).id, active.id);
  let now = Date.parse("2026-11-10T00:00:00Z");
  const scheduler = new Automations({
    dataDir: f.dataDir,
    gateway: f.gateway,
    now: () => now,
  });
  f.gateway.automations = scheduler;
  const item = scheduler.save(bot.id, {
    name: "Once",
    prompt: "x",
    runAt: new Date(now + 3600000).toISOString(),
  });
  const view = scheduler.original(bot.id)[0];
  await f.gateway.dispatch("updateAgentAutomation", {
    id: bot.id,
    automationId: item.id,
    spec: { name: "Renamed", prompt: "y", trigger: view.trigger },
  });
  assert.equal(scheduler.get(bot.id, item.id).runAt, now + 3600000);
  assert.equal(scheduler.get(bot.id, item.id).schedule, null);
});
test("per-Bot standing grants and hours survive restart without changing another Bot", async (t) => {
  const f = fixture(t),
    a = f.gateway.create({ name: "A" }).agent,
    b = f.gateway.create({ name: "B" }).agent;
  const bg = new Background({
    dataDir: f.dataDir,
    gateway: f.gateway,
    electron: {},
  });
  await bg.configure({
    policy: {
      agentId: a.id,
      computer: false,
      apps: ["com.apple.TextEdit"],
      timeWindow: {
        start: "09:00",
        end: "17:00",
        timeZone: "Australia/Brisbane",
      },
    },
  });
  assert.equal(bg.policy(a.id).computer, false);
  assert.equal(bg.policy(b.id).computer, true);
  assert.deepEqual(bg.policy(a.id).apps, ["com.apple.TextEdit"]);
  const restored = new Background({
    dataDir: f.dataDir,
    gateway: f.gateway,
    electron: {},
  });
  assert.deepEqual(restored.policy(a.id), bg.policy(a.id));
  await assert.rejects(
    bg.configure({
      policy: { agentId: a.id, timeWindow: { start: "25:00", end: "17:00" } },
    }),
    /HH:mm/,
  );
});
test("a denied unattended tool pauses its durable task with a confirmed error output", async (t) => {
  const f = fixture(t),
    bot = f.gateway.create({}).agent,
    store = new AgentStore(f.dataDir),
    skills = new AgentSkills(store);
  const runtime = new AgentRuntime({
    store,
    skills,
    gateway: f.gateway,
    getPermission: () => "ask",
    getModel: () => "fixture",
    modelCatalog: async () => [{ slug: "fixture", context_window: 100000 }],
    nativeTools: {
      catalog: [],
      images: () => [],
      shell: async () => {
        const e = new Error("Standing grant required");
        e.code = "TASK_NEEDS_ATTENTION";
        throw e;
      },
    },
    provider: {
      complete: async () => ({
        output: [
          {
            type: "function_call",
            name: "shell",
            namespace: "grok_bot",
            call_id: "blocked",
            arguments: '{"command":"echo blocked"}',
          },
        ],
      }),
    },
  });
  f.gateway.contextStore = store;
  f.gateway.runModel = (args) => runtime.run(args);
  const task = await f.gateway.tasks.submit({
    agentId: bot.id,
    prompt: "Background shell test",
  });
  const settled = await f.gateway.tasks.wait(f.gateway.tasks.get(task.id));
  assert.equal(settled.status, "paused");
  assert.match(settled.error, /Standing grant/);
  assert.equal(
    store.load(bot.id).turns.at(-1).items.at(-1).type,
    "function_call_output",
  );
  assert.equal(
    store.load(bot.id).executions[settled.turnId + ":blocked"].status,
    "done",
  );
});
test("stopping a Mac action terminates pending helper input and the next task gets a fresh helper", async (t) => {
  const { MacClient } = require("../runtime/mac-client.cjs");
  const dir = temp(t),
    helper = path.join(dir, "helper"),
    started = path.join(dir, "started"),
    effect = path.join(dir, "effect");
  fs.writeFileSync(
    helper,
    `#!${process.execPath}\nconst fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;const reply=()=>process.stdout.write(JSON.stringify({id:r.id,result:{pid:process.pid}})+'\\n');if(r.params?.arguments?.delayed){fs.writeFileSync(${JSON.stringify(started)},String(process.pid));setTimeout(()=>{fs.writeFileSync(${JSON.stringify(effect)},'UNWANTED_ACTION');reply();},500);}else reply();});`,
    { mode: 0o700 },
  );
  const client = new MacClient(helper);
  t.after(() => client.close());
  const controller = new AbortController();
  const delayed = client.call("fixture", { delayed: true }, controller.signal);
  delayed.catch(() => {});
  for (let i = 0; i < 100 && !fs.existsSync(started); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(started));
  const previous = Number(fs.readFileSync(started, "utf8"));
  controller.abort();
  await assert.rejects(delayed, /stopped/);
  const fresh = await client.call("fixture", {});
  assert.notEqual(fresh.pid, previous);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(fs.existsSync(effect), false);
});

test("Mac office extraction reads real zipped DOCX, XLSX and PPTX bytes without extracting paths", (t) => {
  const cp = require("child_process"),
    dir = temp(t),
    attachments = new Attachments(dir);
  const sources = {
    docx: {
      "[Content_Types].xml":
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      "_rels/.rels":
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      "word/document.xml":
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX-3817</w:t></w:r></w:p></w:body></w:document>',
    },
    xlsx: {
      "xl/sharedStrings.xml":
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>SHEET-8142</t></si></sst>',
      "xl/worksheets/sheet1.xml":
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
    },
    pptx: {
      "ppt/slides/slide1.xml":
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><a:p><a:r><a:t>SLIDE-6182</a:t></a:r></a:p></p:cSld></p:sld>',
    },
  };
  for (const [ext, entries] of Object.entries(sources)) {
    const folder = path.join(dir, "source-" + ext),
      file = path.join(dir, "fixture." + ext);
    fs.mkdirSync(folder);
    for (const [name, xml] of Object.entries(entries)) {
      fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
      fs.writeFileSync(path.join(folder, name), xml);
    }
    cp.execFileSync("/usr/bin/zip", ["-q", "-r", file, "."], { cwd: folder });
    const ref = attachments.store(
      "fixture." + ext,
      fs.readFileSync(file),
      "owner",
    );
    const text = attachments.readText({ path: ref.path, agentId: "owner" });
    assert.equal(text.kind, "text");
    assert.match(
      text.text,
      new RegExp(
        { docx: "DOCX-3817", xlsx: "SHEET-8142", pptx: "SLIDE-6182" }[ext],
      ),
    );
  }
});
