const browserApi = globalThis.browser || globalThis.chrome;

const fieldListEl = document.getElementById('fieldList');
const addFieldButton = document.getElementById('addField');
const saveButton = document.getElementById('save');
const popupContextEl = document.getElementById('popupContext');
const popupStatusEl = document.getElementById('popupStatus');

let currentFields = [];
let currentRule = null;
let currentContextPromise = null;
let detectedFieldsPromise = null;

function setPopupStatus(message, isError = false) {
  popupStatusEl.textContent = message;
  popupStatusEl.classList.toggle('hidden', !message);
  popupStatusEl.classList.toggle('status-error', isError);
}

function tryGetHostname(url) {
  if (!url || !/^https?:/i.test(url)) {
    return '';
  }

  try {
    return (new URL(url).hostname || '').toLowerCase().trim();
  } catch (_error) {
    return '';
  }
}

function tryGetPathname(url) {
  if (!url || !/^https?:/i.test(url)) {
    return '';
  }

  try {
    return new URL(url).pathname || '';
  } catch (_error) {
    return '';
  }
}

async function getCurrentHostInfo() {
  if (currentContextPromise) {
    return currentContextPromise;
  }

  currentContextPromise = browserApi.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const currentTab = tabs[0] || null;
    return {
      hostname: tryGetHostname(currentTab?.url),
      path: tryGetPathname(currentTab?.url),
      tabId: currentTab?.id || null
    };
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
      .then((response) => (response?.ok ? response.fields || [] : []))
      .catch(() => []);
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
        position: field?.position || '',
        secretRef: field?.secretRef || ''
      }))
    : [];

  return safeFields.length ? safeFields : defaultFields().map((field) => ({ ...field, meaning: field.type === 'password' ? 'password' : 'username', position: '', secretRef: '' }));
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
    position: field.position || fallback[index]?.position || '',
    secretRef: field.secretRef || fallback[index]?.secretRef || ''
  }));
}

function createRevealButton(input) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reveal-button';
  button.textContent = 'Show';
  button.setAttribute('aria-label', 'Show password');
  button.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  });
  return button;
}

function renderFields() {
  fieldListEl.innerHTML = '';

  currentFields.forEach((field, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field-group';

    const label = document.createElement('label');
    label.textContent = field.label;
    label.setAttribute('for', `popup-field-${index}`);
    label.dir = 'auto';

    const input = document.createElement('input');
    input.id = `popup-field-${index}`;
    input.type = field.type;
    input.dir = 'auto';
    input.placeholder = field.type === 'password' ? 'Stored in the macOS Keychain' : 'Enter value';
    input.value = field.value || '';
    input.addEventListener('input', (event) => {
      currentFields[index].value = event.target.value;
    });

    wrapper.append(label);

    if (field.type === 'password') {
      const inputWrap = document.createElement('div');
      inputWrap.className = 'password-input-wrap';
      inputWrap.append(input, createRevealButton(input));
      wrapper.append(inputWrap);
    } else {
      wrapper.append(input);
    }

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
    position: field.position,
    secretRef: field.secretRef || ''
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
    position: '',
    secretRef: ''
  };

  if (passwordIndex >= 0) {
    currentFields.splice(passwordIndex, 0, newField);
  } else {
    currentFields.push(newField);
  }

  renderFields();
}

function renderContext(hostname, loginPagePath) {
  if (!popupContextEl) {
    return;
  }

  popupContextEl.textContent = loginPagePath ? `${hostname} · fills only ${loginPagePath}` : hostname;
}

async function populateFromRule(hostname) {
  const [rule, detectedFields] = await Promise.all([loadRule(hostname), detectSiteFields()]);
  currentRule = rule;
  currentFields = mergeDetectedFields(detectedFields, rule?.fields);
  renderContext(hostname, rule?.loginPagePath || '');
  renderFields();
}

function disablePopup(message) {
  setPopupStatus(message, true);
  popupContextEl.textContent = '';
  saveButton.disabled = true;
  addFieldButton.disabled = true;
  fieldListEl.innerHTML = '';
}

async function saveRule() {
  saveButton.disabled = true;
  setPopupStatus('');

  try {
    const { hostname, path, tabId } = await getCurrentHostInfo();
    if (!hostname) {
      disablePopup('AutoLogin only works on regular web pages.');
      return;
    }

    // Keep an existing login-page path; otherwise pin the current page when it
    // shows a password field, so autofill stays limited to the login page.
    const detectedFields = await detectSiteFields();
    const detectedPassword = detectedFields.some((field) => field.type === 'password');
    const loginPagePath = currentRule?.loginPagePath || (detectedPassword ? path : '');

    const response = await browserApi.runtime.sendMessage({
      type: 'SAVE_SITE_RULE',
      hostname,
      tabId,
      fields: collectFields(),
      loginPagePath
    });

    if (!response?.ok) {
      setPopupStatus(response?.message || 'Unable to save. Please try again.', true);
      saveButton.disabled = false;
      return;
    }

    window.close();
  } catch (error) {
    setPopupStatus(`Unable to save: ${error?.message || error}`, true);
    saveButton.disabled = false;
  }
}

async function init() {
  currentFields = defaultFields();
  renderFields();

  const { hostname, tabId } = await getCurrentHostInfo();
  if (!hostname) {
    disablePopup('AutoLogin only works on regular web pages. Open a website to save credentials.');
    return;
  }

  await populateFromRule(hostname);
  browserApi.runtime.sendMessage({ type: 'REFRESH_TOOLBAR_ICON', tabId, hostname }).catch(() => {});
}

browserApi.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local' || !changes.sites) {
    return;
  }

  const { hostname } = await getCurrentHostInfo();
  if (hostname) {
    await populateFromRule(hostname);
  }
});

saveButton.addEventListener('click', saveRule);
addFieldButton.addEventListener('click', addManualField);
document.addEventListener('DOMContentLoaded', init);
