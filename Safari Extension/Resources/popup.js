const browserApi = globalThis.browser || globalThis.chrome;

const fieldListEl = document.getElementById('fieldList');
const autoFillInput = document.getElementById('autoFill');
const autoSubmitInput = document.getElementById('autoSubmit');
const addFieldButton = document.getElementById('addField');
const DEBUG_PERFORMANCE = false;

let currentFields = [];
let currentContextPromise = null;
let detectedFieldsPromise = null;

function perfLog(...args) {
  if (DEBUG_PERFORMANCE) {
    console.log('[AutoLogin:popup]', ...args);
  }
}

function tryGetHostname(url) {
  if (!url) {
    return 'unknown';
  }

  try {
    return new URL(url).hostname || 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

async function getCurrentHostInfo() {
  if (currentContextPromise) {
    return currentContextPromise;
  }

  currentContextPromise = browserApi.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const currentTab = tabs[0] || null;
    const hostname = tryGetHostname(currentTab?.url);
    perfLog('current tab resolved', hostname);
    return { hostname, tabId: currentTab?.id || null };
  });

  return currentContextPromise;
}

async function loadRule(hostname) {
  const response = await browserApi.runtime.sendMessage({ type: 'GET_SITE_RULE', hostname });
  return response?.rule || null;
}

async function detectSiteFields() {
  if (!detectedFieldsPromise) {
    detectedFieldsPromise = getCurrentHostInfo()
      .then(({ tabId }) => browserApi.runtime.sendMessage({ type: 'DETECT_LOGIN_FIELDS', tabId }))
      .then((response) => {
        perfLog('detected fields loaded');
        return response?.ok ? response.fields || [] : [];
      });
  }

  return detectedFieldsPromise;
}

function defaultFields() {
  return [
    { id: 'username', label: 'Username or email', value: '', type: 'text' },
    { id: 'password', label: 'Password', value: '', type: 'password' }
  ];
}

function normalizeFields(fields) {
  const safeFields = Array.isArray(fields)
    ? fields.map((field, index) => ({
        id: field?.id || `field-${index + 1}`,
        label: field?.label || `Field ${index + 1}`,
        value: field?.value || '',
        type: field?.type === 'password' ? 'password' : 'text',
        meaning: field?.meaning || (field?.type === 'password' ? 'password' : `text-${index + 1}`),
        position: field?.position || ''
      }))
    : [];

  return safeFields.length ? safeFields : defaultFields();
}

function mergeDetectedFields(detectedFields, savedFields) {
  const normalizedSaved = normalizeFields(savedFields);
  const normalizedDetected = normalizeFields(detectedFields);
  const preferred = normalizedDetected.length > normalizedSaved.length ? normalizedDetected : normalizedSaved;
  const fallback = preferred === normalizedDetected ? normalizedSaved : normalizedDetected;

  return preferred.map((field, index) => ({
    ...field,
    value: fallback[index]?.value || field.value || '',
    type: field.type === 'password' || fallback[index]?.type === 'password' ? 'password' : 'text',
    meaning: field.meaning || fallback[index]?.meaning || (field.type === 'password' ? 'password' : `text-${index + 1}`),
    position: field.position || fallback[index]?.position || ''
  }));
}

function renderFields() {
  fieldListEl.innerHTML = '';

  currentFields.forEach((field, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field-group';

    const label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', `popup-field-${index}`);

    const input = document.createElement('input');
    input.id = `popup-field-${index}`;
    input.type = field.type;
    input.placeholder = field.type === 'password' ? 'Saved only on this device' : 'Enter value';
    input.value = field.value || '';
    input.addEventListener('input', (event) => {
      currentFields[index].value = event.target.value;
    });

    wrapper.append(label, input);
    fieldListEl.appendChild(wrapper);
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

function addManualField() {
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

  renderFields();
}

async function populateFromRule(hostname) {
  const [rule, detectedFields] = await Promise.all([loadRule(hostname), detectSiteFields()]);
  currentFields = mergeDetectedFields(detectedFields, rule?.fields);
  autoFillInput.checked = Boolean(rule?.autoFill);
  autoSubmitInput.checked = Boolean(rule?.autoSubmit);
  renderFields();
}

async function saveRule() {
  const { hostname } = await getCurrentHostInfo();
  await browserApi.runtime.sendMessage({
    type: 'SAVE_SITE_RULE',
    hostname,
    fields: collectFields(),
    loginPagePath: '',
    autoFill: autoFillInput.checked,
    autoSubmit: autoSubmitInput.checked
  });
}

async function init() {
  currentFields = defaultFields();
  renderFields();

  const { hostname } = await getCurrentHostInfo();
  await populateFromRule(hostname);
}

browserApi.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local' || !changes.sites) {
    return;
  }

  const { hostname } = await getCurrentHostInfo();
  await populateFromRule(hostname);
});

document.getElementById('save').addEventListener('click', saveRule);
addFieldButton.addEventListener('click', addManualField);
document.addEventListener('DOMContentLoaded', init);
