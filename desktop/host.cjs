'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { AgentHarness } = require('../runtime/agent-harness.cjs');
const { AgentRuntime } = require('../runtime/agent-runtime.cjs');
const { AgentSkills } = require('../runtime/agent-skills.cjs');
const { AgentStore, writeJSON } = require('../runtime/agent-store.cjs');
const { AgentTasks } = require('../runtime/agent-tasks.cjs');
const { Automations } = require('../runtime/automations.cjs');
const { Background } = require('../runtime/background.cjs');
const { ChatGPTAuth } = require('../runtime/chatgpt-auth.cjs');
const { ChatGPTProvider } = require('../runtime/chatgpt-provider.cjs');
const { ChatWork } = require('../runtime/chat-work.cjs');
const { Connectors } = require('../runtime/connectors.cjs');
const { ConnectionSettings } = require('../runtime/connection-settings.cjs');
const { LocalGateway } = require('../runtime/local-gateway.cjs');
const { MAX_FILE } = require('../runtime/attachments.cjs');
const { WorkspaceTools } = require('./workspace.cjs');

function demoProvider() {
  return {
    async complete({ input }) {
      const last = input.findLast(item => item.role === 'user');
      const content = typeof last?.content === 'string'
        ? last.content
        : last?.content?.find(item => item.type === 'input_text')?.text;
      const text = content ? `Demo reply: ${content}` : 'Demo reply: attachment received.';
      return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] };
    },
  };
}

async function createHost({ dataDir, electron, publish, approve, selectFiles, demo }) {
  const settingsFile = path.join(dataDir, 'desktop-settings.json');
  const settings = await fs.readFile(settingsFile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return { permission: 'ask', models: {} };
  });
  const auth = new ChatGPTAuth({ dataDir });
  const store = new AgentStore(dataDir);
  const skills = new AgentSkills(store, { bundled: path.join(__dirname, '../src/skill-packs/pstack') });
  const gateway = new LocalGateway({
    dataDir,
    contract: { methods: { getHostSettings: { reply: { type: 'object' } } } },
    runModel: args => harness.run(args),
  });
  const background = new Background({ dataDir, gateway, electron });
  const getPermission = () => settings.permission;
  const nativeTools = new WorkspaceTools({ approve, getPermission, background });
  const provider = demo ? demoProvider() : new ChatGPTProvider({ getAccessToken: () => auth.getAccessToken() });
  const account = () => demo ? { kind: 'connected', name: 'Demo model' } : auth.status();
  const modelCatalog = () => demo ? Promise.resolve([{ slug: 'demo', display_name: 'Demo model', context_window: 100000 }]) : provider.models();
  const accountKey = () => account().accountId || 'demo';
  let models = [];
  const getModel = () => {
    const saved = settings.models[accountKey()];
    return models.find(model => model.slug === saved)?.slug || models[0]?.slug;
  };
  const runtime = new AgentRuntime({
    store, skills, provider, nativeTools, gateway, getPermission, getModel, modelCatalog,
  });
  const harness = new AgentHarness({ runtime, store });
  const connectors = new Connectors({
    dataDir,
    fetch: globalThis.fetch,
    authorize: (detail, signal, context) => nativeTools.authorize(detail, signal, context),
  });
  Object.assign(gateway, {
    contextStore: store, skills, background, nativeTools, connectors,
    tasks: new AgentTasks({ dataDir, gateway }),
    automations: new Automations({ dataDir, gateway }),
    canRunAutomatic: id => account().kind === 'connected' && !!getModel() && background.canRun(id),
    emit: publish,
    workChanged: () => publish('work'),
  });
  const work = new ChatWork(gateway);
  const connections = new ConnectionSettings({ connectors, loginGoogle: async () => {
    throw new Error('Run gws auth login in your terminal, then test the connection here');
  } });
  const startWork = () => gateway.tasks.start().catch(error => console.error(error.message));
  const refreshModels = async () => {
    const key = accountKey();
    const next = await modelCatalog();
    if (key !== accountKey() || account().kind !== 'connected') return;
    models = next;
    if (settings.models[key] && !models.some(item => item.slug === settings.models[key])) {
      delete settings.models[key];
      writeJSON(settingsFile, settings);
    }
    startWork();
  };
  const requireModel = () => {
    if (account().kind !== 'connected' || !getModel()) throw new Error('Connect ChatGPT and choose a model in Settings');
  };
  if (!gateway.state.agents.length) gateway.create({ name: 'Assistant' });
  gateway.automations.start();
  if (account().kind === 'connected') {
    if (demo) await refreshModels();
    else refreshModels().then(() => publish('settings')).catch(error => publish('error', error.message));
  }

  const snapshot = ({ agentId } = {}) => {
    const agents = gateway.state.agents.map(({ id, name, description, isRunning, currentActivity }) => ({ id, name, description, isRunning, activity: currentActivity?.detail }));
    const agent = agents.find(item => item.id === agentId) || agents[0];
    const entries = gateway.visibleEntries(agent.id).slice(-300);
    return {
      agent, agents, entries, work: work.snapshot(agent.id),
      account: { connected: account().kind === 'connected', name: account().name || account().email || '' },
      models: models.map(({ slug, display_name }) => ({ id: slug, name: display_name })),
      model: getModel(), permission: getPermission(), demo,
    };
  };

  const actions = {
    snapshot,
    createAgent: ({ name, description }) => gateway.create({ name: name.trim().slice(0, 100), description: description.slice(0, 10000) }).agent.id,
    updateAgent: ({ agentId, name, description }) => gateway.dispatch('updateAgent', { id: agentId, name: name.trim().slice(0, 100), description: description.slice(0, 10000) }),
    fresh: ({ agentId }) => gateway.dispatch('startFreshConversation', { id: agentId }),
    send: ({ agentId, prompt, attachmentPaths, clientNonce }) => {
      requireModel();
      return gateway.send({ agentId, prompt, attachmentPaths, clientNonce });
    },
    stop: ({ agentId }) => gateway.dispatch('interruptAgentRun', { id: agentId }),
    attach: async ({ agentId, remaining }) => {
      gateway.agent(agentId);
      const files = await selectFiles();
      const available = Math.min(10, Math.max(0, Number(remaining) || 0));
      if (files.length > available) throw new Error('Attach up to 10 files');
      const attached = [];
      for (const file of files) {
        if ((await fs.stat(file)).size > MAX_FILE) throw new Error('Attach files up to 20 MB each');
        const upload = gateway.attachments.upload({ agentId, filename: path.basename(file), bytesBase64: (await fs.readFile(file)).toString('base64') });
        attached.push({ path: upload.path, name: path.basename(file) });
      }
      return attached;
    },
    workspace: ({ agentId }) => electron.shell.openPath(gateway.agent(agentId).path),
    work: request => {
      if (['start', 'runSchedule', 'resume'].includes(request.action)) requireModel();
      return work.dispatch(request);
    },
    connections: request => connections.dispatch(request),
    signIn: async () => {
      if (demo) return;
      const login = await auth.beginLogin({ openExternal: url => electron.shell.openExternal(url) });
      login.done.then(refreshModels).then(() => publish('settings')).catch(error => publish('error', error.message));
    },
    signOut: async () => {
      if (demo) return;
      for (const controller of gateway.jobs.values()) controller.abort();
      await auth.logout();
      models = [];
      publish('settings');
    },
    reloadModels: refreshModels,
    setModel: ({ model }) => {
      if (!models.some(item => item.slug === model)) throw new Error('Choose an available model');
      settings.models[accountKey()] = model;
      writeJSON(settingsFile, settings);
      startWork();
    },
    setPermission: ({ permission }) => {
      if (!['ask', 'never'].includes(permission)) throw new Error('Choose a local action setting');
      settings.permission = permission;
      writeJSON(settingsFile, settings);
    },
    background: async ({ paused }) => {
      await background.configure({ paused });
      if (!paused) startWork();
    },
  };
  return {
    async invoke(action, payload = {}) {
      if (!Object.hasOwn(actions, action)) throw new Error('Unknown desktop action');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid desktop request');
      return actions[action](payload);
    },
    power(state) {
      Object.assign(background, state);
      background.wake();
      startWork();
    },
    close() {
      auth.cancelLogin();
      gateway.close();
      gateway.automations.close();
      connectors.close();
    },
  };
}

module.exports = { createHost };
