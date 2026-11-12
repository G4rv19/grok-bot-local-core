'use strict';

const api = window.desktop;
const byId = id => document.getElementById(id);
const dialog = byId('dialog');
const body = byId('dialog-body');
const prompt = byId('prompt');
const drafts = new Map();
let state;
let selected;
let refreshTimer;
let revision = 0;
let sending = false;
let dialogView;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function errorMessage(error) {
  return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function report(error) {
  const message = byId('notice');
  message.textContent = typeof error === 'string' ? error : errorMessage(error);
  message.hidden = false;
}

function button(text, run, className) {
  const control = element('button', text, className);
  control.type = 'button';
  control.addEventListener('click', async () => {
    control.disabled = true;
    try {
      byId('notice').hidden = true;
      await run();
    } catch (error) {
      if (dialog.open) showFormError(error);
      else report(error);
    } finally {
      control.disabled = false;
    }
  });
  return control;
}

function showFormError(error) {
  let message = body.querySelector('.form-error');
  if (!message) {
    message = element('p', '', 'form-error');
    message.setAttribute('role', 'alert');
    body.append(message);
  }
  message.textContent = errorMessage(error);
}

async function refresh() {
  const request = ++revision;
  const next = await api.invoke('snapshot', { agentId: selected });
  if (request !== revision) return;
  state = next;
  selected = state.agent.id;
  render();
  if (dialog.open && dialogView === 'settings') renderSettings();
}

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    refresh().catch(report);
  }, 45);
}

async function act(action, payload = {}) {
  const result = await api.invoke(action, { agentId: selected, ...payload });
  await refresh();
  return result;
}

function currentDraft() {
  if (!drafts.has(selected)) drafts.set(selected, { text: '', attachments: [] });
  return drafts.get(selected);
}

async function choose(id) {
  selected = id;
  prompt.value = currentDraft().text;
  await refresh();
  prompt.focus();
}

function renderTranscript() {
  const transcript = byId('transcript');
  const previous = transcript.dataset.agent;
  const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 90;
  transcript.dataset.agent = selected;
  if (!state.entries.length) {
    const empty = element('div', null, 'empty');
    empty.append(element('h2', `Talk to ${state.agent.name}`));
    if (!state.account.connected) {
      empty.append(element('p', 'Connect ChatGPT in Settings to start a conversation.'));
    } else if (state.demo) {
      empty.append(element('p', 'Demo mode echoes messages without an account.'));
    }
    transcript.replaceChildren(empty);
    return;
  }
  const messages = state.entries.map(entry => {
    if (entry.kind === 'user-attachment') return element('p', `Attached: ${entry.file_name}`, 'message attachment');
    if (entry.kind === 'tool-call') {
      const details = element('details', null, 'message');
      details.append(element('summary', 'Tool activity'), element('p', entry.summary || 'Tool result'));
      return details;
    }
    if (entry.kind !== 'message') return null;
    const article = element('article', null, `message ${entry.role === 'user' ? 'user' : 'assistant'}`);
    const name = entry.fromAgent?.name || (entry.role === 'user' ? 'You' : state.agent.name);
    article.append(element('strong', name), element('p', entry.content));
    return article;
  }).filter(Boolean);
  transcript.replaceChildren(...messages);
  if (previous !== selected || nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderAttachments() {
  const draft = currentDraft();
  byId('attachments').replaceChildren(...draft.attachments.map((attachment, index) =>
    button(`${attachment.name} ×`, () => {
      draft.attachments.splice(index, 1);
      renderAttachments();
    }),
  ));
  byId('send').disabled = sending || state.agent.isRunning || !state.account.connected || !state.model || (!draft.text.trim() && !draft.attachments.length);
}

function taskAction(text, action, id) {
  return button(text, () => act('work', { action, id }));
}

function workCard(item, schedule) {
  const card = element('article', null, 'card');
  card.append(element('strong', item.title), element('p', schedule ? `${item.label} · ${item.status}` : item.status));
  if (item.nextRunAt) card.append(element('p', new Date(item.nextRunAt).toLocaleString()));
  for (const detail of [item.progress, item.error, item.result]) if (detail) card.append(element('p', detail));
  const controls = element('div', null, 'row-actions');
  const taskId = schedule ? item.activeTaskId : item.id;
  if (item.canPause) controls.append(taskAction('Pause run', 'pause', taskId));
  if (item.canResume) controls.append(taskAction('Resume run', 'resume', taskId));
  if (item.canStop) controls.append(taskAction('Stop run', 'stop', taskId));
  if (schedule) {
    if (item.canRun) controls.append(taskAction('Run now', 'runSchedule', item.id));
    controls.append(
      taskAction(item.enabled ? 'Disable' : 'Enable', item.enabled ? 'pauseSchedule' : 'resumeSchedule', item.id),
      button('Edit', () => openSchedule(item)),
      button('Remove', () => {
        if (window.confirm('Remove this schedule?')) return act('work', { action: 'removeSchedule', id: item.id });
      }),
    );
  }
  card.append(controls);
  return card;
}

function renderWork() {
  const { tasks, schedules, background } = state.work;
  const items = byId('work-items');
  const children = [];
  if (background?.paused) children.push(element('p', 'Automation is paused.', 'card'));
  if (!tasks.length && !schedules.length) children.push(element('p', 'No tasks or schedules yet.', 'card'));
  for (const task of tasks) children.push(workCard(task, false));
  for (const schedule of schedules) children.push(workCard(schedule, true));
  items.replaceChildren(...children);
}

function render() {
  byId('bot-name').textContent = state.agent.name;
  byId('activity').textContent = state.agent.activity || (state.agent.isRunning ? 'Working' : 'Ready');
  byId('stop').hidden = !state.agent.isRunning;
  const bots = state.agents.map(bot => {
    const control = button(bot.name, () => choose(bot.id));
    control.title = bot.name;
    control.setAttribute('aria-current', String(bot.id === selected));
    return control;
  });
  byId('bots').replaceChildren(...bots);
  renderTranscript();
  renderAttachments();
  if (!byId('work').hidden) renderWork();
}

function openDialog(title, view) {
  dialogView = view;
  byId('dialog-title').textContent = title;
  body.replaceChildren();
  if (!dialog.open) dialog.showModal();
}

function field(name, title, config = {}) {
  const label = element('label', title);
  const input = document.createElement(config.options ? 'select' : config.multiline ? 'textarea' : 'input');
  if (config.options) {
    for (const [value, text] of config.options) input.add(new Option(text, value));
  } else if (config.type) input.type = config.type;
  input.name = name;
  input.required = !!config.required;
  if (config.placeholder) input.placeholder = config.placeholder;
  if (config.value != null) input.value = config.value;
  label.append(input);
  return label;
}

function form(fields, label, submit) {
  const node = document.createElement('form');
  const save = element('button', label, 'primary');
  save.type = 'submit';
  node.append(...fields, save);
  node.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      body.querySelector('.form-error')?.remove();
      await submit(Object.fromEntries(new FormData(node)));
    } catch (error) {
      showFormError(error);
    } finally {
      save.disabled = false;
    }
  });
  return node;
}

function openBot(bot) {
  openDialog(bot ? 'Edit Bot' : 'New Bot', 'bot');
  body.append(form([
    field('name', 'Name', { value: bot?.name, required: true }),
    field('description', 'Instructions', { value: bot?.description, multiline: true }),
  ], 'Save Bot', async fields => {
    const result = await act(bot ? 'updateAgent' : 'createAgent', fields);
    dialog.close();
    if (!bot) await choose(result);
  }));
}

function openTask() {
  openDialog('New task', 'task');
  body.append(form([
    field('title', 'Name', { required: true }),
    field('prompt', 'Instructions', { multiline: true, required: true }),
  ], 'Start task', async fields => {
    await act('work', { action: 'start', nonce: crypto.randomUUID(), ...fields });
    dialog.close();
  }));
}

function localTime(epoch, timeZone) {
  if (!epoch) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(epoch));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

function openSchedule(item) {
  openDialog(item ? 'Edit schedule' : 'New schedule', 'schedule');
  const frequency = field('frequency', 'Repeat', {
    options: [['once', 'Once'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['custom', 'Custom cron']],
    value: item?.schedule ? 'custom' : 'once',
  });
  const timeZone = item?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = field('dateTime', 'Date and time', { type: 'datetime-local', value: localTime(item?.runAt, timeZone) });
  const time = field('time', 'Time of day', { type: 'time', value: '09:00' });
  const schedule = field('schedule', 'Cron expression', { value: item?.schedule, placeholder: '0 9 * * 1-5' });
  const select = frequency.querySelector('select');
  const sync = () => {
    date.hidden = select.value !== 'once';
    time.hidden = !['daily', 'weekdays'].includes(select.value);
    schedule.hidden = select.value !== 'custom';
    for (const label of [date, time, schedule]) label.querySelector('input').required = !label.hidden;
  };
  select.addEventListener('change', sync);
  sync();
  body.append(form([
    field('name', 'Name', { value: item?.title, required: true }),
    field('prompt', 'Instructions', { value: item?.prompt, multiline: true, required: true }),
    frequency, date, time, schedule,
    field('timeZone', 'Time zone', { value: timeZone, required: true }),
  ], 'Save schedule', async spec => {
    await act('work', { action: 'saveSchedule', id: item?.id, spec: { ...spec, enabled: item?.enabled, missed: item?.missed }, nonce: crypto.randomUUID() });
    dialog.close();
  }));
}

function renderSettings() {
  body.replaceChildren(element('p', state.account.connected ? `Connected as ${state.account.name}` : 'Connect your ChatGPT account to load available models.'));
  const accountControls = element('div', null, 'row-actions');
  if (state.account.connected && !state.demo) {
    accountControls.append(button('Refresh models', () => act('reloadModels')), button('Sign out', () => act('signOut')));
  } else if (!state.demo) {
    accountControls.append(button('Sign in with ChatGPT', async () => {
      await api.invoke('signIn');
      body.prepend(element('p', 'Finish signing in in your browser.'));
    }, 'primary'));
  }
  body.append(accountControls);
  if (state.models.length) {
    body.append(form([
      field('model', 'Model', { value: state.model, options: state.models.map(model => [model.id, model.name]) }),
    ], 'Save model', values => act('setModel', values)));
  }
  body.append(form([
    field('permission', 'Local actions', { value: state.permission, options: [['ask', 'Ask for interactive actions'], ['never', 'Chat only']] }),
  ], 'Save local settings', values => act('setPermission', values)));
  body.append(button(state.work.background?.paused ? 'Resume automation' : 'Pause automation', () => act('background', { paused: !state.work.background?.paused })));
}

async function renderConnections() {
  const data = await api.invoke('connections', { action: 'status' });
  if (!dialog.open || dialogView !== 'connections') return;
  const update = async (action, params) => {
    await api.invoke('connections', { action, ...params });
    await renderConnections();
  };
  body.replaceChildren();
  for (const service of data.catalog.filter(item => !item.configured)) {
    const card = element('div', null, 'card');
    card.append(element('strong', service.name), element('p', service.installed ? 'CLI installed' : 'Install the service CLI to connect'));
    if (service.installed) card.append(button('Add', () => update('connect', { id: service.id })));
    body.append(card);
  }
  for (const service of data.connections) {
    const card = element('div', null, 'card');
    card.append(element('strong', service.name), element('p', service.status?.authenticated ? 'Authenticated' : service.status?.message || service.endpoint));
    const row = element('div', null, 'row-actions');
    row.append(button('Test', () => update('test', { id: service.id })), button('Remove', () => update('remove', { id: service.id })));
    card.append(row);
    body.append(card);
  }
  const target = field('target', 'Server URL or executable path', { required: true });
  body.append(form([
    field('name', 'MCP server name', { required: true }),
    target,
    field('args', 'Executable arguments (JSON array)', { placeholder: '[]' }),
  ], 'Add MCP server', async ({ name, target: value, args }) => {
    const id = crypto.randomUUID();
    const definition = /^https?:\/\//i.test(value)
      ? { id, name, url: value }
      : { id, name, command: value, args: args ? JSON.parse(args) : [] };
    await update('add', { definition });
  }));
}

function showWork(visible) {
  byId('work').hidden = !visible;
  byId('toggle-work').setAttribute('aria-expanded', String(visible));
  if (visible) renderWork();
}

byId('new-bot').onclick = () => openBot();
byId('edit-bot').onclick = () => openBot(state.agent);
byId('workspace').onclick = () => act('workspace').then(error => { if (error) report(error); }).catch(report);
byId('new-chat').onclick = () => {
  if (window.confirm('Start a new conversation? Saved memories and skills will be kept.')) act('fresh').catch(report);
};
byId('settings').onclick = () => { openDialog('Settings', 'settings'); renderSettings(); };
byId('connections').onclick = () => { openDialog('Connections', 'connections'); renderConnections().catch(showFormError); };
byId('close-dialog').onclick = () => dialog.close();
byId('toggle-work').onclick = () => showWork(byId('work').hidden);
byId('close-work').onclick = () => showWork(false);
byId('new-task').onclick = openTask;
byId('new-schedule').onclick = () => openSchedule();
byId('stop').onclick = () => act('stop').catch(report);
byId('attach').onclick = async () => {
  const agentId = selected;
  const draft = currentDraft();
  try {
    const attachments = await api.invoke('attach', { agentId, remaining: 10 - draft.attachments.length });
    draft.attachments.push(...attachments);
    if (agentId === selected) renderAttachments();
  } catch (error) { report(error); }
};
prompt.oninput = () => { currentDraft().text = prompt.value; renderAttachments(); };
prompt.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!byId('send').disabled) byId('composer').requestSubmit();
  }
};
byId('composer').onsubmit = async event => {
  event.preventDefault();
  if (byId('send').disabled) return;
  const agentId = selected;
  const draft = currentDraft();
  sending = true;
  renderAttachments();
  try {
    byId('notice').hidden = true;
    await api.invoke('send', { agentId, prompt: draft.text, attachmentPaths: draft.attachments.map(item => item.path), clientNonce: crypto.randomUUID() });
    draft.text = '';
    draft.attachments = [];
    if (agentId === selected) prompt.value = '';
    await refresh();
  } catch (error) { report(error); }
  finally { sending = false; renderAttachments(); }
};
api.onChanged(change => {
  if (change.type === 'error') report(change.detail);
  scheduleRefresh();
});
refresh().catch(report);
