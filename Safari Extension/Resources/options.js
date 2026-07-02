const browserApi = globalThis.browser || globalThis.chrome;
const siteListEl = document.getElementById('siteList');
const emptyStateEl = document.getElementById('emptyState');
const optionsStatusEl = document.getElementById('optionsStatus');
const editorPanelEl = document.getElementById('editorPanel');
const editorTitleEl = document.getElementById('editorTitle');
const editorFieldsEl = document.getElementById('editorFields');
const editorAutoFillEl = document.getElementById('editorAutoFill');
const editorAutoSubmitEl = document.getElementById('editorAutoSubmit');
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
      position: field?.position || ''
    }));
  }

  return [
    { id: 'username', label: 'Username or email', value: rule?.username || '', type: 'text', meaning: 'username', position: '' },
    { id: 'password', label: 'Password', value: rule?.password || '', type: 'password', meaning: 'password', position: '' }
  ];
}

function createToggle(labelText, helperText, className, checked) {
  const label = document.createElement('label');
  label.className = 'switch-row';

  const textWrap = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = labelText;
  const helper = document.createElement('small');
  helper.textContent = helperText;
  textWrap.append(title, helper);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = className;
  input.checked = checked;

  label.append(textWrap, input);
  return label;
}

function renderEditorFields() {
  editorFieldsEl.innerHTML = '';

  currentFields.forEach((field, index) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'field-group';

    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = field.label;

    const input = document.createElement('input');
    input.type = field.type;
    input.value = field.value || '';
    input.addEventListener('input', (event) => {
      currentFields[index].value = event.target.value;
    });

    wrapper.append(label, input);
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
    position: field.position
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
    position: ''
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

function openEditor(hostname) {
  if (currentHostname === hostname && !editorPanelEl.classList.contains('hidden')) {
    closeEditor();
    return;
  }

  const rule = currentRules[hostname];
  if (!rule) {
    return;
  }

  currentHostname = hostname;
  currentFields = normalizeFields(rule.fields, rule);
  editorTitleEl.textContent = hostname;
  editorAutoFillEl.checked = Boolean(rule.autoFill);
  editorAutoSubmitEl.checked = Boolean(rule.autoSubmit);
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
  actionButton.textContent = '⋮';
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
    loginPagePath: '',
    autoFill: editorAutoFillEl.checked,
    autoSubmit: editorAutoSubmitEl.checked
  });

  setEditorStatus(response?.ok ? 'Saved just now.' : response?.message || 'Unable to save.', !response?.ok);
  await loadRules();
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

async function loadRules() {
  const response = await browserApi.runtime.sendMessage({ type: 'GET_ALL_SITE_RULES' });
  currentRules = response?.rules || {};
  renderSiteList();

  if (currentHostname && currentRules[currentHostname]) {
    openEditor(currentHostname);
  }
}

document.getElementById('clearAll').addEventListener('click', clearAllRules);
document.getElementById('resetData').addEventListener('click', resetExtensionData);
document.getElementById('closeEditor').addEventListener('click', closeEditor);
document.getElementById('editorAddField').addEventListener('click', addFieldToEditor);
document.getElementById('saveEditor').addEventListener('click', saveEditorRule);
document.getElementById('deleteEditor').addEventListener('click', deleteEditorRule);

browserApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.sites) {
    clearOptionsStatus();
    loadRules();
  }
});

document.addEventListener('DOMContentLoaded', loadRules);
