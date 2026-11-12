import { React, h, Button, Glyph, useResource, nonce } from "./local-ui.js";
const services = {
  github: {
    name: "GitHub",
    description: "Work with repositories, issues and pull requests.",
    icon: "code",
  },
  gmail: {
    name: "Gmail",
    description: "Find messages and handle requested email tasks.",
    icon: "mail",
  },
  calendar: {
    name: "Google Calendar",
    description: "Check availability and manage your events.",
    icon: "calendar",
  },
};
function Field({ label, children, wide = false }) {
  return h.jsxs("label", {
    className: "grok-field" + (wide ? " wide" : ""),
    children: [h.jsx("span", { children: label }), children],
  });
}
function readiness(item) {
  if (!item.configured) return ["available", "Not connected"];
  if (item.status?.error) return ["error", "Needs attention"];
  if (item.status?.authenticated === true) return ["connected", "Connected"];
  if (item.status?.setupRequired) return ["attention", "Setup needed"];
  if (item.status?.authenticated === false)
    return ["available", "Not connected"];
  if (item.status?.toolCount !== undefined)
    return ["ready", `${item.status.toolCount} ${item.status.toolCount === 1 ? "tool" : "tools"} ready`];
  return [
    services[item.id] ? "checking" : "ready",
    services[item.id] ? "Checking account…" : "Configured",
  ];
}
export function GrokConnections({ embedded = false }) {
  const resource = useResource("connections"),
    [query, setQuery] = React.useState(""),
    [managed, setManaged] = React.useState(null),
    [form, setForm] = React.useState(null),
    [notice, setNotice] = React.useState(null);
  const data = resource.data,
    catalog = data?.catalog || [],
    configured = data?.connections || [];
  const items = [
    ...configured.map((x) => ({ ...x, configured: true })),
    ...catalog
      .filter((x) => !configured.some((c) => c.id === x.id))
      .map((x) => ({ ...x, configured: false })),
  ].sort(
    (a, b) =>
      Number(readiness(b)[0] === "connected") -
      Number(readiness(a)[0] === "connected"),
  );
  const act = async (input) => {
    try {
      await resource.send(input);
      if (
        input.action === "connect" &&
        ["gmail", "calendar"].includes(input.id)
      )
        setNotice({
          id: input.id,
          text: "Finish Google authorization in the setup window, then return here. Connection status updates automatically.",
        });
      if (input.action === "remove") setManaged(null);
    } catch {}
  };
  const add = () => {
    resource.clearError();
    setForm({
      id: "custom-" + nonce().slice(0, 8),
      name: "",
      type: "http",
      url: "",
      command: "",
      args: "",
      prefixes: "",
      token: "",
    });
  };
  const change = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    const definition = {
      id: form.id,
      name: form.name,
      ...(form.type === "http"
        ? {
            url: form.url.trim(),
            ...(form.token
              ? { headers: { Authorization: "Bearer " + form.token.trim() } }
              : {}),
          }
        : {
            command: form.command.trim(),
            args: form.args.split("\n").filter((x) => x.length),
            ...(form.type === "cli"
              ? {
                  kind: "cli",
                  prefixes: form.prefixes.split(/[\s,]+/).filter(Boolean),
                }
              : { kind: "mcp" }),
          }),
    };
    try {
      await resource.send({ action: "add", definition }, "add");
      setForm(null);
      setQuery("");
      setManaged(definition.id);
    } catch {}
  };
  const editor = form
    ? h.jsxs("form", {
        className: "grok-form",
        onSubmit: submit,
        children: [
          h.jsxs("header", {
            className: "grok-row grok-between",
            children: [
              h.jsx("h3", { children: "Add a connection" }),
              h.jsx("button", {
                type: "button",
                className: "grok-link",
                onClick: () => setForm(null),
                children: "Cancel",
              }),
            ],
          }),
          h.jsxs("div", {
            className: "grok-fields",
            children: [
              h.jsx(Field, {
                label: "Connection name",
                wide: true,
                children: h.jsx("input", {
                  "aria-label": "Connection name",
                  value: form.name,
                  onChange: (e) => change("name", e.target.value),
                  placeholder: "My tools",
                  required: true,
                  autoFocus: true,
                  maxLength: 100,
                }),
              }),
              h.jsx(Field, {
                label: "Connection type",
                wide: true,
                children: h.jsx("select", {
                  "aria-label": "Connection type",
                  value: form.type,
                  onChange: (e) => change("type", e.target.value),
                  children: [
                    h.jsx("option", {
                      value: "http",
                      children: "MCP server · URL",
                    }),
                    h.jsx("option", {
                      value: "stdio",
                      children: "MCP server · local command",
                    }),
                    h.jsx("option", {
                      value: "cli",
                      children: "Command-line tool",
                    }),
                  ],
                }),
              }),
              form.type === "http"
                ? h.jsx(Field, {
                    label: "Server URL",
                    wide: true,
                    children: h.jsx("input", {
                      "aria-label": "Server URL",
                      type: "url",
                      value: form.url,
                      onChange: (e) => change("url", e.target.value),
                      placeholder: "https://your-service.example/mcp",
                      required: true,
                    }),
                  })
                : h.jsx(Field, {
                    label: "Executable path",
                    wide: true,
                    children: h.jsx("input", {
                      "aria-label": "Executable path",
                      value: form.command,
                      onChange: (e) => change("command", e.target.value),
                      placeholder: "/absolute/path/to/tool",
                      required: true,
                    }),
                  }),
              form.type !== "http"
                ? h.jsx(Field, {
                    label: "Arguments · one per line",
                    wide: true,
                    children: h.jsx("textarea", {
                      "aria-label": "Connection arguments",
                      value: form.args,
                      onChange: (e) => change("args", e.target.value),
                      rows: 3,
                      placeholder:
                        "Optional arguments. Each line is one argument.",
                    }),
                  })
                : null,
              form.type === "cli"
                ? h.jsx(Field, {
                    label: "Allowed commands",
                    wide: true,
                    children: h.jsxs(h.Fragment, {
                      children: [
                        h.jsx("input", {
                          "aria-label": "Allowed commands",
                          value: form.prefixes,
                          onChange: (e) => change("prefixes", e.target.value),
                          placeholder: "search, list, create",
                          required: true,
                        }),
                        h.jsx("small", {
                          children:
                            "First arguments this connection may run, separated by commas.",
                        }),
                      ],
                    }),
                  })
                : null,
              form.type === "http"
                ? h.jsx(Field, {
                    label: "Access token · optional",
                    wide: true,
                    children: h.jsxs(h.Fragment, {
                      children: [
                        h.jsx("input", {
                          "aria-label": "Connection access token",
                          type: "password",
                          autoComplete: "off",
                          value: form.token,
                          onChange: (e) => change("token", e.target.value),
                          placeholder:
                            "Only if your server requires a bearer token",
                        }),
                        h.jsx("small", {
                          children:
                            "Stored locally. Never shown in Bot connection status.",
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
              pending: resource.pending === "add",
              disabled: !!resource.pending,
              children: "Add connection",
            }),
          }),
        ],
      })
    : null;
  return h.jsxs("section", {
    className: "grok-ui grok-connections",
    "aria-label": "Connected apps",
    children: [
      h.jsxs("header", {
        className: "grok-header",
        children: [
          h.jsxs("div", {
            className: "grok-row grok-between",
            children: [
              h.jsx("h2", {
                children: embedded ? "Connected apps" : "Connect apps",
              }),
              !form
                ? h.jsx(Button, {
                    onClick: add,
                    disabled: !!resource.pending,
                    children: "Add connection",
                  })
                : null,
            ],
          }),
          h.jsx("p", {
            className: "grok-muted",
            style: { marginTop: 7 },
            children:
              "Give your Bots access to the services you use. You choose what can run in the background.",
          }),
        ],
      }),
      resource.error
        ? h.jsx("p", {
            role: "alert",
            className: "grok-error",
            style: { marginBottom: 14 },
            children: resource.error,
          })
        : null,
      editor ||
        h.jsxs(h.Fragment, {
          children: [
            h.jsx("input", {
              "aria-label": "Search connected apps",
              className: "grok-search",
              type: "search",
              placeholder: "Search apps and connections",
              value: query,
              onChange: (e) => setQuery(e.target.value),
            }),
            h.jsx("div", {
              className: "grok-services",
              children: !data
                ? [1, 2, 3].map((i) =>
                    h.jsx(
                      "div",
                      {
                        className: "grok-loading",
                        "aria-label":
                          i === 1 ? "Loading connections" : undefined,
                      },
                      i,
                    ),
                  )
                : items
                    .filter((item) =>
                      (services[item.id]?.name || item.name)
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((item) => {
                      const service = services[item.id],
                        [state, label] = readiness(item),
                        connected = ["connected", "ready"].includes(state),
                        open = managed === item.id;
                      return h.jsxs(
                        "article",
                        {
                          className: "grok-card",
                          "aria-label": service?.name || item.name,
                          children: [
                            h.jsxs("div", {
                              className: "grok-row grok-between",
                              children: [
                                h.jsx("div", {
                                  className: "grok-icon",
                                  children: h.jsx(Glyph, {
                                    name: service?.icon || "code",
                                  }),
                                }),
                                h.jsxs("div", {
                                  className: "grok-grow",
                                  children: [
                                    h.jsxs("div", {
                                      className: "grok-row",
                                      style: { gap: 8, flexWrap: "wrap" },
                                      children: [
                                        h.jsx("h3", {
                                          children: service?.name || item.name,
                                        }),
                                        h.jsx("span", {
                                          className: "grok-status",
                                          "data-state": state,
                                          children: label,
                                        }),
                                      ],
                                    }),
                                    h.jsx("p", {
                                      className:
                                        "grok-caption grok-muted grok-description",
                                      children: item.status?.accounts?.[0]
                                        ?.login
                                        ? `Signed in as ${item.status.accounts[0].login}`
                                        : service?.description ||
                                          "Tools from your configured service.",
                                    }),
                                  ],
                                }),
                                h.jsx(Button, {
                                  disabled:
                                    !!resource.pending ||
                                    item.installed === false,
                                  pending: resource.pending === item.id,
                                  onClick: () =>
                                    connected || !service
                                      ? setManaged(open ? null : item.id)
                                      : act({ action: "connect", id: item.id }),
                                  children:
                                    connected || !service
                                      ? open
                                        ? "Done"
                                        : "Manage"
                                      : item.installed === false
                                        ? "Not installed"
                                        : "Connect",
                                }),
                              ],
                            }),
                            notice?.id === item.id && !connected
                              ? h.jsx("p", {
                                  className:
                                    "grok-caption grok-muted grok-rule",
                                  role: "status",
                                  children: notice.text,
                                })
                              : null,
                            state === "attention" && !open
                              ? h.jsx("p", {
                                  className: "grok-caption grok-muted",
                                  style: { marginTop: 10, paddingLeft: 48 },
                                  children:
                                    "Google needs one-time account setup. Choose Connect to continue.",
                                })
                              : null,
                            open
                              ? h.jsxs("div", {
                                  className: "grok-manage grok-rule grok-stack",
                                  children: [
                                    h.jsx("p", {
                                      className: "grok-caption grok-muted",
                                      children:
                                        item.transport === "cli"
                                          ? "Uses the signed-in account for this service."
                                          : `${item.transport === "http" ? "Remote" : "Local"} MCP tools · ${item.endpoint}`,
                                    }),
                                    h.jsxs("label", {
                                      className: "grok-toggle",
                                      children: [
                                        h.jsx("input", {
                                          type: "checkbox",
                                          "aria-label": `Allow ${service?.name || item.name} background tasks`,
                                          checked: item.automatic,
                                          disabled: !!resource.pending,
                                          onChange: (e) =>
                                            act({
                                              action: "automatic",
                                              id: item.id,
                                              enabled: e.target.checked,
                                            }),
                                        }),
                                        "Allow assigned background tasks",
                                      ],
                                    }),
                                    h.jsx("p", {
                                      className: "grok-caption grok-muted",
                                      children:
                                        "When enabled, Bots may use this connection for tasks you assign while you are away.",
                                    }),
                                    h.jsxs("div", {
                                      className: "grok-actions",
                                      children: [
                                        h.jsx(Button, {
                                          pending: resource.pending === item.id,
                                          disabled: !!resource.pending,
                                          onClick: () =>
                                            act({
                                              action: "test",
                                              id: item.id,
                                            }),
                                          children: "Check connection",
                                        }),
                                        h.jsx("button", {
                                          type: "button",
                                          className: "grok-link",
                                          disabled: !!resource.pending,
                                          onClick: () =>
                                            act({
                                              action: "remove",
                                              id: item.id,
                                            }),
                                          children: "Remove connection",
                                        }),
                                      ],
                                    }),
                                  ],
                                })
                              : null,
                          ],
                        },
                        item.id,
                      );
                    }),
            }),
            data &&
            !items.some((item) =>
              (services[item.id]?.name || item.name)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
              ? h.jsxs("div", {
                  className: "grok-empty",
                  children: [
                    h.jsx("h3", { children: "No matching apps" }),
                    h.jsx("p", {
                      className: "grok-muted grok-caption",
                      children: "Try another name, or add a custom connection.",
                    }),
                  ],
                })
              : null,
            h.jsx("p", {
              className: "grok-caption grok-muted",
              style: { marginTop: 16 },
              children:
                "You can also ask a Bot to add an installed CLI or MCP service.",
            }),
          ],
        }),
    ],
  });
}
