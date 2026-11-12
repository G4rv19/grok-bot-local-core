import {
  React,
  h,
  Button,
  Glyph,
  useResource,
  nonce,
  when,
  localDateTime,
} from "./local-ui.js";
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const statusLabels = {
  working: "Working",
  queued: "Queued",
  completed: "Finished",
  paused: "Paused",
  attention: "Needs attention",
  canceled: "Stopped",
  scheduled: "Scheduled",
};
function Field({ label, children, wide = false }) {
  return h.jsxs("label", {
    className: "grok-field" + (wide ? " wide" : ""),
    children: [h.jsx("span", { children: label }), children],
  });
}
function scheduleDraft(item) {
  const timeZone = item?.timeZone || zone(),
    parts = (item?.schedule || "0 9 * * *").split(/\s+/),
    simple =
      /^\d+$/.test(parts[0]) &&
      /^\d+$/.test(parts[1]) &&
      parts[2] === "*" &&
      parts[3] === "*";
  return {
    id: item?.id,
    name: item?.title || "",
    prompt: item?.prompt || "",
    frequency:
      item?.runAt || !item
        ? "once"
        : simple
          ? parts[4] === "*"
            ? "daily"
            : parts[4] === "1-5"
              ? "weekdays"
              : /^[0-6]$/.test(parts[4])
                ? "weekly"
                : "custom"
          : "custom",
    timeZone,
    dateTime: localDateTime(item?.runAt || Date.now() + 3600000, timeZone),
    time: `${parts[1].padStart(2, "0")}:${parts[0].padStart(2, "0")}`,
    weekday: /^[0-6]$/.test(parts[4]) ? +parts[4] : 1,
    schedule: item?.schedule || "",
    missed: item?.missed || "skip",
    enabled: item?.enabled ?? true,
    nonce: nonce(),
  };
}
export function GrokChatWork({ agentId }) {
  const resource = useResource("work", agentId),
    [open, setOpen] = React.useState(false),
    [tab, setTab] = React.useState("tasks"),
    [form, setForm] = React.useState(null);
  React.useEffect(() => {
    setOpen(false);
    setForm(null);
    setTab("tasks");
  }, [agentId]);
  const data = resource.data,
    tasks = data?.tasks || [],
    schedules = data?.schedules || [],
    working =
      tasks.filter((x) => ["working", "queued"].includes(x.status)).length +
      schedules.filter((x) => ["working", "queued"].includes(x.status)).length,
    next = schedules
      .filter((x) => x.nextRunAt)
      .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
  const act = (input) => resource.send(input).catch(() => {});
  const edit = (item) => {
    setOpen(true);
    setTab("schedules");
    setForm({ kind: "schedule", ...scheduleDraft(item) });
    resource.clearError();
  };
  const newTask = () => {
    setOpen(true);
    setTab("tasks");
    setForm({ kind: "task", name: "", prompt: "", nonce: nonce() });
    resource.clearError();
  };
  const change = (key, value) =>
    setForm((old) => ({ ...old, [key]: value, nonce: nonce() }));
  const submit = async (event) => {
    event.preventDefault();
    try {
      if (form.kind === "task")
        await resource.send({
          action: "start",
          title: form.name,
          prompt: form.prompt,
          nonce: form.nonce,
        });
      else {
        const { kind, id, nonce: requestNonce, ...spec } = form;
        await resource.send({
          action: "saveSchedule",
          id,
          nonce: requestNonce,
          spec,
        });
      }
      setForm(null);
    } catch {}
  };
  const actions = (item, schedule = false) => {
    const taskId = schedule ? item.activeTaskId : item.id;
    return h.jsxs("div", {
      className: "grok-actions",
      children: [
        item.canPause
          ? h.jsx(Button, {
              pending: resource.pending === taskId,
              onClick: () => act({ action: "pause", id: taskId }),
              children: "Pause",
            })
          : null,
        item.canResume
          ? h.jsx(Button, {
              pending: resource.pending === taskId,
              onClick: () => act({ action: "resume", id: taskId }),
              children: "Continue",
            })
          : null,
        item.canStop
          ? h.jsx(Button, {
              pending: resource.pending === taskId,
              onClick: () => act({ action: "stop", id: taskId }),
              children: "Stop",
            })
          : null,
        schedule
          ? h.jsx(Button, {
              disabled: !item.canRun,
              pending: resource.pending === item.id,
              onClick: () => act({ action: "runSchedule", id: item.id }),
              children: "Run now",
            })
          : null,
        schedule
          ? h.jsx(Button, {
              disabled: !!resource.pending,
              onClick: () => edit(item),
              children: "Edit",
            })
          : null,
        schedule && (!item.runAt || item.status !== "completed")
          ? h.jsx("button", {
              type: "button",
              className: "grok-link",
              disabled: !!resource.pending,
              onClick: () =>
                act({
                  action: item.enabled ? "pauseSchedule" : "resumeSchedule",
                  id: item.id,
                }),
              children: item.enabled ? "Pause schedule" : "Enable schedule",
            })
          : null,
        schedule
          ? h.jsx("button", {
              type: "button",
              className: "grok-link",
              disabled: !!resource.pending,
              onClick: () => act({ action: "removeSchedule", id: item.id }),
              children: "Remove",
            })
          : null,
      ],
    });
  };
  const card = (item, schedule = false) =>
    h.jsxs(
      "article",
      {
        className: "grok-card",
        "aria-label": item.title,
        children: [
          h.jsxs("div", {
            className: "grok-row grok-between",
            children: [
              h.jsxs("div", {
                className: "grok-row grok-grow",
                children: [
                  h.jsx(Glyph, {
                    name: schedule ? "calendar" : "tasks",
                    size: 16,
                  }),
                  h.jsx("h3", {
                    className: "grok-work-title",
                    title: item.title,
                    children: item.title,
                  }),
                ],
              }),
              h.jsx("span", {
                className: "grok-status",
                "data-state": item.status,
                children: statusLabels[item.status] || item.status,
              }),
            ],
          }),
          h.jsx("p", {
            className: "grok-work-meta",
            children: schedule
              ? `${item.label}${item.nextRunAt ? " · " + when(item.nextRunAt, item.timeZone) : item.lastRunAt ? " · Last run " + when(item.lastRunAt, item.timeZone) : ""} · ${item.timeZone}`
              : `${item.bot}${item.steps ? " · " + item.steps + " steps" : ""}${item.checkpoints ? " · Progress saved" : ""}`,
          }),
          item.progress && ["working", "queued", "paused"].includes(item.status)
            ? h.jsx("p", {
                className: "grok-work-meta",
                children: item.progress,
              })
            : null,
          item.error
            ? h.jsx("p", { className: "grok-work-meta", children: item.error })
            : null,
          item.result
            ? h.jsxs("details", {
                className: "grok-caption",
                style: { marginTop: 8 },
                children: [
                  h.jsx("summary", { children: "View result" }),
                  h.jsx("div", {
                    className: "grok-result",
                    children: item.result.slice(0, 12000),
                  }),
                ],
              })
            : null,
          actions(item, schedule),
        ],
      },
      item.id,
    );
  const editor = form
    ? h.jsxs("form", {
        className: "grok-form",
        onSubmit: submit,
        children: [
          h.jsxs("header", {
            className: "grok-row grok-between",
            children: [
              h.jsx("h3", {
                children:
                  form.kind === "task"
                    ? "New background task"
                    : form.id
                      ? "Edit schedule"
                      : "Schedule a task",
              }),
              h.jsx("button", {
                type: "button",
                className: "grok-link",
                "aria-label": "Cancel task form",
                onClick: () => setForm(null),
                children: "Cancel",
              }),
            ],
          }),
          h.jsxs("div", {
            className: "grok-fields",
            children: [
              h.jsx(Field, {
                label: "Name",
                wide: true,
                children: h.jsx("input", {
                  "aria-label": "Task name",
                  value: form.name,
                  onChange: (e) => change("name", e.target.value),
                  placeholder:
                    form.kind === "task"
                      ? "Optional short name"
                      : "Morning briefing",
                  required: form.kind === "schedule",
                  maxLength: 100,
                  autoFocus: true,
                }),
              }),
              h.jsx(Field, {
                label: "What should the Bot do?",
                wide: true,
                children: h.jsx("textarea", {
                  "aria-label": "Task instructions",
                  value: form.prompt,
                  onChange: (e) => change("prompt", e.target.value),
                  required: true,
                  placeholder: "Describe the task and the result you want.",
                  maxLength: 100000,
                  rows: 3,
                }),
              }),
              form.kind === "schedule"
                ? h.jsx(Field, {
                    label: "Repeat",
                    children: h.jsx("select", {
                      "aria-label": "Schedule repeat",
                      value: form.frequency,
                      onChange: (e) => change("frequency", e.target.value),
                      children: [
                        ["once", "Once"],
                        ["daily", "Every day"],
                        ["weekdays", "Weekdays"],
                        ["weekly", "Every week"],
                        ["custom", "Custom schedule"],
                      ].map(([value, label]) =>
                        h.jsx("option", { value, children: label }, value),
                      ),
                    }),
                  })
                : null,
              form.kind === "schedule" && form.frequency === "once"
                ? h.jsx(Field, {
                    label: "Date and time",
                    children: h.jsx("input", {
                      "aria-label": "Schedule date and time",
                      type: "datetime-local",
                      value: form.dateTime,
                      onChange: (e) => change("dateTime", e.target.value),
                      required: true,
                    }),
                  })
                : null,
              form.kind === "schedule" &&
              ["daily", "weekdays", "weekly"].includes(form.frequency)
                ? h.jsx(Field, {
                    label: "Time",
                    children: h.jsx("input", {
                      "aria-label": "Schedule time",
                      type: "time",
                      value: form.time,
                      onChange: (e) => change("time", e.target.value),
                      required: true,
                    }),
                  })
                : null,
              form.kind === "schedule" && form.frequency === "weekly"
                ? h.jsx(Field, {
                    label: "Day",
                    children: h.jsx("select", {
                      "aria-label": "Schedule weekday",
                      value: form.weekday,
                      onChange: (e) => change("weekday", +e.target.value),
                      children: [
                        "Sunday",
                        "Monday",
                        "Tuesday",
                        "Wednesday",
                        "Thursday",
                        "Friday",
                        "Saturday",
                      ].map((name, index) =>
                        h.jsx(
                          "option",
                          { value: index, children: name },
                          index,
                        ),
                      ),
                    }),
                  })
                : null,
              form.kind === "schedule" && form.frequency === "custom"
                ? h.jsx(Field, {
                    label: "Cron expression",
                    children: h.jsx("input", {
                      "aria-label": "Custom cron expression",
                      value: form.schedule,
                      onChange: (e) => change("schedule", e.target.value),
                      placeholder: "0 9 * * 1-5",
                      required: true,
                    }),
                  })
                : null,
              form.kind === "schedule"
                ? h.jsx("p", {
                    className: "grok-caption grok-muted",
                    style: { gridColumn: "1 / -1" },
                    children: `Times in ${form.timeZone}. The Mac must be awake and Grok Bot running.`,
                  })
                : null,
              form.kind === "schedule"
                ? h.jsx(Field, {
                    label: "If the Mac is unavailable",
                    wide: true,
                    children: h.jsx("select", {
                      "aria-label": "Missed schedule policy",
                      value: form.missed,
                      onChange: (e) => change("missed", e.target.value),
                      children: [
                        h.jsx("option", {
                          value: "skip",
                          children: "Skip the missed run",
                        }),
                        h.jsx("option", {
                          value: "once",
                          children: "Run once when available",
                        }),
                      ],
                    }),
                  })
                : null,
            ],
          }),
          h.jsx("div", {
            className: "grok-actions",
            children: h.jsx(Button, {
              type: "submit",
              pending: !!resource.pending,
              children:
                form.kind === "task"
                  ? "Start in background"
                  : form.id
                    ? "Save changes"
                    : "Schedule task",
            }),
          }),
        ],
      })
    : null;
  return h.jsxs("section", {
    className: "grok-ui grok-chat-work",
    "aria-label": "Tasks and schedules",
    children: [
      h.jsxs("div", {
        className: "grok-work-bar",
        children: [
          h.jsxs("button", {
            type: "button",
            className: "grok-work-open",
            "aria-label": open
              ? "Hide tasks and schedules"
              : "Show tasks and schedules",
            "aria-expanded": open,
            onClick: () => setOpen(!open),
            children: [
              h.jsx(Glyph, { name: "tasks", size: 16 }),
              h.jsx("span", { children: "Tasks & schedules" }),
              working ? h.jsx("span", { className: "grok-dot" }) : null,
              h.jsx("span", {
                className: "grok-caption grok-muted",
                children: working
                  ? `${working} working`
                  : next
                    ? `Next ${when(next.nextRunAt, next.timeZone)}`
                    : data?.background?.paused
                      ? "Automatic work paused"
                      : schedules.length
                        ? `${schedules.length} schedule${schedules.length === 1 ? "" : "s"}`
                        : tasks.length
                          ? `${tasks.length} saved`
                          : "",
              }),
            ],
          }),
          h.jsxs("div", {
            className: "grok-actions",
            children: [
              h.jsx("button", {
                type: "button",
                className: "grok-link",
                "aria-label": "New background task",
                onClick: newTask,
                children: "+ Task",
              }),
              h.jsx("button", {
                type: "button",
                className: "grok-link",
                "aria-label": "Schedule a task",
                onClick: () => edit(),
                children: "+ Schedule",
              }),
            ],
          }),
        ],
      }),
      open
        ? h.jsxs("div", {
            className: "grok-work-content",
            children: [
              resource.error
                ? h.jsx("p", {
                    role: "alert",
                    className: "grok-error",
                    style: { marginBottom: 10 },
                    children: resource.error,
                  })
                : null,
              data?.background?.locked
                ? h.jsx("p", {
                    className: "grok-caption grok-muted",
                    children: "Mac input resumes after unlock.",
                  })
                : null,
              editor ||
                h.jsxs(h.Fragment, {
                  children: [
                    h.jsx("div", {
                      className: "grok-sections grok-work-panel-header",
                      role: "tablist",
                      "aria-label": "Work type",
                      children: [
                        ["tasks", `Tasks · ${tasks.length}`],
                        ["schedules", `Schedules · ${schedules.length}`],
                      ].map(([key, label]) =>
                        h.jsx(
                          "button",
                          {
                            type: "button",
                            className: "grok-tab",
                            role: "tab",
                            "aria-selected": tab === key,
                            onClick: () => setTab(key),
                            children: label,
                          },
                          key,
                        ),
                      ),
                    }),
                    !data
                      ? h.jsx("div", {
                          className: "grok-loading",
                          "aria-label": "Loading tasks",
                        })
                      : (tab === "tasks" ? tasks : schedules).length
                        ? (tab === "tasks" ? tasks : schedules).map((item) =>
                            card(item, tab === "schedules"),
                          )
                        : h.jsxs("div", {
                            className: "grok-empty",
                            children: [
                              h.jsx("h3", {
                                children:
                                  tab === "tasks"
                                    ? "No background tasks yet"
                                    : "Nothing scheduled yet",
                              }),
                              h.jsx("p", {
                                className: "grok-muted grok-caption",
                                style: { marginTop: 5 },
                                children:
                                  tab === "tasks"
                                    ? "Ask this Bot to work in the background, or add a task here."
                                    : "Ask “every weekday at 9”, or choose a date here.",
                              }),
                            ],
                          }),
                  ],
                }),
            ],
          })
        : null,
    ],
  });
}
