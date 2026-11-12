"use strict";
const crypto = require("node:crypto");
const { cleanRoutingText } = require("./task-presentation.cjs");
const active = new Set(["submitted", "queued", "working"]);
function scheduleLabel(item) {
  if (item.runAt) return "Once";
  const fields = item.schedule.trim().split(/\s+/),
    [m, h, d, month, week] = fields;
  if (h === "*" && d === "*" && month === "*" && week === "*") {
    if (m === "*") return "Every minute";
    if (/^\*\/\d+$/.test(m)) return `Every ${m.slice(2)} minutes`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && d === "*" && month === "*") {
    const time = new Intl.DateTimeFormat("en-AU", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(Date.UTC(2000, 0, 1, +h, +m)));
    if (week === "*") return `Daily at ${time}`;
    if (week === "1-5") return `Weekdays at ${time}`;
    if (/^[0-6]$/.test(week))
      return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][+week]} at ${time}`;
  }
  return "Custom schedule";
}
function taskState(task) {
  return task.status === "paused" && task.error
    ? "attention"
    : task.status === "failed"
      ? "attention"
      : task.status === "submitted"
        ? "queued"
        : task.status;
}
function wallTime(value, timeZone) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
  )
    throw new Error("Choose a date and time");
  const parts = value.match(/\d+/g).map(Number),
    wanted = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]);
  if (new Date(wanted).toISOString().slice(0, 16) !== value)
    throw new Error("Choose a valid date and time");
  let guess = wanted;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((x) => [x.type, x.value]),
    );
    const actual = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    if (actual === wanted) return new Date(guess).toISOString();
    guess += wanted - actual;
  }
  throw new Error(
    "That time does not exist in this time zone. Choose another time.",
  );
}
class ChatWork {
  constructor(gateway) {
    this.gateway = gateway;
  }
  snapshot(agentId) {
    const g = this.gateway;
    g.agent(agentId);
    const tasks = g.tasks
      .list(agentId)
      .filter((x) => x.origin?.kind !== "schedule")
      .slice(0, 30)
      .map((task) => ({
        id: task.id,
        title: task.title,
        bot: g.agent(task.to).name,
        status: taskState(task),
        progress: cleanRoutingText(task.progress || "", g),
        result: task.result ? cleanRoutingText(task.result, g) : null,
        error: task.error ? cleanRoutingText(task.error, g) : null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        steps: task.steps || 0,
        checkpoints: task.checkpoints || 0,
        canPause: active.has(task.status),
        canResume: ["paused", "failed"].includes(task.status),
        canStop: active.has(task.status) || task.status === "paused",
      }));
    const schedules = g.automations.list(agentId).map((item) => {
      const run = item.activeTaskId && g.tasks.get(item.activeTaskId);
      const latest =
        (item.lastTaskId && g.tasks.get(item.lastTaskId)) ||
        g.tasks
          .list(agentId)
          .find((task) => task.origin?.scheduleId === item.id);
      const done =
        !!item.runAt &&
        latest?.status === "completed" &&
        !run &&
        !item.isEnabled;
      return {
        id: item.id,
        title: item.name,
        prompt: item.prompt,
        label: scheduleLabel(item),
        timeZone: item.timeZone,
        nextRunAt: item.isEnabled ? item.nextRunAt : null,
        lastRunAt: item.lastRunAt,
        enabled: item.isEnabled,
        status: run
          ? taskState(run)
          : item.lastError
            ? "attention"
            : done
              ? "completed"
              : item.isEnabled
                ? "scheduled"
                : latest?.status === "canceled"
                  ? "canceled"
                  : "paused",
        error: item.lastError || null,
        progress: run?.progress || null,
        result: run?.result || latest?.result || null,
        runAt: item.runAt,
        schedule: item.schedule,
        missed: item.missed,
        activeTaskId: run?.id || null,
        canPause: !!run && active.has(run.status),
        canResume: !!run && ["paused", "failed"].includes(run.status),
        canStop: !!run && (active.has(run.status) || run.status === "paused"),
        canRun: !run,
        createdAt: item.createdAt,
      };
    });
    return {
      agentId,
      botName: g.agent(agentId).name,
      tasks,
      schedules,
      background: g.background
        ? {
            enabled: g.background.canRun(agentId),
            paused: g.background.preferences.paused,
            locked: g.background.locked,
          }
        : null,
    };
  }
  spec(input) {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.name !== "string" ||
      typeof input.prompt !== "string"
    )
      throw new Error("Enter a name and instructions");
    const timeZone =
      input.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat("en", { timeZone });
    const result = {
      name: input.name,
      prompt: input.prompt,
      timeZone,
      isEnabled: input.enabled !== false,
      missed: input.missed || "skip",
    };
    if (input.frequency === "once") {
      result.runAt = wallTime(input.dateTime, timeZone);
      return result;
    }
    if (input.frequency === "custom") {
      result.schedule = input.schedule;
      return result;
    }
    if (
      !["daily", "weekdays", "weekly"].includes(input.frequency) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time || "")
    )
      throw new Error("Choose a repeat pattern and time");
    if (
      input.frequency === "weekly" &&
      (!Number.isInteger(input.weekday) ||
        input.weekday < 0 ||
        input.weekday > 6)
    )
      throw new Error("Choose a weekday");
    const [h, m] = input.time.split(":").map(Number);
    result.schedule = `${m} ${h} * * ${input.frequency === "daily" ? "*" : input.frequency === "weekdays" ? "1-5" : input.weekday}`;
    return result;
  }
  async dispatch(request) {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("Invalid task request");
    const { action = "status", agentId, id } = request,
      g = this.gateway;
    g.agent(agentId);
    switch (action) {
      case "status":
        break;
      case "start": {
        if (
          typeof request.nonce !== "string" ||
          !/^[\w-]{1,100}$/.test(request.nonce)
        )
          throw new Error("Missing task request key");
        const previous = g.tasks
          .list(agentId)
          .find((x) => x.key === `ui:${agentId}:${request.nonce}`);
        if (previous && previous.prompt !== request.prompt)
          throw new Error("This task request changed. Start a new task.");
        await g.tasks.submit({
          agentId,
          prompt: request.prompt,
          title: request.title,
          origin: { kind: "background" },
          key: `ui:${agentId}:${request.nonce}`,
        });
        break;
      }
      case "pause":
        g.tasks.pause(id, agentId);
        break;
      case "resume":
        g.tasks.owned(id, agentId);
        await g.tasks.resume(id, agentId, true);
        break;
      case "stop":
        g.tasks.cancel(id, agentId);
        break;
      case "saveSchedule": {
        const digest = crypto
          .createHash("sha256")
          .update(JSON.stringify(request.spec))
          .digest("hex");
        if (!id) {
          if (
            typeof request.nonce !== "string" ||
            !/^[\w-]{1,100}$/.test(request.nonce)
          )
            throw new Error("Missing schedule request key");
          const previous = g.automations
            .list(agentId)
            .find((x) => x.requestKey === request.nonce);
          if (previous) {
            if (previous.requestDigest !== digest)
              throw new Error("This request changed. Start a new schedule.");
            break;
          }
        }
        g.automations.save(
          agentId,
          {
            ...this.spec(request.spec),
            ...(!id
              ? { requestKey: request.nonce, requestDigest: digest }
              : {}),
          },
          id,
        );
        break;
      }
      case "pauseSchedule":
        g.automations.setEnabled(agentId, id, false);
        break;
      case "resumeSchedule":
        g.automations.setEnabled(agentId, id, true);
        break;
      case "runSchedule":
        await g.automations.run(agentId, id);
        break;
      case "removeSchedule":
        g.automations.remove(agentId, id);
        break;
      default:
        throw new Error("Unknown task action");
    }
    return this.snapshot(agentId);
  }
}
module.exports = { ChatWork, scheduleLabel, wallTime };
