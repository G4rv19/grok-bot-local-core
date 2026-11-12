"use strict";
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function cleanRoutingText(value, gateway) {
  let text = String(value || "");
  const replacements = [
    ...gateway.state.agents.map((bot) => [bot.id, bot.name, false]),
    ...[...(gateway.tasks?.tasks.values() || [])].map((task) => [
      task.id,
      `${gateway.state.agents.find((bot) => bot.id === task.to)?.name || "Bot"}’s task`,
      true,
    ]),
  ];
  for (const [id, name, isTask] of replacements) {
    if (isTask)
      text = text.replace(
        new RegExp("\\b[Tt]ask\\s+`?" + escaped(id) + "`?", "g"),
        () => name,
      );
    // Remove redundant routing annotations, then replace any remaining exact ID.
    text = text.replace(
      new RegExp("\\s*\\(\\s*`?" + escaped(id) + "`?\\s*\\)", "g"),
      "",
    );
    text = text.replace(
      new RegExp("`?" + escaped(id) + "`?", "g"),
      (match, offset, input) => {
        // Keep real artifact paths and link destinations intact.
        if (input.lastIndexOf("](", offset) > input.lastIndexOf(")", offset))
          return match;
        if (
          /[\w/\\-]/.test(input[offset - 1] || "") ||
          /[\w/\\-]/.test(input[offset + match.length] || "")
        )
          return match;
        return name;
      },
    );
  }
  return text;
}
function taskLabel(task, gateway) {
  const bot =
    gateway.state.agents.find((bot) => bot.id === task.to)?.name || "Bot";
  const states = {
    submitted: "Queued",
    queued: "Queued",
    working: "Working",
    completed: "Finished",
    canceled: "Stopped",
    failed: "Needs attention",
    paused: task.error ? "Needs attention" : "Paused",
  };
  return `${bot} · ${states[task.status] || task.status}${task.title ? " · " + cleanRoutingText(task.title, gateway) : ""}`;
}
function taskTool(call, result, gateway) {
  if (
    [
      "delegate_task",
      "start_background_task",
      "resume_agent_task",
      "pause_agent_task",
      "cancel_agent_task",
    ].includes(call.name)
  ) {
    let args = {};
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch {}
    const task = result?.to ? result : gateway.tasks?.tasks.get(args.id);
    const bot =
      gateway.state.agents.find((bot) => bot.id === (task?.to || args.agent_id))
        ?.name || "Bot";
    return {
      name:
        call.name === "start_background_task"
          ? `Queued for ${bot}`
          : call.name === "delegate_task"
            ? `Working with ${bot}`
            : call.name === "resume_agent_task"
              ? `Continuing ${bot}`
              : call.name === "pause_agent_task"
                ? `Pausing ${bot}`
                : `Stopping ${bot}`,
      command: task ? taskLabel(task, gateway) : bot,
      output: cleanRoutingText(
        result?.result ||
          result?.error ||
          (task?.status === "completed"
            ? "Finished."
            : task?.status === "paused"
              ? "Progress saved; waiting for you."
              : "The task is running in the background."),
        gateway,
      ),
    };
  }
  if (call.name === "schedule_task" && !result?.error)
    return {
      name: "Scheduled task",
      command: result.name,
      output: `${result.runAt ? "Once" : "Recurring"} · ${new Date(result.nextRunAt).toLocaleString()} (${result.timeZone})\n${result.isEnabled ? "Enabled" : "Paused"}`,
    };
  if (call.name === "scheduled_tasks" && Array.isArray(result))
    return {
      name: "Schedules",
      command: "Schedules",
      output:
        result
          .map(
            (item) =>
              `${item.name} · ${item.isEnabled ? "Enabled" : "Paused"} · ${new Date(item.nextRunAt).toLocaleString()} (${item.timeZone})${item.lastError ? "\n" + item.lastError : ""}`,
          )
          .join("\n\n") || "No schedules.",
    };
  if (call.name === "agent_tasks")
    return {
      name: "Bot tasks",
      command: "Bot tasks",
      output: Array.isArray(result)
        ? result
            .map(
              (task) =>
                `${taskLabel(task, gateway)}${task.progress ? "\n" + cleanRoutingText(task.progress, gateway) : ""}`,
            )
            .join("\n\n") || "No delegated tasks."
        : cleanRoutingText(result?.error, gateway),
    };
}
module.exports = { cleanRoutingText, taskLabel, taskTool };
