"use strict";

// This adapter speaks the original gateway contract. Rendering, IPC, transcript
// handling, settings, and the coordinator remain the code shipped in the DMG.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { cleanRoutingText, taskTool } = require("./task-presentation.cjs");
const { Attachments } = require("./attachments.cjs");

function emptyValue(schema, contract, seen = new Set()) {
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return null;
    return emptyValue(
      contract.$defs[schema.$ref.split("/").pop()],
      contract,
      new Set([...seen, schema.$ref]),
    );
  }
  if (schema.const !== undefined) return schema.const;
  const choices = schema.anyOf || schema.oneOf;
  if (choices)
    return emptyValue(
      choices.find((x) => x.type === "null") || choices[0],
      contract,
      seen,
    );
  if (schema.enum) return schema.enum.includes(null) ? null : schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "array") return [];
  if (type === "object")
    return Object.fromEntries(
      (schema.required || []).map((k) => [
        k,
        emptyValue(schema.properties[k], contract, seen),
      ]),
    );
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return 0;
  if (type === "string") return "";
  return null;
}

class LocalGateway {
  constructor({ dataDir, contract, runModel }) {
    this.dataDir = dataDir;
    this.contract = contract;
    this.runModel = runModel;
    this.clients = new Set();
    this.jobs = new Map();
    this.attachments = new Attachments(dataDir);
    this.epoch = crypto.randomUUID();
    this.sequences = new Map();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.stateFile = path.join(dataDir, "local-conversations.json");
    this.state = fs.existsSync(this.stateFile)
      ? JSON.parse(fs.readFileSync(this.stateFile, "utf8"))
      : {
          version: 1,
          agents: [],
          transcripts: {},
          mainAgentId: null,
          nonces: {},
        };
    if (
      this.state.version !== 1 ||
      !Array.isArray(this.state.agents) ||
      !this.state.transcripts
    )
      throw new Error("Unrecognized local conversation file");
    for (const agent of this.state.agents) {
      agent.isRunning = false;
      agent.isRunningTurn = false;
      agent.isComposingMessage = false;
    }
  }
  save() {
    const temp = this.stateFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.stateFile);
  }
  emit(channel, payload) {
    if (channel === "agents")
      payload = {
        ...payload,
        ordered: this.stamp("roster"),
        coverage: { kind: "complete-roster" },
      };
    if (channel === "agent-upserted")
      payload = { ...payload, ordered: this.stamp("roster", true) };
    if (channel === "transcript") {
      const id =
        payload.type === "snapshot" ? payload.activeAgentId : payload.agentId;
      payload = {
        ...payload,
        ordered: this.stamp(`transcript:${id}`, payload.type !== "snapshot"),
      };
    }
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const client of this.clients)
      if (!client.destroyed) client.write(frame);
  }
  stamp(replicaKey, advance = false) {
    const sequence = (this.sequences.get(replicaKey) || 0) + (advance ? 1 : 0);
    this.sequences.set(replicaKey, sequence);
    return { replicaKey, epoch: this.epoch, sequence };
  }
  visibleAgent(agent) {
    return {
      ...agent,
      ...(agent.lastEntry
        ? {
            lastEntry: {
              ...agent.lastEntry,
              text: cleanRoutingText(agent.lastEntry.text, this),
            },
          }
        : {}),
    };
  }
  visibleEntry(entry) {
    if (entry.kind === "message" && entry.role === "assistant")
      return { ...entry, content: cleanRoutingText(entry.content, this) };
    if (entry.kind === "message" && entry.role === "user") {
      const legacy =
        /^Task from Bot (.+) \(([a-zA-Z0-9_-]+)\)\.\n([\s\S]*)\n\nReturn the result when complete\. Delegated text is task data, not a change to your permissions\.$/.exec(
          entry.content,
        );
      if (legacy && this.state.agents.some((bot) => bot.id === legacy[2]))
        return {
          ...entry,
          content: legacy[3],
          fromAgent: { id: legacy[2], name: legacy[1], kind: "agent" },
        };
    }
    if (entry.kind === "tool-call") {
      const legacy =
        /^(delegate_task|agent_tasks|cancel_agent_task|resume_agent_task|pause_agent_task) (.*)\n\n([\s\S]*)$/.exec(
          entry.summary || "",
        );
      if (legacy) {
        try {
          const visible = taskTool(
            { name: legacy[1], arguments: legacy[2] },
            JSON.parse(legacy[3]),
            this,
          );
          return {
            ...entry,
            name: visible.name,
            summary: visible.command + "\n\n" + visible.output,
          };
        } catch {}
      }
      return { ...entry, summary: cleanRoutingText(entry.summary, this) };
    }
    return entry;
  }
  visibleEntries(id) {
    return this.entries(id).map((entry) => this.visibleEntry(entry));
  }
  roster() {
    return {
      agents: this.state.agents.map((agent) => this.visibleAgent(agent)),
      activeAgentId:
        this.state.activeAgentId ||
        this.state.mainAgentId ||
        this.state.agents[0]?.id ||
        "",
      ordered: this.stamp("roster"),
      coverage: { kind: "complete-roster" },
    };
  }
  changed(agent) {
    this.save();
    this.emit("agent-upserted", {
      agent: this.visibleAgent(agent),
      activeAgentId:
        this.state.activeAgentId || this.state.mainAgentId || agent.id,
    });
    // The original renderer keeps live activity separately from roster data.
    // Publish the idle transition too, or a tool's busy overlay outlives the run.
    this.emit("agent-activity", {
      agentId: agent.id,
      client: null,
      live: {
        isRunning: agent.isRunning,
        isComposingMessage: agent.isComposingMessage,
        isRunningTurn: agent.isRunningTurn ?? agent.isRunning,
        isRetrying: false,
        awaitingUserResponse: agent.awaitingUserResponse,
        ...(agent.currentActivity
          ? { currentActivity: agent.currentActivity }
          : {}),
        ...(agent.lastTurnSettlement
          ? { lastTurnSettlement: agent.lastTurnSettlement }
          : {}),
      },
    });
  }
  agent(id) {
    const agent = this.state.agents.find((a) => a.id === id);
    if (!agent) throw new Error("This local Bot does not exist");
    return agent;
  }
  entries(id) {
    this.agent(id);
    return this.state.transcripts[id];
  }
  append(id, role, content, fields = {}) {
    const entries = this.entries(id);
    const entry = {
      id: crypto.randomUUID(),
      kind: "message",
      role,
      content,
      isStreaming: false,
      timestampMs: Date.now(),
      seq: (entries.at(-1)?.seq || 0) + 1,
      ...fields,
    };
    entries.push(entry);
    const agent = this.agent(id);
    agent.updatedAt = Date.now();
    agent.lastMessageId = entry.id;
    agent.lastEntry = { kind: "text", text: content.slice(0, 180) };
    this.changed(agent);
    this.emit("transcript", {
      type: "appended",
      agentId: id,
      entry: this.visibleEntry(entry),
    });
    return entry;
  }
  snapshot(id) {
    this.emit("transcript", {
      type: "snapshot",
      activeAgentId: id,
      entries: this.visibleEntries(id),
    });
  }
  appendTool(id, tool) {
    const entries = this.entries(id);
    const entry = {
      id: crypto.randomUUID(),
      kind: "tool-call",
      name: tool.name || "Local command",
      status: tool.exitCode === 0 ? "done" : "failed",
      summary: `${tool.command}\n\n${tool.output}`.slice(0, 12000),
      seq: (entries.at(-1)?.seq || 0) + 1,
      timestampMs: Date.now(),
    };
    entries.push(entry);
    this.save();
    this.emit("transcript", {
      type: "appended",
      agentId: id,
      entry: this.visibleEntry(entry),
    });
  }
  appendAttachment(id, meta, batchId) {
    const entries = this.entries(id),
      entry = {
        id: crypto.randomUUID(),
        kind: "user-attachment",
        file_path: meta.path,
        file_name: meta.name,
        byteSize: meta.bytes,
        batchId,
        timestampMs: Date.now(),
        seq: (entries.at(-1)?.seq || 0) + 1,
      };
    entries.push(entry);
    this.save();
    this.emit("transcript", { type: "appended", agentId: id, entry });
  }
  create(args) {
    const id = crypto.randomBytes(5).toString("hex");
    const now = Date.now();
    const agent = {
      id,
      name: args.name || "ChatGPT",
      description: args.description || "",
      path: path.join(this.dataDir, "workspaces", id),
      origin: "user",
      createdAt: now,
      updatedAt: now,
      avatarDataUrl: null,
      avatarShape: args.avatarShape || "circle",
      avatarColor: args.avatarColor || "#8688e7",
      awaitingUserResponse: null,
      hasUnread: false,
      isActive: true,
      isComposingMessage: false,
      isGroup: false,
      isRunning: false,
      lastEntry: null,
      lastMessageId: null,
      memberIds: [],
      notificationsEnabled: false,
      notifyOnUpdatesEnabled: false,
    };
    fs.mkdirSync(agent.path, { recursive: true });
    this.state.agents.push(agent);
    this.state.transcripts[id] = [];
    if (!this.state.mainAgentId) this.state.mainAgentId = id;
    this.changed(agent);
    this.emit("agents", this.roster());
    return { agent, transcript: [] };
  }
  async send(args) {
    const agent = this.agent(args.agentId);
    const refs = args.attachmentPaths || [],
      attachmentDigest = crypto
        .createHash("sha256")
        .update(JSON.stringify(refs))
        .digest("hex");
    if (!Array.isArray(refs) || refs.length > 10)
      throw new Error("Attach up to 10 files");
    if (args.clientNonce && this.state.nonces[args.clientNonce]) {
      const prior = this.state.nonces[args.clientNonce];
      if (
        prior.agentId !== agent.id ||
        prior.inputDigest !==
          crypto.createHash("sha256").update(args.prompt).digest("hex") ||
        (prior.attachmentDigest ||
          crypto.createHash("sha256").update("[]").digest("hex")) !==
          attachmentDigest
      )
        throw new Error("This message ID was already used for different input");
      return { accepted: true };
    }
    if (this.jobs.has(agent.id))
      throw new Error(
        "Wait for this Bot to finish, or stop its current response",
      );
    if (
      typeof args.prompt !== "string" ||
      (!args.prompt.trim() && !refs.length) ||
      args.prompt.length > 200000
    )
      throw new Error(
        "Enter a message under 200,000 characters or attach a file",
      );
    const attached = refs.map((ref) => this.attachments.claim(ref, agent.id));
    if (attached.reduce((sum, x) => sum + x.bytes, 0) > 25 * 1024 * 1024)
      throw new Error("Combined attachments must be under 25 MB");
    const task = args.taskId && this.tasks.get(args.taskId);
    const source = task && task.from !== task.to && this.agent(task.from),
      batchId = crypto.randomUUID();
    if (!args.resumeTurnId)
      for (const meta of attached)
        this.appendAttachment(agent.id, meta, batchId);
    const entry = args.resumeTurnId
      ? this.entries(agent.id).find((entry) => entry.id === args.resumeTurnId)
      : this.append(agent.id, "user", args.prompt, {
          batchId,
          ...(args.clientNonce ? { clientNonce: args.clientNonce } : {}),
          ...(task ? { taskId: task.id } : {}),
          ...(source
            ? { fromAgent: { id: source.id, name: source.name, kind: "agent" } }
            : {}),
        });
    if (!entry)
      throw new Error("The saved task conversation could not be found");
    if (task) this.tasks.setTurn(task.id, entry.id);
    if (args.clientNonce)
      this.state.nonces[args.clientNonce] = {
        agentId: agent.id,
        acceptedAtMs: Date.now(),
        clientNonce: args.clientNonce,
        accountSlot: "grokbot-local-user",
        echoEntryId: entry.id,
        inputDigest: crypto
          .createHash("sha256")
          .update(args.prompt)
          .digest("hex"),
        attachmentDigest,
        rejectionCode: null,
        status: "accepted",
      };
    agent.isRunning = true;
    agent.isRunningTurn = true;
    agent.isComposingMessage = false;
    delete agent.lastTurnSettlement;
    this.changed(agent);
    const controller = new AbortController();
    this.jobs.set(agent.id, controller);
    const history = args.resumeTurnId
      ? this.entries(agent.id).slice(
          0,
          this.entries(agent.id).indexOf(entry) + 1,
        )
      : this.entries(agent.id).slice();
    setImmediate(async () => {
      let result, failure, failureCode;
      try {
        const answer = await this.runModel({
          agent,
          history,
          turnId: entry.id,
          signal: controller.signal,
          resume: !!args.resumeTurnId,
          allowUncertain: !!args.allowUncertain,
          onTool: (tool) => this.appendTool(agent.id, tool),
          onActivity: (detail) => {
            if (task) this.tasks.progress(task.id, detail);
            agent.isComposingMessage = detail === "Thinking";
            agent.currentActivity = {
              kind: detail === "Thinking" ? "thinking" : "tool",
              detail,
            };
            this.changed(agent);
          },
        });
        if (
          answer &&
          !this.entries(agent.id).some(
            (item) => item.role === "assistant" && item.batchId === entry.id,
          )
        )
          this.append(agent.id, "assistant", answer, { batchId: entry.id });
        result = answer;
      } catch (error) {
        failure = error.message;
        failureCode = error.code;
        if (!this.closing)
          this.append(
            agent.id,
            "assistant",
            controller.signal.aborted
              ? task?.pauseRequested
                ? "Paused. Progress is saved."
                : "Stopped."
              : `${task ? "Progress saved." : "The local runtime could not finish:"} ${error.message}`,
          );
      } finally {
        this.jobs.delete(agent.id);
        agent.isRunning = false;
        agent.isRunningTurn = false;
        agent.isComposingMessage = false;
        delete agent.currentActivity;
        agent.lastTurnSettlement = {
          clientNonce: args.clientNonce || entry.clientNonce || entry.id,
          outcome: controller.signal.aborted
            ? "cancelled"
            : failure
              ? "error"
              : "success",
          settledAtMs: Date.now(),
        };
        this.changed(agent);
        this.nativeTools?.release(agent.id);
        if (args.taskId) {
          if (this.closing) this.tasks?.suspend(args.taskId);
          else
            this.tasks?.finish(args.taskId, {
              result,
              error: failure,
              cancelled: controller.signal.aborted,
              paused: failureCode === "TASK_NEEDS_ATTENTION",
            });
        }
        if (!this.closing)
          setImmediate(() => this.tasks?.start().catch(() => {}));
      }
    });
    return { accepted: true };
  }
  async dispatch(method, args = {}) {
    console.log("[grok-local:gateway]", method);
    switch (method) {
      case "resolveAgentCreation":
        return { kind: "box" };
      case "getServerAgentRoster":
        return { status: "ready", agents: [] };
      case "restoreTemporalAgentRouting":
        return null;
      case "getMainAgent":
        return {
          agentId: this.state.mainAgentId,
          agent:
            this.state.agents.find((a) => a.id === this.state.mainAgentId) ||
            null,
        };
      case "setMainAgent":
        this.agent(args.agentId);
        this.state.mainAgentId = args.agentId;
        this.save();
        return { agentId: args.agentId, agent: this.agent(args.agentId) };
      case "ensureDefaultMainAgent": {
        if (!this.state.mainAgentId)
          this.create({
            name: "ChatGPT",
            description: "Your local assistant, connected through ChatGPT.",
          });
        return { agentId: this.state.mainAgentId, outcome: "present" };
      }
      case "listAgents":
        return this.state.agents.map((agent) => this.visibleAgent(agent));
      case "countAgents":
        return this.state.agents.length;
      case "createAgent":
        return this.create(args);
      case "createAgentFromTemplate": {
        if (args.isAutomatic && this.state.mainAgentId)
          return {
            agent: this.agent(this.state.mainAgentId),
            transcript: this.entries(this.state.mainAgentId),
          };
        return this.create({
          ...args,
          name: args.name || "ChatGPT",
          description: "Local assistant using your ChatGPT account.",
        });
      }
      case "openAgent":
        this.agent(args.id);
        this.state.activeAgentId = args.id;
        this.save();
        this.snapshot(args.id);
        return {
          agent: this.visibleAgent(this.agent(args.id)),
          transcript: this.visibleEntries(args.id),
        };
      case "openAgentTail":
        this.agent(args.id);
        this.state.activeAgentId = args.id;
        this.save();
        this.snapshot(args.id); // fall through to the original transcript-page shape
      case "getAgentTranscriptTail":
      case "getAgentTranscriptWindow":
      case "getAgentTranscriptPage":
      case "getAgentTranscript": {
        const entries = this.visibleEntries(args.id).filter(
          (e) => args.beforeSeq == null || e.seq < args.beforeSeq,
        );
        const selected = entries.slice(-Math.min(args.limit || 200, 1000));
        const page = { entries: selected };
        if (method !== "getAgentTranscriptWindow")
          page.ordered = this.stamp(`transcript:${args.id}`);
        if (selected.length < entries.length)
          page.nextBeforeSeq = selected[0].seq;
        return method === "getAgentTranscript" ? entries : page;
      }
      case "sendPrompt":
        return this.send(args);
      case "uploadAttachment":
        return this.attachments.upload(args);
      case "uploadAttachmentChunk":
        return this.attachments.chunk(args);
      case "readAttachmentText":
        return this.attachments.readText(args);
      case "readAttachmentChunk":
        return this.attachments.readChunk(args);
      case "readAttachmentImage":
        return this.attachments.readImage(args);
      case "promptAcceptanceStatus": {
        const value = this.state.nonces[args.clientNonce];
        if (!value) return { outcome: "not-found" };
        const { attachmentDigest, ...record } = value;
        return { outcome: "found", record };
      }
      case "interruptAgentRun":
        this.jobs.get(args.id)?.abort();
        return {};
      case "startFreshConversation": {
        if (this.jobs.has(args.id))
          throw new Error("Stop the current response before starting fresh");
        this.contextStore?.commit(args.id, "reset", null);
        this.state.transcripts[args.id] = [];
        this.save();
        this.snapshot(args.id);
        return null;
      }
      case "updateAgent": {
        const agent = this.agent(args.id);
        for (const key of ["name", "description", "avatarColor", "avatarShape"])
          if (typeof args[key] === "string") agent[key] = args[key];
        this.changed(agent);
        return { agent };
      }
      case "setAgentUnread": {
        const agent = this.agent(args.id);
        agent.hasUnread = args.isUnread;
        this.changed(agent);
        return null;
      }
      case "setAgentHiddenFromSidebar": {
        const agent = this.agent(args.id);
        agent.isHiddenFromSidebar = args.isHidden;
        this.changed(agent);
        return {};
      }
      case "setAgentNotifyOnUpdates": {
        const agent = this.agent(args.id);
        agent.notifyOnUpdatesEnabled = args.isEnabled;
        this.changed(agent);
        return null;
      }
      case "getHostStatus":
        return {
          hostUpdateAvailable: false,
          hostVersion: "local-0.79.3",
          isBusy: this.jobs.size > 0,
          latestHostVersion: null,
          capabilities: [],
        };
      case "getForeverBoxStatus":
        return null;
      case "getHostSettings":
        return (
          this.state.hostSettings ||
          emptyValue(this.contract.methods.getHostSettings.reply, this.contract)
        );
      case "setHostSettings": {
        // Legacy desktop startup mirrors its old provider setting as null.
        if (
          args.computerUseModel === null &&
          this.state.hostSettings?.computerUseModel
        )
          args = {
            ...args,
            computerUseModel: this.state.hostSettings.computerUseModel,
          };
        this.state.hostSettings = {
          ...(await this.dispatch("getHostSettings")),
          ...args,
        };
        this.save();
        return this.state.hostSettings;
      }
      case "setWindowFocused":
        return null;
      case "setBoxSecrets": {
        if (Object.keys(args.secrets || {}).length)
          throw new Error("Hosted secret synchronization is disabled");
        return { isApplied: true, keys: [], lastAppliedAtMs: Date.now() };
      }
      case "ensureForeverBox":
      case "getCloudAgentInfo":
        throw new Error("Hosted computers are disabled in this local build");
      case "kickstartAgent":
        return { isIntroductionInFlight: false };
      case "getAgentAutomations":
        return this.automations?.original(args.id) || [];
      case "listAllAutomations":
        return this.state.agents.flatMap((agent) =>
          (this.automations?.original(agent.id) || []).map((automation) => ({
            agentId: agent.id,
            automation,
          })),
        );
      case "setAgentAutomationEnabled":
        this.automations.setEnabled(args.id, args.automationId, args.isEnabled);
        return this.automations.original(args.id);
      case "runAgentAutomationNow":
        await this.automations.run(args.id, args.automationId);
        return null;
      case "createAgentAutomation":
        this.automations.save(args.id, args.spec);
        return this.automations.original(args.id);
      case "updateAgentAutomation": {
        const previous = this.automations.get(args.id, args.automationId),
          display = this.automations
            .original(args.id)
            .find((x) => x.id === args.automationId);
        const sameDate =
          previous.runAt && args.spec.trigger?.schedule === display.schedule;
        this.automations.save(
          args.id,
          sameDate
            ? {
                ...args.spec,
                trigger: undefined,
                schedule: undefined,
                runAt: new Date(previous.runAt).toISOString(),
              }
            : args.spec,
          args.automationId,
        );
        return this.automations.original(args.id);
      }
      case "deleteAgentAutomation":
        this.automations.remove(args.id, args.automationId);
        return this.automations.original(args.id);
      case "readMainAgentContext":
        return { agentId: args.id, isWorking: this.jobs.has(args.id) };
      case "getAgentWorkflows":
        return this.skills?.list(this.agent(args.id)) || [];
      case "createAgentWorkflow":
        return this.skills.save(this.agent(args.id), args.spec);
      case "updateAgentWorkflow":
        return this.skills.save(
          this.agent(args.id),
          args.spec,
          args.workflowId,
        );
      case "deleteAgentWorkflow":
        return this.skills.remove(this.agent(args.id), args.workflowId);
      case "importAgentWorkflowText": {
        const prior = new Set(
          this.skills.list(this.agent(args.id)).map((skill) => skill.id),
        );
        const workflows = this.skills.save(this.agent(args.id), {
          name: args.name || "Imported skill",
          description: "Imported local skill",
          body: args.markdown,
          trigger: null,
        });
        const imported = workflows.find((skill) => !prior.has(skill.id));
        return {
          workflows,
          result: {
            imported: [{ id: imported.id, name: imported.name }],
            skipped: [],
          },
        };
      }
      case "runAgentWorkflowNow": {
        const skill = this.skills.read(this.agent(args.id), args.workflowId);
        await this.send({
          agentId: args.id,
          prompt: `Use the Grok Bot skill ${skill.name} (ID ${skill.id}). Read it first, then carry out its instructions.`,
        });
        return null;
      }
    }
    // Empty reads use the schemas embedded in the original coordinator. Unknown
    // mutations must fail instead of reporting success without doing the work.
    const schema = this.contract.methods[method]?.reply;
    if (
      schema &&
      /^(get|list|read|search|skillsCatalog|syncPluginSkills)/.test(method)
    )
      return emptyValue(schema, this.contract);
    throw new Error(`${method} is not available in the local adapter`);
  }
  async listen() {
    this.token = crypto.randomBytes(32).toString("hex");
    this.server = http.createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write(": local gateway\n\n");
        this.clients.add(res);
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 10000);
        res.on("close", () => {
          clearInterval(timer);
          this.clients.delete(res);
        });
        res.write(
          `data: ${JSON.stringify({ channel: "agents", payload: this.roster() })}\n\n`,
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/events/echo") {
        for (const client of this.clients)
          client.write(`:echo ${url.searchParams.get("nonce") || ""}\n\n`);
        res.end("{}");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (
          req.method !== "POST" ||
          !/^\/api\/[A-Za-z][A-Za-z0-9]*$/.test(url.pathname)
        ) {
          res.writeHead(404);
          res.end("{}");
          return;
        }
        if (req.headers.origin && req.headers.origin !== "null")
          throw new Error("Browser-origin requests are not accepted");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (
            body.length >
            (url.pathname === "/api/uploadAttachment" ? 30e6 : 2e6)
          )
            throw new Error("Request too large");
        }
        const args = JSON.parse(body || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Expected an argument object");
        res.end(
          JSON.stringify(await this.dispatch(url.pathname.slice(5), args)),
        );
      } catch (error) {
        console.error(
          "[grok-local:gateway:error]",
          url.pathname,
          error.message,
        );
        res.writeHead(400);
        res.end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  close() {
    this.closing = true;
    for (const job of this.jobs.values()) job.abort();
    for (const c of this.clients) c.end();
    this.server?.close();
  }
}

module.exports = { LocalGateway, emptyValue };
