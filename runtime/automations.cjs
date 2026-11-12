"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { CronExpressionParser } = require("cron-parser");
const { writeJSON } = require("./agent-store.cjs");
class Automations {
  constructor({ dataDir, gateway, now = Date.now }) {
    this.directory = path.join(dataDir, "automations");
    this.gateway = gateway;
    this.now = now;
    this.items = new Map();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of fs
      .readdirSync(this.directory)
      .filter((x) => x.endsWith(".json"))) {
      const item = JSON.parse(
        fs.readFileSync(path.join(this.directory, file), "utf8"),
      );
      item.missed ||= "skip";
      if (item.running && !item.activeTaskId && !item.pendingDispatch) {
        item.running = false;
        item.lastError =
          "A legacy run was interrupted; inspect its transcript before running again.";
      }
      if (
        !item.runAt &&
        item.nextRunAt < this.now() &&
        item.missed === "skip" &&
        !item.pendingDispatch
      )
        item.nextRunAt = this.next(item.schedule, item.timeZone);
      if (!item.deleted) this.items.set(item.id, item);
      this.persist(item);
    }
  }
  next(schedule, timeZone, from = this.now()) {
    return CronExpressionParser.parse(schedule, {
      currentDate: new Date(from),
      tz: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
      .next()
      .getTime();
  }
  persist(item) {
    writeJSON(path.join(this.directory, item.id + ".json"), item);
    this.gateway.workChanged?.(item.agentId);
  }
  list(agentId) {
    return [...this.items.values()].filter(
      (x) => !agentId || x.agentId === agentId,
    );
  }
  get(agentId, id) {
    const item = this.items.get(id);
    if (!item || item.agentId !== agentId || item.deleted)
      throw new Error("Unknown automation for this Bot");
    return item;
  }
  setEnabled(agentId, id, enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("isEnabled must be a boolean");
    const item = this.get(agentId, id);
    if (enabled && item.runAt && item.runAt <= this.now())
      throw new Error("Choose a future time to enable a one-time task");
    item.isEnabled = enabled;
    if (!item.runAt) item.nextRunAt = this.next(item.schedule, item.timeZone);
    this.persist(item);
  }
  save(agentId, spec, id) {
    this.gateway.agent(agentId);
    if (
      typeof spec.name !== "string" ||
      !spec.name.trim() ||
      typeof spec.prompt !== "string" ||
      !spec.prompt.trim() ||
      spec.prompt.length > 100000
    )
      throw new Error("Enter a name and task under 100,000 characters");
    const previous = id && this.items.get(id);
    if (id && (!previous || previous.agentId !== agentId))
      throw new Error("Unknown automation for this Bot");
    const timeZone =
      spec.timeZone ||
      previous?.timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat("en", { timeZone });
    if (spec.trigger && spec.trigger.type !== "cron")
      throw new Error("Use a one-time timestamp or cron schedule");
    const schedule = spec.schedule || spec.trigger?.schedule;
    if (spec.runAt && schedule)
      throw new Error("Choose a one-time date or recurring schedule");
    const runAt = spec.runAt ? Date.parse(spec.runAt) : null;
    if (
      spec.runAt &&
      (!Number.isFinite(runAt) ||
        runAt <= this.now() ||
        !/(Z|[+-]\d\d:\d\d)$/.test(spec.runAt))
    )
      throw new Error(
        "One-time tasks need a future ISO date with timezone offset",
      );
    if (!runAt && typeof schedule !== "string")
      throw new Error("Supply runAt or a cron schedule");
    if (spec.missed && !["skip", "once"].includes(spec.missed))
      throw new Error("Missed runs must be skip or once");
    const item = {
      ...previous,
      id: id || crypto.randomUUID(),
      agentId,
      name: spec.name.trim(),
      prompt: spec.prompt,
      runAt,
      schedule: runAt ? null : schedule,
      timeZone,
      missed: spec.missed || previous?.missed || "skip",
      requestKey: spec.requestKey || previous?.requestKey,
      requestDigest: spec.requestDigest || previous?.requestDigest,
      isEnabled: spec.isEnabled ?? previous?.isEnabled ?? true,
      createdAt: previous?.createdAt || this.now(),
      lastRunAt: previous?.lastRunAt || null,
      running: previous?.running || false,
      nextRunAt: runAt || this.next(schedule, timeZone),
    };
    this.items.set(item.id, item);
    this.persist(item);
    return item;
  }
  remove(agentId, id) {
    const item = this.get(agentId, id);
    item.isEnabled = false;
    item.deleted = true;
    this.persist(item);
    this.items.delete(id);
  }
  original(agentId) {
    return this.list(agentId).map((item) => {
      // The recovered renderer has a cron-only trigger union. Dispatch uses runAt.
      const date = item.runAt && new Date(item.runAt),
        parts =
          date &&
          Object.fromEntries(
            new Intl.DateTimeFormat("en-GB", {
              timeZone: item.timeZone,
              minute: "numeric",
              hour: "numeric",
              day: "numeric",
              month: "numeric",
              hourCycle: "h23",
            })
              .formatToParts(date)
              .map((x) => [x.type, x.value]),
          );
      const schedule =
        item.schedule ||
        `${Number(parts.minute)} ${Number(parts.hour)} ${Number(parts.day)} ${Number(parts.month)} *`;
      return {
        id: item.id,
        name: item.name,
        prompt: item.prompt,
        schedule,
        trigger: { type: "cron", schedule },
        triggerDescription: item.runAt
          ? `Once · ${date.toLocaleString("en-AU", { timeZone: item.timeZone })} (${item.timeZone})`
          : `${item.schedule} (${item.timeZone}); local background task`,
        filePath: path.join(this.directory, item.id + ".json"),
        createdAt: item.createdAt,
        isEnabled: item.isEnabled,
        lastRunAt: item.lastRunAt,
        nextRunAt: item.nextRunAt,
        runs: [],
        runHistoryUnavailable: true,
      };
    });
  }
  async tick() {
    if (this.ticking || this.gateway.canRunAutomatic?.() === false) return;
    this.ticking = true;
    try {
      await this.gateway.tasks.start();
      for (const item of this.items.values()) {
        if (item.activeTaskId) {
          const task = this.gateway.tasks.get(item.activeTaskId);
          if (["completed", "canceled", "failed"].includes(task.status))
            this.finish(item.id, task.error, task);
          else continue;
        }
        if (item.deleted || !item.isEnabled || item.nextRunAt > this.now())
          continue;
        if (
          item.runAt &&
          item.missed === "skip" &&
          this.now() - item.nextRunAt > 60000 &&
          !item.pendingDispatch
        ) {
          item.isEnabled = false;
          item.lastError =
            "The Mac was unavailable at the scheduled time; this run was skipped.";
          this.persist(item);
          continue;
        }
        try {
          await this.dispatch(item, false);
        } catch (error) {
          item.lastError = error.message;
          this.persist(item);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  async run(agentId, id) {
    return this.dispatch(this.get(agentId, id), true);
  }
  async dispatch(item, manual) {
    if (item.activeTaskId)
      throw new Error("This schedule already has a queued or active task");
    if (!item.pendingDispatch) {
      item.pendingDispatch = {
        key: `schedule:${item.id}:${manual ? "manual:" + crypto.randomUUID() : item.nextRunAt}`,
        scheduledAt: this.now(),
      };
      this.persist(item);
    }
    const pending = item.pendingDispatch;
    const task = await this.gateway.tasks.submit({
      agentId: item.agentId,
      prompt: `Scheduled task: ${item.name}\n${item.prompt}`,
      title: item.name,
      origin: { kind: "schedule", scheduleId: item.id },
      key: pending.key,
    });
    item.activeTaskId = task.id;
    item.running = true;
    item.lastRunAt = pending.scheduledAt;
    item.lastError = null;
    if (item.runAt) item.isEnabled = false;
    else item.nextRunAt = this.next(item.schedule, item.timeZone);
    delete item.pendingDispatch;
    this.persist(item);
    return task;
  }
  finish(id, error, task) {
    const item = this.items.get(id);
    if (!item) return;
    if (item.activeTaskId && task && item.activeTaskId !== task.id) return;
    item.running = task?.status === "paused";
    item.lastError = error || null;
    if (task) item.lastTaskId = task.id;
    if (!item.running) item.activeTaskId = null;
    this.persist(item);
  }
  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
  }
  close() {
    clearInterval(this.timer);
  }
}
module.exports = { Automations };
