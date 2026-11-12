import { GrokConnections } from "./connections.js";
import { o as interop } from "./chunk-rolldown-runtime-BCiCTKAo.js";
import {
  Kt as reactRuntime,
  Gt as jsxRuntime,
} from "./index.eager-common-B73tST-1.js";
import { Lb as N, tS as Fe, YS as G } from "./index.eager-app-Bpx4jnxc.js";
import { r as Y } from "./chunk-settings-row-Dm2mXwIH.js";
const Z = interop(reactRuntime(), 1),
  Q = jsxRuntime();
export function GrokLocalSettings() {
  const [state, setState] = Z.useState(null);
  const [busy, setBusy] = Z.useState(false);
  const [error, setError] = Z.useState(null);
  const [policyBot, setPolicyBot] = Z.useState(null);
  const send = async (request) => {
    setBusy(true);
    setError(null);
    try {
      setState(await window.grokLocal.settings(request));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  Z.useEffect(() => {
    let live = true;
    const refresh = () =>
      window.grokLocal.settings({ action: "status" }).then(
        (value) => {
          if (live) setState(value);
        },
        (failure) => {
          if (live) setError(failure.message);
        },
      );
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const actionButton = (label, request) =>
    Q.jsx(Fe, {
      disabled: busy,
      onClick: () => send(request),
      size: "md",
      style: G.body2,
      type: "button",
      variant: "secondary",
      children: label,
    });
  const toggle = (label, value, request) =>
    Q.jsxs("label", {
      style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
      children: [
        Q.jsx("input", {
          type: "checkbox",
          disabled: busy,
          checked: !!value,
          onChange: (event) => send(request(event.target.checked)),
        }),
        label,
      ],
    });
  const button = (label, action) =>
    Q.jsx(Fe, {
      disabled: busy,
      onClick: () => send({ action }),
      size: "md",
      style: G.body2,
      type: "button",
      variant: "secondary",
      children: label,
    });
  if (!state)
    return Q.jsxs("div", {
      role: error ? "alert" : "status",
      style: { padding: "20px 0" },
      children: [
        Q.jsx("p", { children: error || "Loading account and local settings…" }),
        error ? actionButton("Try again", { action: "status" }) : null,
      ],
    });
  const rows = [];
  rows.push(
    Q.jsx(
      Y,
      {
        label: "ChatGPT account",
        variant: "card",
        description:
          error ||
          state?.error ||
          (state?.account.kind === "connected"
            ? state.account.email || "Connected to ChatGPT"
            : "Connect your subscription to use Grok Bot on this Mac."),
        children: Q.jsxs("div", {
          style: { display: "flex", gap: 8, alignItems: "center" },
          children: [
            button(
              state?.account.kind === "connected"
                ? "Add account"
                : "Continue with ChatGPT",
              "login",
            ),
            state?.account.kind === "connected"
              ? button("Sign out", "logout")
              : null,
          ],
        }),
      },
      "account",
    ),
  );
  if (state?.accounts.length > 1)
    rows.push(
      Q.jsx(
        Y,
        {
          label: "Saved ChatGPT accounts",
          variant: "card",
          children: Q.jsx(N, {
            "aria-label": "Saved ChatGPT accounts",
            disabled: busy,
            value: state.account.accountId || null,
            size: "lg",
            variant: "ghost",
            options: state.accounts.map((account) => ({
              value: account.id,
              label:
                (account.email || account.name || "ChatGPT") +
                " · " +
                account.clientId.slice(-6),
            })),
            onValueChange: (id) => {
              if (id) send({ action: "switchAccount", accountId: id });
            },
          }),
        },
        "accounts",
      ),
    );
  rows.push(
    Q.jsx(
      Y,
      {
        anchorId: "model",
        label: "Model",
        variant: "card",
        description:
          state?.account.kind === "connected"
            ? "Used by your Bots for reasoning and tools. Your selection is saved for this account."
            : "Sign in to load your available models.",
        children: Q.jsxs("div", {
          style: { display: "flex", gap: 8, alignItems: "center" },
          children: [
            Q.jsx(N, {
              "aria-label": "ChatGPT model",
              disabled: busy || !state?.models.length,
              value: state?.selectedModel || null,
              size: "lg",
              variant: "ghost",
              options: (state?.models || []).map((model) => ({
                value: model.id,
                label: model.name,
              })),
              onValueChange: (id) => {
                if (id) send({ action: "setModel", modelId: id });
              },
            }),
            button("Refresh models", "refreshModels"),
          ],
        }),
      },
      "model",
    ),
  );
  rows.push(
    Q.jsx(
      Y,
      {
        anchorId: "local-execution",
        label: "Local actions",
        variant: "card",
        description:
          "Commands and app actions run on this Mac. Ask each time requests confirmation. Allow local actions gives the Bot your normal local access.",
        children: Q.jsx(N, {
          "aria-label": "Local actions",
          disabled: busy,
          value: state?.permission || "ask",
          size: "lg",
          variant: "ghost",
          options: [
            { value: "ask", label: "Ask each time" },
            { value: "always", label: "Allow local actions" },
            { value: "never", label: "Chat only" },
          ],
          onValueChange: (permission) => {
            if (permission) send({ action: "setPermission", permission });
          },
        }),
      },
      "permission",
    ),
  );
  rows.push(
    Q.jsx(
      Y,
      {
        label: "Memory",
        variant: "card",
        description: `${state?.memoryCount || 0} saved memories. Each Bot keeps its own skills, journal and conversation summaries on this Mac.`,
        children: button("Open memory folder", "openMemoryFolder"),
      },
      "memory",
    ),
  );
  rows.push(
    Q.jsx(
      Y,
      {
        label: "pstack",
        variant: "card",
        description: state?.skillPack
          ? `Shared pstack ${state.skillPack.version} is installed at the app skill root and available to every Bot.`
          : "Shared pstack is loading.",
      },
      "pstack",
    ),
  );
  rows.push(
    Q.jsx(
      Y,
      {
        label: "Background work",
        variant: "card",
        description:
          "Scheduled and delegated tasks keep their progress on this Mac. Closing the window can keep them running. Explicit Quit stops the app. Mac input waits while the desktop is locked.",
        children: Q.jsxs("div", {
          children: [
            toggle(
              "Keep running when windows close",
              state?.background.enabled,
              (enabled) => ({ action: "background", preferences: { enabled } }),
            ),
            toggle("Start at login", state?.background.login, (login) => ({
              action: "background",
              preferences: { login },
            })),
            toggle(
              "Pause new automatic work",
              state?.background.paused,
              (paused) => ({ action: "background", preferences: { paused } }),
            ),
            actionButton("Stop all work", { action: "stopAll" }),
          ],
        }),
      },
      "background",
    ),
  );
  rows.push(
    Q.jsx(
      Y,
      {
        label: "Unattended access",
        variant: "card",
        description:
          "Standing grants apply to assigned background work. Interactive Local actions keeps its separate setting. Shell commands can affect your whole Mac.",
        children: Q.jsxs("div", {
          children: [
            ...[
              ["workspace", "Bot workspace files"],
              ["computer", "Control Mac apps"],
              ["shell", "Run shell commands"],
            ].map(([key, label]) =>
              toggle(label, state?.background.grants[key], (enabled) => ({
                action: "background",
                preferences: { grants: { [key]: enabled } },
              })),
            ),
          ],
        }),
      },
      "unattended",
    ),
  );
  const botId = policyBot || state?.bots?.[0]?.id,
    policy = state?.background.policies?.[botId] || {},
    grants = { ...state?.background.grants, ...policy },
    apps = policy.apps || state?.background.apps || [];
  const setPolicy = (change) => ({
    action: "background",
    preferences: { policy: { agentId: botId, ...change } },
  });
  if (botId)
    rows.push(
      Q.jsx(
        Y,
        {
          label: "Bot permissions",
          variant: "card",
          description:
            "Each Bot can have its own unattended app list and working hours. File access stays inside its workspace. Shell access is broader than these app limits.",
          children: Q.jsxs("div", {
            children: [
              Q.jsx(N, {
                "aria-label": "Bot permissions",
                disabled: busy,
                value: botId,
                size: "lg",
                variant: "ghost",
                options: (state?.bots || []).map((bot) => ({
                  value: bot.id,
                  label: bot.name,
                })),
                onValueChange: (id) => setPolicyBot(id),
              }),
              ...[
                ["workspace", "Bot workspace files"],
                ["computer", "Control allowed Mac apps"],
                ["shell", "Run shell commands"],
              ].map(([key, label]) =>
                toggle(label, grants[key], (enabled) =>
                  setPolicy({ [key]: enabled }),
                ),
              ),
              Q.jsx("p", { children: "Allowed Mac apps" }),
              ...[...new Set([...(state?.background.apps || []), ...apps])].map(
                (id) =>
                  toggle(
                    state?.background.appNames?.[id] || id,
                    apps.includes(id),
                    (enabled) =>
                      setPolicy({
                        apps: enabled
                          ? [...apps, id]
                          : apps.filter((x) => x !== id),
                      }),
                  ),
              ),
              actionButton("Add allowed app…", {
                action: "allowApp",
                agentId: botId,
              }),
              toggle(
                "Limit automatic work to selected hours",
                !!policy.timeWindow,
                (enabled) =>
                  setPolicy({
                    timeWindow: enabled
                      ? {
                          start: "09:00",
                          end: "17:00",
                          timeZone:
                            Intl.DateTimeFormat().resolvedOptions().timeZone,
                        }
                      : null,
                  }),
              ),
              policy.timeWindow
                ? Q.jsxs("div", {
                    style: { display: "flex", gap: 8, alignItems: "center" },
                    children: [
                      Q.jsx("input", {
                        "aria-label": "Work starts",
                        type: "time",
                        value: policy.timeWindow.start,
                        onChange: (event) =>
                          send(
                            setPolicy({
                              timeWindow: {
                                ...policy.timeWindow,
                                start: event.target.value,
                              },
                            }),
                          ),
                      }),
                      "to",
                      Q.jsx("input", {
                        "aria-label": "Work ends",
                        type: "time",
                        value: policy.timeWindow.end,
                        onChange: (event) =>
                          send(
                            setPolicy({
                              timeWindow: {
                                ...policy.timeWindow,
                                end: event.target.value,
                              },
                            }),
                          ),
                      }),
                      policy.timeWindow.timeZone,
                    ],
                  })
                : null,
            ],
          }),
        },
        "bot-permissions",
      ),
    );
  rows.push(
    Q.jsx(
      "div",
      {
        style: { padding: "20px 0" },
        children: Q.jsx(GrokConnections, { embedded: true }),
      },
      "connections",
    ),
  );
  return Q.jsx(Q.Fragment, { children: rows });
}
