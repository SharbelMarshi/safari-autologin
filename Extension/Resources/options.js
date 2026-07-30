const browserApi = globalThis.browser || globalThis.chrome;
const siteListEl = document.getElementById('siteList');
const emptyStateEl = document.getElementById('emptyState');
const optionsStatusEl = document.getElementById('optionsStatus');
const editorPanelEl = document.getElementById('editorPanel');
const editorTitleEl = document.getElementById('editorTitle');
const editorFieldsEl = document.getElementById('editorFields');
const editorLoginPathEl = document.getElementById('editorLoginPath');
const editorStatusEl = document.getElementById('editorStatus');

let currentRules = {};
let currentHostname = null;
let currentFields = [];

function setOptionsStatus(message, isError = false) {
  optionsStatusEl.textContent = message;
  optionsStatusEl.classList.remove('hidden');
  optionsStatusEl.classList.toggle('status-error', isError);
}

function clearOptionsStatus() {
  optionsStatusEl.textContent = '';
  optionsStatusEl.classList.add('hidden');
  optionsStatusEl.classList.remove('status-error');
}

function setEditorStatus(message, isError = false) {
  editorStatusEl.textContent = message;
  editorStatusEl.classList.toggle('status-error', isError);
}

function normalizeFields(fields, rule) {
  if (Array.isArray(fields) && fields.length) {
    return fields.map((field, index) => ({
      id: field?.id || `field-${index + 1}`,
      label: field?.label || `Field ${index + 1}`,
      value: field?.value || '',
      type: field?.type === 'password' ? 'password' : 'text',
      meaning: field?.meaning || (field?.type === 'password' ? 'password' : `text-${index + 1}`),
      position: field?.position || '',
      secretRef: field?.secretRef || ''
    }));
  }

  return [
    { id: 'username', label: 'Username or email', value: rule?.username || '', type: 'text', meaning: 'username', position: '', secretRef: '' },
    { id: 'password', label: 'Password', value: rule?.password || '', type: 'password', meaning: 'password', position: '', secretRef: '' }
  ];
}

function createRevealButton(input) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reveal-button';
  button.textContent = 'Show';
  button.setAttribute('aria-label', 'Show password');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  });
  return button;
}

function renderEditorFields() {
  editorFieldsEl.innerHTML = '';

  currentFields.forEach((field, index) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'field-group';

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = field.label;
    label.dir = 'auto';

    const input = document.createElement('input');
    input.type = field.type;
    input.dir = 'auto';
    input.value = field.value || '';
    input.addEventListener('input', (event) => {
      currentFields[index].value = event.target.value;
    });

    wrapper.append(label);

    if (field.type === 'password') {
      const inputWrap = document.createElement('span');
      inputWrap.className = 'password-input-wrap';
      inputWrap.append(input, createRevealButton(input));
      wrapper.append(inputWrap);
    } else {
      wrapper.append(input);
    }

    editorFieldsEl.appendChild(wrapper);
  });
}

function collectFields() {
  return currentFields.map((field) => ({
    id: field.id,
    label: field.label,
    value: field.value || '',
    type: field.type,
    meaning: field.meaning,
    position: field.position,
    secretRef: field.secretRef || ''
  }));
}

function addFieldToEditor() {
  const nextIndex = currentFields.length + 1;
  const passwordIndex = currentFields.findIndex((field) => field.type === 'password');
  const newField = {
    id: `field-${nextIndex}`,
    label: `Additional field ${nextIndex - 1}`,
    value: '',
    type: 'text',
    meaning: `text-${nextIndex}`,
    position: '',
    secretRef: ''
  };

  if (passwordIndex >= 0) {
    currentFields.splice(passwordIndex, 0, newField);
  } else {
    currentFields.push(newField);
  }

  renderEditorFields();
}

function closeEditor() {
  currentHostname = null;
  currentFields = [];
  editorPanelEl.classList.add('hidden');
  setEditorStatus('', false);
}

async function openEditor(hostname) {
  if (currentHostname === hostname && !editorPanelEl.classList.contains('hidden')) {
    closeEditor();
    return;
  }

  // Load through the background so Keychain-backed passwords are resolved.
  const response = await browserApi.runtime.sendMessage({ type: 'GET_SITE_RULE', hostname });
  const rule = response?.rule;
  if (!rule) {
    setOptionsStatus(`Could not load ${hostname}.`, true);
    return;
  }

  currentHostname = hostname;
  currentFields = normalizeFields(rule.fields, rule);
  editorTitleEl.textContent = hostname;
  editorLoginPathEl.value = rule.loginPagePath || '';
  setEditorStatus('', false);
  renderEditorFields();
  editorPanelEl.classList.remove('hidden');
}

function createSiteRow(hostname, rule) {
  const row = document.createElement('section');
  row.className = 'site-row';
  row.dataset.hostname = hostname;

  const textWrap = document.createElement('div');
  textWrap.className = 'site-row-copy';

  const title = document.createElement('div');
  title.className = 'site-row-title';
  title.textContent = hostname;

  const meta = document.createElement('p');
  meta.className = 'rule-meta';
  meta.textContent = rule.updatedAt ? `Updated ${new Date(rule.updatedAt).toLocaleString()}` : 'Saved locally';

  const actionButton = document.createElement('button');
  actionButton.className = 'site-menu-button';
  actionButton.type = 'button';
  actionButton.setAttribute('aria-label', `Edit ${hostname}`);
  actionButton.textContent = '›';
  actionButton.addEventListener('click', () => openEditor(hostname));

  textWrap.append(title, meta);
  row.append(textWrap, actionButton);
  return row;
}

function renderSiteList() {
  siteListEl.innerHTML = '';
  const entries = Object.entries(currentRules);

  if (!entries.length) {
    emptyStateEl.classList.remove('hidden');
    closeEditor();
    return;
  }

  emptyStateEl.classList.add('hidden');

  entries.forEach(([hostname, rule]) => {
    siteListEl.appendChild(createSiteRow(hostname, rule));
  });
}

async function saveEditorRule() {
  if (!currentHostname) {
    return;
  }

  const response = await browserApi.runtime.sendMessage({
    type: 'SAVE_SITE_RULE',
    hostname: currentHostname,
    fields: collectFields(),
    loginPagePath: editorLoginPathEl.value.trim()
  });

  setEditorStatus(response?.ok ? 'Saved just now.' : response?.message || 'Unable to save.', !response?.ok);
}

async function deleteEditorRule() {
  if (!currentHostname) {
    return;
  }

  const hostname = currentHostname;
  const response = await browserApi.runtime.sendMessage({ type: 'DELETE_SITE_RULE', hostname });

  if (!response?.ok || !response?.verified) {
    setEditorStatus(response?.message || 'Unable to delete site.', true);
    return;
  }

  setOptionsStatus(`Deleted ${hostname}.`);
  closeEditor();
  await loadRules();
}

async function clearAllRules() {
  const response = await browserApi.runtime.sendMessage({ type: 'CLEAR_ALL_SITE_RULES' });
  setOptionsStatus(response?.message || 'Cleared all site rules.', !response?.verified);
  closeEditor();
  await loadRules();
}

async function resetExtensionData() {
  const response = await browserApi.runtime.sendMessage({ type: 'RESET_EXTENSION_DATA' });
  setOptionsStatus(response?.message || 'Reset extension data.', !response?.verified);
  closeEditor();
  await loadRules();
}

// Refreshes the site list only; the open editor keeps its in-progress edits
// and is closed only when its site no longer exists.
async function loadRules() {
  const response = await browserApi.runtime.sendMessage({ type: 'GET_ALL_SITE_RULES' });
  currentRules = response?.rules || {};

  if (currentHostname && !currentRules[currentHostname]) {
    closeEditor();
  }

  renderSiteList();
}

const confirmTimers = new WeakMap();

// Destructive buttons require a second click within a few seconds.
function withConfirmation(button, confirmLabel, action) {
  button.addEventListener('click', () => {
    if (button.dataset.confirming === 'true') {
      window.clearTimeout(confirmTimers.get(button));
      delete button.dataset.confirming;
      button.classList.remove('confirming');
      button.textContent = button.dataset.originalLabel;
      action();
      return;
    }

    button.dataset.originalLabel = button.textContent;
    button.dataset.confirming = 'true';
    button.classList.add('confirming');
    button.textContent = confirmLabel;

    confirmTimers.set(
      button,
      window.setTimeout(() => {
        delete button.dataset.confirming;
        button.classList.remove('confirming');
        button.textContent = button.dataset.originalLabel;
      }, 4000)
    );
  });
}

withConfirmation(document.getElementById('clearAll'), 'Really clear all?', clearAllRules);
withConfirmation(document.getElementById('resetData'), 'Really reset?', resetExtensionData);
withConfirmation(document.getElementById('deleteEditor'), 'Really delete?', deleteEditorRule);
document.getElementById('editorAddField').addEventListener('click', addFieldToEditor);
document.getElementById('saveEditor').addEventListener('click', saveEditorRule);

browserApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.sites) {
    loadRules();
  }
});

document.addEventListener('DOMContentLoaded', loadRules);
