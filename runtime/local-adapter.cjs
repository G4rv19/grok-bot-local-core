"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { LocalGateway } = require("./local-gateway.cjs");
const { ChatGPTAuth } = require("./chatgpt-auth.cjs");
const { ChatGPTProvider } = require("./chatgpt-provider.cjs");
const { AgentStore } = require("./agent-store.cjs");
const { AgentSkills } = require("./agent-skills.cjs");
const { AgentRuntime } = require("./agent-runtime.cjs");
const { NativeTools } = require("./native-tools.cjs");
const { AgentTasks } = require("./agent-tasks.cjs");
const { Automations } = require("./automations.cjs");
const { Connectors } = require("./connectors.cjs");
const { AgentHarness } = require("./agent-harness.cjs");
const { MacClient } = require("./mac-client.cjs");
const { Background } = require("./background.cjs");
const { ChatWork } = require("./chat-work.cjs");
const { ConnectionSettings } = require("./connection-settings.cjs");
const AUTH_ID = "grokbot-local-user";
const access = Object.freeze({
  state: "granted",
  privacyDisclaimerRequired: false,
  purchasableTiers: [],
  proAndSuperGrokPlansGrantAccess: false,
  isUnified: false,
  speechUiHidden: true,
});
let gateway,
  gatewayReady,
  auth,
  provider,
  runtime,
  harness,
  nativeTools,
  authService,
  modelCache,
  background;

function stopRuns() {
  for (const controller of gateway.jobs.values()) controller.abort();
}
function localToken() {
  return (
    Buffer.from('{"alg":"none"}').toString("base64url") +
    "." +
    Buffer.from(
      JSON.stringify({
        sub: AUTH_ID,
        email: auth.status().email || "local@localhost",
        exp: 4102444800,
      }),
    ).toString("base64url") +
    ".local"
  );
}
function currentStatus() {
  const status = auth.status();
  // The local desktop has its own identity. Disconnecting the model provider
  // must not hide local Bots or make settings inaccessible.
  return {
    kind: "logged-in",
    authId: AUTH_ID,
    email: status.email || "local@localhost",
    displayName:
      status.kind === "connected"
        ? status.name || "ChatGPT account"
        : "Local account",
    profileReady: true,
    isWorkAccount: false,
    expiresAt: 4102444800000,
  };
}
function createAuthService(options) {
  if (authService) return authService;
  const listeners = new Set(),
    flights = new Set();
  let flight = { kind: "idle" },
    loginUrl,
    loginWork;
  const emit = () => {
    for (const fn of listeners) fn(currentStatus());
  };
  const emitFlight = (value) => {
    flight = value;
    for (const fn of flights) fn(value);
  };
  const login = async (accountId, force = false) => {
    if (!force && auth.status().kind === "connected") return currentStatus();
    if (loginWork) return loginWork;
    loginWork = (async () => {
      emitFlight({
        kind: "waiting-for-browser",
        flow: "sign-in",
        startedAtMs: Date.now(),
        deadlineMs: Date.now() + 300000,
      });
      try {
        const attempt = await auth.beginLogin({
          accountId,
          openExternal: async (url) => {
            loginUrl = url;
            await options.openExternal(url);
          },
        });
        await attempt.done;
        stopRuns();
        modelCache = undefined;
        emit();
        await gateway.tasks?.start();
        return currentStatus();
      } finally {
        loginUrl = undefined;
        emitFlight({ kind: "idle" });
        loginWork = undefined;
      }
    })();
    return loginWork;
  };
  const service = {
    async getStatus() {
      return currentStatus();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    subscribeLoginFlight(fn) {
      flights.add(fn);
      return () => flights.delete(fn);
    },
    async getAccessToken() {
      return localToken();
    },
    async getValidAccessToken() {
      return localToken();
    },
    async getSelectedTeamId() {
      return undefined;
    },
    async getSelectedTeamIdForAccountScope() {
      return undefined;
    },
    async getSelectedTeamSnapshot() {
      return { kind: "clear" };
    },
    async setSelectedTeamId() {
      return { kind: "updated" };
    },
    async getSavedAccounts() {
      return { accounts: [], activeAccountId: null, corrupt: false };
    },
    async listAccounts() {
      return { accounts: [], activeAccountId: null, corrupt: false };
    },
    async listSavedAccounts() {
      return { accounts: [], activeAccountId: null, corrupt: false };
    },
    getLoginFlight() {
      return flight;
    },
    async cancelLoginFlight() {
      auth.cancelLogin();
      emitFlight({ kind: "idle" });
    },
    async reopenLoginLink() {
      if (loginUrl) await options.openExternal(loginUrl);
    },
    async copyLoginLink(copy) {
      if (loginUrl) copy(loginUrl);
    },
    login: () => login(),
    addAccount: () => login(undefined, true),
    async switchAccount(id) {
      stopRuns();
      const account = auth.state.accounts.find((account) => account.id === id);
      if (!account) throw new Error("Unknown ChatGPT account");
      if (!account.tokens) return login(id, true);
      auth.state.activeId = id;
      auth.save();
      modelCache = undefined;
      emit();
      return currentStatus();
    },
    async logout() {
      stopRuns();
      const result = await auth.logout();
      modelCache = undefined;
      emit();
      if (!result.revoked)
        require("electron").dialog.showMessageBox({
          type: "info",
          message: "Signed out locally",
          detail:
            "Remote revocation could not be confirmed. You can disconnect Grok Bot Local in ChatGPT Settings.",
          buttons: ["OK"],
        });
      return currentStatus();
    },
    recheckMissedLogin() {},
    noteUnauthenticatedResponse() {},
    async refreshProfile() {
      return currentStatus();
    },
    async updateProfileName() {
      return currentStatus();
    },
    async revokeForAccountRefusal() {
      await service.logout();
      return { kind: "completed", status: currentStatus() };
    },
  };
  authService = service;
  return service;
}
async function models(force = false) {
  const account = auth.status();
  if (account.kind !== "connected")
    throw new Error("Continue with ChatGPT to load your available models");
  if (
    !force &&
    modelCache?.accountId === account.accountId &&
    Date.now() - modelCache.at < 300000
  )
    return modelCache.models;
  const catalog = await provider.models({ signal: AbortSignal.timeout(30000) });
  if (auth.status().accountId !== account.accountId)
    throw new Error("The ChatGPT account changed while models were loading");
  if (!catalog.length)
    throw new Error(
      "No available ChatGPT models were returned for this account",
    );
  modelCache = {
    accountId: account.accountId,
    at: Date.now(),
    models: catalog,
  };
  if (!getModel()) await setModel(catalog[0].slug, catalog);
  return catalog;
}
function getModel() {
  return gateway.state.modelByAccount?.[auth.status().accountId]?.modelId;
}
async function setModel(modelId, catalog) {
  if (!(catalog || (await models())).some((model) => model.slug === modelId))
    throw new Error(
      "This model is unavailable to the selected ChatGPT account",
    );
  const selection = { modelId, maxMode: false, parameters: [] };
  gateway.state.modelByAccount ||= {};
  gateway.state.modelByAccount[auth.status().accountId] = selection;
  gateway.state.hostSettings = {
    ...(await gateway.dispatch("getHostSettings")),
    computerUseModel: selection,
  };
  gateway.save();
}
async function settings(request = {}) {
  switch (request.action) {
    case "login":
      await authService.addAccount();
      break;
    case "logout":
      await authService.logout();
      break;
    case "switchAccount":
      await authService.switchAccount(request.accountId);
      break;
    case "setModel":
      await setModel(request.modelId);
      break;
    case "setPermission":
      setPermission(request.permission);
      break;
    case "background":
      await background.configure(request.preferences || {});
      break;
    case "allowApp": {
      gateway.agent(request.agentId);
      const result = await require("electron").dialog.showOpenDialog({
        title: "Allow an app for unattended work",
        defaultPath: "/Applications",
        properties: ["openFile"],
        filters: [{ name: "Mac application", extensions: ["app"] }],
      });
      if (result.canceled) break;
      const file = result.filePaths[0];
      if (path.extname(file) !== ".app")
        throw new Error("Choose a Mac application");
      const bundle = require("node:child_process")
        .execFileSync(
          "/usr/libexec/PlistBuddy",
          [
            "-c",
            "Print :CFBundleIdentifier",
            path.join(file, "Contents/Info.plist"),
          ],
          { encoding: "utf8", timeout: 5000 },
        )
        .trim();
      background.preferences.appNames[bundle] = path.basename(file, ".app");
      await background.configure({
        policy: {
          agentId: request.agentId,
          apps: [
            ...new Set([...background.policy(request.agentId).apps, bundle]),
          ],
        },
      });
      break;
    }
    case "stopAll":
      background.stop();
      break;
    case "openMemoryFolder":
      fs.mkdirSync(runtime.store.root, { recursive: true, mode: 0o700 });
      await require("electron").shell.openPath(runtime.store.root);
      break;
    case "refreshModels":
      break;
    case undefined:
    case "status":
      break;
    default:
      throw new Error("Unknown local settings action");
  }
  await gateway.connectors.refreshStatuses();
  let catalog = [],
    error;
  if (auth.status().kind === "connected") {
    try {
      catalog = await models(request.action === "refreshModels");
    } catch (failure) {
      error = failure.message;
    }
  }
  return {
    account: auth.status(),
    accounts: auth.accounts(),
    models: catalog.map((model) => ({
      id: model.slug,
      name: model.display_name,
      contextWindow: model.context_window,
    })),
    selectedModel: getModel() || null,
    permission: getPermission(),
    error: error || null,
    memoryCount: gateway.state.agents.reduce(
      (count, agent) => count + runtime.store.load(agent.id).memories.length,
      0,
    ),
    runtime: "Grok Bot local agent",
    promptVersion: "reconstructed-v1",
    connectors: gateway.connectors.describe(),
    connectionCatalog: gateway.connectors.catalog(),
    background: background.status(),
    bots: gateway.state.agents.map(({ id, name }) => ({ id, name })),
    tasks: gateway.tasks
      .list()
      .slice(0, 20)
      .map((task) => ({
        id: task.id,
        bot: gateway.agent(task.to).name,
        title: task.title,
        status: task.status,
        progress: task.progress,
        error: task.error || null,
      })),
    skillPack: runtime.skills.shared.manifest,
    schedules: gateway.automations.list().length,
  };
}
function client(service) {
  const result = Object.fromEntries(
    Object.entries(service.methods).map(([name, method]) => [
      name,
      async () => {
        const response = new method.O();
        switch (name) {
          case "getMe":
            Object.assign(response, {
              authId: AUTH_ID,
              email: auth.status().email || "local@localhost",
              firstName: auth.status().name || "ChatGPT",
              lastName: "",
              userId: 1,
              publicUserId: AUTH_ID,
            });
            break;
          case "getSandAccessStatus":
            Object.assign(response, {
              state: 1,
              speechUiHidden: true,
              privacyDisclaimerRequired: false,
            });
            break;
          case "getSandUsageStatus":
            Object.assign(response, {
              hasAvailableUsage: true,
              hasNonZeroIncludedLimit: true,
              usagePercent: 0,
              cursorPlanName: "Local",
            });
            break;
          case "getUserPrivacyMode":
            response.privacyMode = true;
            break;
          case "getGrokBotTermsSeen":
            response.termsSeenAtMs = BigInt(Date.now());
            break;
          case "shouldShowGrokBotTrainingOptInPopup":
            response.shouldShow = false;
            break;
          case "availableModels": {
            const catalog = await models();
            response.models = catalog.map((model) => ({
              name: model.slug,
              clientDisplayName: model.display_name,
              serverModelName: model.slug,
              defaultOn: model.slug === getModel(),
              supportsAgent: true,
            }));
            response.modelNames = catalog.map((model) => model.slug);
            break;
          }
          default:
            if (
              !/^(get|list|read|check|should|report|submit|track|registerSandMachine|notify)/.test(
                name,
              )
            )
              throw new Error(
                `${name} requires a hosted service and is disabled in this local build`,
              );
        }
        if (method.kind === 0) return response;
        throw new Error(`${name} streaming is disabled in this local build`);
      },
    ]),
  );
  for (const [name, method] of Object.entries(service.methods))
    if (method.kind !== 0)
      result[name] = async function* (request, options = {}) {
        if (name !== "watchSandBoxMigration")
          throw new Error(`${name} streaming is disabled in this local build`);
        if (!options.signal?.aborted)
          await new Promise((resolve) =>
            options.signal?.addEventListener("abort", resolve, { once: true }),
          );
      };
  return result;
}
function start() {
  const { app, session, ipcMain, dialog } = require("electron");
  app.commandLine.appendSwitch("use-mock-keychain");
  app.setName("Grok Bot Local");
  const dataDir = process.env.GROK_LOCAL_DATA_DIR || path.join(app.getPath("appData"), "Grok Bot Local");
  if (!path.isAbsolute(dataDir)) throw new Error("GROK_LOCAL_DATA_DIR must be an absolute path");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  app.setPath("userData", dataDir);
  // Acquire ownership before reading or migrating any persistent runtime state.
  // The recovered bootstrap otherwise acquires its lock after this adapter.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  const request = globalThis.fetch.bind(globalThis);
  auth = new ChatGPTAuth({ dataDir, fetch: request });
  provider = new ChatGPTProvider({
    getAccessToken: () => auth.getAccessToken(),
    fetch: request,
  });
  const store = new AgentStore(dataDir),
    skills = new AgentSkills(store);
  gateway = new LocalGateway({
    dataDir,
    contract: require("./local-gateway-schema.json"),
    runModel: (args) => harness.run(args),
  });
  gateway.contextStore = store;
  gateway.skills = skills;
  gateway.tasks = new AgentTasks({ dataDir, gateway });
  background = new Background({
    dataDir,
    gateway,
    electron: require("electron"),
  });
  gateway.background = background;
  gateway.canRunAutomatic = (agentId) =>
    auth.status().kind === "connected" && background.canRun(agentId);
  if (gateway.state.localPermissionVersion !== 1) {
    gateway.state.workspacePermission = "ask";
    gateway.state.localPermissionVersion = 1;
    gateway.save();
  }
  nativeTools = new NativeTools({
    original: require("../local-exec-daemon/main.cjs"),
    ripgrepPath: path.join(process.resourcesPath, "local-tools/rg"),
    helperPath: path.join(
      process.resourcesPath,
      "../Helpers/Grok Bot Local Helper.app/Contents/MacOS/GrokBotLocalHelper",
    ),
    catalog: require("./computer-tool-catalog.json"),
    getPermission,
    background,
    approve: async (detail) =>
      (
        await dialog.showMessageBox({
          type: "question",
          title: "Grok Bot local action",
          message: "Allow this action on your Mac?",
          detail,
          buttons: ["Allow once", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
      ).response === 0,
  });
  runtime = new AgentRuntime({
    store,
    skills,
    provider,
    nativeTools,
    gateway,
    getPermission,
    getModel,
    modelCatalog: models,
  });
  gateway.nativeTools = nativeTools;
  const roundsPerCheckpoint = Number(
    process.env.GROK_LOCAL_CHECKPOINT_ROUNDS || 60,
  );
  if (
    !Number.isInteger(roundsPerCheckpoint) ||
    roundsPerCheckpoint < 1 ||
    roundsPerCheckpoint > 60
  )
    throw new Error("Checkpoint rounds must be an integer from 1 to 60");
  harness = new AgentHarness({ runtime, store, roundsPerCheckpoint });
  gateway.automations = new Automations({ dataDir, gateway });
  gateway.automations.start();
  gateway.connectors = new Connectors({
    dataDir,
    fetch: request,
    authorize: (detail, signal, context) =>
      nativeTools.authorize(detail, signal, context),
  });
  const chatWork = new ChatWork(gateway);
  const connectionSettings = new ConnectionSettings({
    connectors: gateway.connectors,
    loginGoogle: () =>
      require("./connection-login.cjs").openGoogleLogin(
        dataDir,
        require("electron").shell,
      ),
  });
  const changedAgents = new Set();
  let changedTimer;
  const publish = (payload) => {
    for (const window of require("electron").BrowserWindow.getAllWindows())
      if (!window.webContents.isDestroyed())
        window.webContents.send("grok-local:changed", payload);
  };
  gateway.workChanged = (...ids) => {
    for (const id of ids) changedAgents.add(id);
    if (!changedTimer)
      changedTimer = setTimeout(() => {
        changedTimer = undefined;
        publish({ kind: "work", agentIds: [...changedAgents] });
        changedAgents.clear();
      }, 80);
  };
  gateway.connectors.onChanged = () => publish({ kind: "connections" });
  app.whenReady().then(() => background.install());
  app
    .whenReady()
    .then(() => {
      if (auth.status().kind === "connected") return gateway.tasks.start();
    })
    .catch((error) =>
      console.error("Saved Bot tasks could not resume:", error.message),
    );
  gatewayReady = gateway.listen().then(() => {
    process.env.GROK_LOCAL_URL = gateway.baseUrl;
    process.env.GROK_LOCAL_GATEWAY_TOKEN = gateway.token;
    return gateway;
  });
  gatewayReady.catch((error) => {
    console.error(error.message);
    app.quit();
  });
  Object.assign(process.env, {
    GROK_LOCAL_URL: "http://127.0.0.1:0",
    GROK_LOCAL_GATEWAY_TOKEN: gateway.token,
    SAND_USER_DATA_DIR: dataDir,
    SAND_DATA_ROOT: path.join(dataDir, "data"),
    SAND_BACKEND_URL: "http://127.0.0.1:0",
    CURSOR_API_BASE_URL: "http://127.0.0.1:0",
    CURSOR_ORIGIN_BACKEND_URL: "http://127.0.0.1:0",
    SAND_CURSOR_WEBSITE_URL: "http://127.0.0.1:0",
    CURSOR_WEBSITE_URL: "http://127.0.0.1:0",
    SAND_ISOLATED_DEPLOYMENT: "1",
    SAND_DISABLE_UPDATES: "1",
    SAND_SENTRY_DISABLED: "1",
  });
  globalThis.fetch = (input, options) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return Promise.reject(
        new Error("Hosted app services are disabled in the local build"),
      );
    return request(input, options);
  };
  const block = (browserSession) =>
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({
        cancel:
          ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      });
    });
  ipcMain.handle("grok-local:settings", (event, input) => {
    const url = event.senderFrame?.url || "";
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !url.startsWith("file:") ||
      !url.includes("/dist/renderer/")
    )
      throw new Error("Local settings are only available to the app window");
    if (
      input !== undefined &&
      (!input || typeof input !== "object" || Array.isArray(input))
    )
      throw new Error("Invalid local settings request");
    return settings(input);
  });
  const localUi = (event) => {
    const url = event.senderFrame?.url || "";
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !url.startsWith("file:") ||
      !url.includes("/dist/renderer/")
    )
      throw new Error("This action is only available in the app window");
  };
  ipcMain.handle("grok-local:work", (event, input) => {
    localUi(event);
    return chatWork.dispatch(input);
  });
  ipcMain.handle("grok-local:connections", (event, input) => {
    localUi(event);
    return connectionSettings.dispatch(input);
  });
  app.on("session-created", block);
  app.whenReady().then(() => block(session.defaultSession));
  if (process.env.GROK_LOCAL_VERIFY_NATIVE === "1")
    app.whenReady().then(async () => {
      const probe = new MacClient(nativeTools.helperPath);
      try {
        const reply = await probe.request("tools/list", {});
        const apps = await probe.call("computer_apps", {});
        const permissions = await probe.call("computer_check_permissions", {});
        const denied = await probe.call(
          "computer_resolve_app",
          { bundle_id: "com.google.Chrome" },
          undefined,
          [],
        );
        const allowed = await probe.call(
          "computer_resolve_app",
          { bundle_id: "com.google.Chrome" },
          undefined,
          ["com.google.Chrome"],
        );
        fs.writeFileSync(
          path.join(dataDir, "native-verification.json"),
          JSON.stringify({
            toolCount: reply.tools?.length,
            appPolicy: {
              denied: denied.policyDenied === true,
              allowed: !allowed.isError,
            },
            apps,
            permissions,
            error: reply.error || null,
          }),
          { mode: 0o600 },
        );
      } catch (error) {
        fs.writeFileSync(
          path.join(dataDir, "native-verification.json"),
          JSON.stringify({ error: error.message }),
          { mode: 0o600 },
        );
      } finally {
        probe.close();
      }
    });
  app.on("before-quit", () => {
    clearTimeout(changedTimer);
    auth.cancelLogin();
    gateway.close();
    nativeTools.close();
    gateway.automations.close();
    gateway.connectors.close();
  });
  return true;
}
function connector() {
  return {
    connect: async () => {
      await gatewayReady;
      return {
        baseUrl: gateway.baseUrl,
        token: gateway.token,
        headers: { authorization: `Bearer ${gateway.token}` },
      };
    },
    issueLocalExecDaemonCredential: async () => undefined,
  };
}
function getPermission() {
  return gateway.state.workspacePermission || "ask";
}
function setPermission(permission) {
  if (!["always", "ask", "never"].includes(permission))
    throw new Error("Invalid local permission");
  gateway.state.workspacePermission = permission;
  gateway.save();
}
module.exports = {
  start,
  createAuthService,
  client,
  connector,
  access,
  getPermission,
  setPermission,
  dispatch: (method, args) => gateway.dispatch(method, args),
};
