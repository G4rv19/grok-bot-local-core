"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJSON } = require("./agent-store.cjs");
const { cleanRoutingText } = require("./task-presentation.cjs");

class AgentTasks {
  constructor({ dataDir, gateway }) {
    this.directory = path.join(dataDir, "tasks");
    this.gateway = gateway;
    this.tasks = new Map();
    this.running = new Map();
    this.waiters = new Map();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of fs
      .readdirSync(this.directory)
      .filter((file) => file.endsWith(".json"))) {
      const task = JSON.parse(
        fs.readFileSync(path.join(this.directory, file), "utf8"),
      );
      task.origin ||= { kind: "delegation" };
      task.title ||=
        typeof task.prompt === "string"
          ? task.prompt.split("\n")[0].slice(0, 100)
          : "Saved task";
      if (task.delivered === undefined)
        task.delivered = ["completed", "canceled", "failed", "paused"].includes(
          task.status,
        );
      if (["submitted", "working"].includes(task.status)) {
        task.status = "queued";
        task.progress = "Progress saved; waiting to reconnect.";
      }
      this.tasks.set(task.id, task);
      this.save(task);
    }
  }
  save(task) {
    task.updatedAt = Date.now();
    writeJSON(path.join(this.directory, task.id + ".json"), task);
    this.gateway.workChanged?.(task.from, task.to);
  }
  list(agentId) {
    return [...this.tasks.values()]
      .filter(
        (task) => !agentId || task.from === agentId || task.to === agentId,
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("This task could not be found");
    return task;
  }
  owned(id, requester) {
    const task = this.get(id);
    if (requester && requester !== task.from && requester !== task.to)
      throw new Error("This task belongs to another Bot");
    return task;
  }
  async wait(task, signal) {
    if (!["submitted", "queued", "working"].includes(task.status))
      return { ...task };
    let finish, rejectAbort;
    const completion = new Promise((resolve) => {
      finish = resolve;
      if (!this.waiters.has(task.id)) this.waiters.set(task.id, new Set());
      this.waiters.get(task.id).add(resolve);
    });
    const aborted = new Promise((resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      this.cancel(task.id, task.from);
      rejectAbort(new Error("The task wait was stopped"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      return await Promise.race([completion, aborted]);
    } finally {
      signal?.removeEventListener("abort", cancel);
      const listeners = this.waiters.get(task.id);
      listeners?.delete(finish);
      if (!listeners?.size) this.waiters.delete(task.id);
    }
  }
  setTurn(id, turnId) {
    const task = this.get(id);
    task.turnId = turnId;
    this.save(task);
  }
  progress(id, detail, milestone = false) {
    const task = this.get(id),
      description = cleanRoutingText(detail, this.gateway);
    task.activity = description;
    task.lastActivityAt = Date.now();
    if (milestone) {
      task.progress = description;
      task.lastMilestone = description;
    } else if (!task.lastMilestone) task.progress = description;
    const turn = this.gateway.contextStore
      ?.load(task.to)
      .turns.find((turn) => turn.id === task.turnId);
    if (turn) {
      task.steps = turn.steps || 0;
      task.checkpoints = turn.checkpoints || 0;
    }
    this.save(task);
  }
  async launch(task, allowUncertain = false) {
    if (this.gateway.jobs.has(task.to) || this.running.has(task.to))
      throw new Error(`${this.gateway.agent(task.to).name} is already working`);
    this.running.set(task.to, task);
    task.status = "working";
    task.progress = task.turnId ? "Continuing the task" : "Starting the task";
    task.error = null;
    this.save(task);
    const requestKey = `a2a-request:${task.id}`;
    if (
      task.from !== task.to &&
      !this.gateway
        .entries(task.from)
        .some((entry) => entry.batchId === requestKey)
    )
      this.gateway.append(task.from, "assistant", task.prompt, {
        batchId: requestKey,
        toAgent: {
          id: task.to,
          name: this.gateway.agent(task.to).name,
          kind: "agent",
        },
      });
    const turnId =
      task.turnId ||
      this.gateway.entries(task.to).find((entry) => entry.taskId === task.id)
        ?.id;
    try {
      await this.gateway.send({
        agentId: task.to,
        prompt: task.prompt,
        taskId: task.id,
        attachmentPaths: task.attachments || [],
        ...(turnId ? { resumeTurnId: turnId } : {}),
        allowUncertain,
      });
    } catch (error) {
      this.finish(task.id, { error: error.message, paused: true });
    }
  }
  async delegate({
    from,
    to,
    prompt,
    title,
    wait = true,
    signal,
    key,
    attachments = [],
  }) {
    this.gateway.agent(from);
    this.gateway.agent(to);
    const existing =
      key && [...this.tasks.values()].find((task) => task.key === key);
    if (existing) {
      if (existing.status === "queued" && !this.running.has(to))
        await this.launch(existing);
      return wait ? this.wait(existing, signal) : { ...existing };
    }
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100000)
      throw new Error("Enter a task under 100,000 characters");
    const parent = this.running.get(from),
      ancestry = [...(parent?.ancestry || []), from];
    if (ancestry.includes(to))
      throw new Error(
        "These Bots cannot delegate back to each other in a loop",
      );
    if (ancestry.length > 4)
      throw new Error("Delegation is limited to four levels");
    if (this.gateway.jobs.has(to) || this.running.has(to))
      throw new Error(`${this.gateway.agent(to).name} is already working`);
    if (!Array.isArray(attachments) || attachments.length > 10)
      throw new Error("Attach up to 10 files");
    for (const ref of attachments)
      this.gateway.attachments.share(ref, from, to);
    const task = {
      id: crypto.randomUUID(),
      from,
      to,
      prompt,
      title: title?.trim().slice(0, 100) || prompt.split("\n")[0].slice(0, 100),
      ancestry,
      key,
      attachments,
      origin: { kind: "delegation" },
      unattended:
        !!parent &&
        (parent.background ||
          parent.unattended ||
          parent.origin?.kind !== "delegation"),
      background: !wait,
      status: "submitted",
      createdAt: Date.now(),
      result: null,
      progress: "Starting the task",
      steps: 0,
      checkpoints: 0,
      delivered: false,
    };
    this.tasks.set(task.id, task);
    this.save(task);
    await this.launch(task);
    return wait ? this.wait(task, signal) : { ...task };
  }
  async submit({
    agentId,
    prompt,
    title,
    origin = { kind: "background" },
    key,
    attachments = [],
  }) {
    this.gateway.agent(agentId);
    const prior = key && [...this.tasks.values()].find((x) => x.key === key);
    if (prior) return { ...prior };
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 100000)
      throw new Error("Enter a task under 100,000 characters");
    if (!["background", "schedule"].includes(origin.kind))
      throw new Error("Unknown task origin");
    const task = {
      id: crypto.randomUUID(),
      from: agentId,
      to: agentId,
      prompt,
      title: title?.trim().slice(0, 100) || prompt.split("\n")[0].slice(0, 100),
      origin,
      key,
      attachments,
      ancestry: [],
      background: true,
      status: "queued",
      createdAt: Date.now(),
      result: null,
      progress: "Queued",
      steps: 0,
      checkpoints: 0,
      delivered: false,
    };
    this.tasks.set(task.id, task);
    this.save(task);
    await this.start();
    return { ...task };
  }
  finish(id, { result, error, cancelled = false, paused = false }) {
    const task = this.get(id);
    const userPaused = task.pauseRequested;
    task.status = userPaused
      ? "paused"
      : cancelled
        ? "canceled"
        : paused || error
          ? "paused"
          : "completed";
    task.result = result || null;
    if (error) task.error = error;
    if (userPaused) task.error = null;
    task.progress = userPaused
      ? "Paused"
      : cancelled
        ? "Stopped"
        : error
          ? "Progress saved; needs attention"
          : "Finished";
    if (this.running.get(task.to)?.id === task.id) this.running.delete(task.to);
    this.save(task);
    if (task.origin?.kind === "schedule")
      this.gateway.automations?.finish(task.origin.scheduleId, error, task);
    this.deliver(task);
    for (const resolve of this.waiters.get(id) || []) resolve({ ...task });
    this.waiters.delete(id);
    if (!this.gateway.closing) setImmediate(() => this.start().catch(() => {}));
  }
  deliver(task) {
    if (task.delivered) return;
    if (task.from === task.to) {
      task.delivered = true;
      this.save(task);
      return;
    }
    const key = `a2a-result:${task.id}:${task.attempt || 0}`;
    if (
      !this.gateway.entries(task.from).some((entry) => entry.batchId === key)
    ) {
      const name = this.gateway.agent(task.to).name;
      const message =
        task.status === "completed"
          ? task.result || "Finished."
          : task.pauseRequested
            ? "Paused. Progress is saved."
            : task.status === "canceled"
              ? "Stopped. Progress is saved."
              : `Needs attention.\n\n${task.error}`;
      this.gateway.append(
        task.from,
        "assistant",
        cleanRoutingText(message, this.gateway),
        { batchId: key, fromAgent: { id: task.to, name, kind: "agent" } },
      );
    }
    task.delivered = true;
    this.save(task);
  }
  suspend(id) {
    const task = this.get(id);
    task.status = task.pauseRequested ? "paused" : "queued";
    task.progress = "Progress saved; continuing when the app reopens";
    if (this.running.get(task.to)?.id === task.id) this.running.delete(task.to);
    this.save(task);
  }
  cancel(id, requester) {
    const task = this.owned(id, requester);
    task.pauseRequested = false;
    if (!["submitted", "queued", "working", "paused"].includes(task.status))
      return task;
    if (this.running.get(task.to)?.id === id && this.gateway.jobs.has(task.to))
      this.gateway.jobs.get(task.to).abort();
    else this.finish(id, { cancelled: true });
    return task;
  }
  pause(id, requester) {
    const task = this.owned(id, requester);
    if (!["submitted", "queued", "working"].includes(task.status)) return task;
    task.pauseRequested = true;
    this.save(task);
    if (this.running.get(task.to)?.id === id && this.gateway.jobs.has(task.to))
      this.gateway.jobs.get(task.to).abort();
    else this.finish(id, { paused: true });
    return task;
  }
  async resume(id, requester, allowUncertain = false) {
    const task = this.owned(id, requester);
    if (!["paused", "failed", "queued"].includes(task.status))
      throw new Error("This task is already running or has finished");
    task.background = true;
    task.pauseRequested = false;
    task.attempt = (task.attempt || 0) + 1;
    task.delivered = false;
    await this.launch(task, allowUncertain);
    return { ...task };
  }
  async start() {
    if (this.gateway.closing || this.gateway.canRunAutomatic?.() === false)
      return;
    for (const task of this.list())
      if (
        task.delivered === false &&
        ["completed", "paused", "canceled", "failed"].includes(task.status)
      )
        this.deliver(task);
    // Deeper tasks restart first. Parent runs can then reattach to the same
    // delegation instead of creating another child or repeating its actions.
    for (const task of this.list()
      .filter((task) => task.status === "queued")
      .sort(
        (a, b) =>
          b.ancestry.length - a.ancestry.length || a.createdAt - b.createdAt,
      )) {
      if (this.gateway.canRunAutomatic?.(task.to) === false) continue;
      if (this.gateway.jobs.has(task.to) || this.running.has(task.to)) continue;
      await this.launch(task);
    }
  }
}
module.exports = { AgentTasks };
