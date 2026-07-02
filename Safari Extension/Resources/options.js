const browserApi = globalThis.browser || globalThis.chrome;
const rulesEl = document.getElementById('rules');
const emptyStateEl = document.getElementById('emptyState');
const optionsStatusEl = document.getElementById('optionsStatus');

function setOptionsStatus(message, isError = false) {
  optionsStatusEl.textContent = message;
  optionsStatusEl.classList.remove('hidden');
  optionsStatusEl.classList.toggle('status-error', isError);
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

function createField(labelText, className, value, type = 'text') {
  const field = document.createElement('label');
  field.className = 'field-group';

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;

  const input = document.createElement('input');
  input.type = type;
  input.className = className;
  input.value = value;

  field.append(label, input);
  return field;
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

function createCredentialField(field, index) {
  const wrapper = document.createElement('label');
  wrapper.className = 'field-group';
  wrapper.dataset.fieldIndex = String(index);

  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = field.label;

  const input = document.createElement('input');
  input.type = field.type;
  input.className = 'rule-dynamic-field';
  input.value = field.value || '';
  input.dataset.fieldId = field.id;
  input.dataset.fieldType = field.type;
  input.dataset.fieldLabel = field.label;
  input.dataset.fieldMeaning = field.meaning || '';
  input.dataset.fieldPosition = field.position || '';

  wrapper.append(label, input);
  return wrapper;
}

function collectFields(card) {
  return Array.from(card.querySelectorAll('.rule-dynamic-field')).map((input, index) => ({
    id: input.dataset.fieldId || `field-${index + 1}`,
    label: input.dataset.fieldLabel || `Field ${index + 1}`,
    value: input.value,
    type: input.dataset.fieldType === 'password' ? 'password' : 'text',
    meaning: input.dataset.fieldMeaning || `text-${index + 1}`,
    position: input.dataset.fieldPosition || ''
  }));
}

function addFieldToCard(card) {
  const fieldsWrap = card.querySelector('.rule-fields');
  const currentCount = fieldsWrap.querySelectorAll('.rule-dynamic-field').length;
  const passwordField = fieldsWrap.querySelector('[data-field-type="password"]')?.closest('.field-group');
  const newField = createCredentialField(
    {
      id: `field-${currentCount + 1}`,
      label: `Additional field ${currentCount}`,
      value: '',
      type: 'text',
      meaning: `text-${currentCount + 1}`,
      position: ''
    },
    currentCount
  );

  if (passwordField) {
    fieldsWrap.insertBefore(newField, passwordField);
  } else {
    fieldsWrap.appendChild(newField);
  }
}

async function saveRule(hostname, card) {
  const autoFill = card.querySelector('.rule-autofill').checked;
  const autoSubmit = card.querySelector('.rule-autosubmit').checked;
  const status = card.querySelector('.rule-status');

  const response = await browserApi.runtime.sendMessage({
    type: 'SAVE_SITE_RULE',
    hostname,
    fields: collectFields(card),
    autoFill,
    autoSubmit
  });

  status.textContent = response?.ok ? 'Saved just now.' : response?.message || 'Unable to save.';
}

async function deleteRule(hostname, row) {
  row.remove();
  const response = await browserApi.runtime.sendMessage({ type: 'DELETE_SITE_RULE', hostname });

  if (!response?.ok || !response?.verified) {
    setOptionsStatus(response?.message || 'Unable to verify site deletion.', true);
  } else {
    setOptionsStatus(`Deleted ${hostname}.`);
  }

  await loadRules();
}

async function clearAllRules() {
  const response = await browserApi.runtime.sendMessage({ type: 'CLEAR_ALL_SITE_RULES' });
  setOptionsStatus(response?.message || 'Cleared all site rules.', !response?.verified);
  await loadRules();
}

async function resetExtensionData() {
  const response = await browserApi.runtime.sendMessage({ type: 'RESET_EXTENSION_DATA' });
  setOptionsStatus(response?.message || 'Reset extension data.', !response?.verified);
  await loadRules();
}

async function loadRules() {
  const response = await browserApi.runtime.sendMessage({ type: 'GET_ALL_SITE_RULES' });
  const rules = response?.rules || {};
  rulesEl.innerHTML = '';

  const entries = Object.entries(rules);
  if (!entries.length) {
    emptyStateEl.classList.remove('hidden');
    return;
  }
  emptyStateEl.classList.add('hidden');

  entries.forEach(([hostname, rule]) => {
    const row = document.createElement('section');
    row.className = 'rule-card';
    row.dataset.hostname = hostname;

    const header = document.createElement('div');
    header.className = 'rule-header';
    const title = document.createElement('div');
    title.className = 'rule-title';
    title.textContent = hostname;
    const updated = document.createElement('p');
    updated.className = 'rule-meta';
    updated.textContent = rule.updatedAt ? `Updated ${new Date(rule.updatedAt).toLocaleString()}` : 'Saved locally';
    header.append(title, updated);

    const fieldsWrap = document.createElement('div');
    fieldsWrap.className = 'rule-fields';
    normalizeFields(rule.fields, rule).forEach((field, index) => {
      fieldsWrap.appendChild(createCredentialField(field, index));
    });

    const addFieldButton = document.createElement('button');
    addFieldButton.className = 'secondary add-field-button';
    addFieldButton.textContent = '+ Add Another Field';
    addFieldButton.addEventListener('click', () => addFieldToCard(row));

    const autoFillToggle = createToggle('Auto-fill', 'Use this rule automatically on page load.', 'rule-autofill', Boolean(rule.autoFill));
    const autoSubmitToggle = createToggle('Auto-submit', 'Submit only when the page passes safety checks.', 'rule-autosubmit', Boolean(rule.autoSubmit));

    const footer = document.createElement('div');
    footer.className = 'rule-actions';
    const status = document.createElement('p');
    status.className = 'rule-status';
    status.textContent = ' ';

    const saveButton = document.createElement('button');
    saveButton.className = 'secondary';
    saveButton.textContent = 'Save Changes';
    saveButton.addEventListener('click', async () => {
      await saveRule(hostname, row);
      await loadRules();
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'danger';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', async () => {
      await deleteRule(hostname, row);
    });

    footer.append(saveButton, deleteButton);
    row.append(header, fieldsWrap, addFieldButton, autoFillToggle, autoSubmitToggle, footer, status);
    rulesEl.appendChild(row);
  });
}

document.getElementById('clearAll').addEventListener('click', clearAllRules);
document.getElementById('resetData').addEventListener('click', resetExtensionData);

browserApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.sites) {
    loadRules();
  }
});

document.addEventListener('DOMContentLoaded', loadRules);
