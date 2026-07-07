const browserApi = globalThis.browser || globalThis.chrome;
const MAX_AUTOFILL_ATTEMPTS = 2;
const AUTOFILL_SECOND_ATTEMPT_DELAY = 80;

let cachedHostname = '';
let cachedRule = null;
let cachedRulePromise = null;
let autofillAttemptCount = 0;
let autofillStopped = false;
let mutationObserver = null;
let observerTimer = null;
let retryTimers = [];
let lastAutoFillLocation = '';

function getLocationKey() {
  return window.location.href;
}

function resetAutoFillSession() {
  autofillStopped = false;
  autofillAttemptCount = 0;
  clearRetryTimers();
  disconnectObserver();
}

function updateCachedRule(hostname, rule) {
  const normalized = hostname.toLowerCase().trim();
  cachedHostname = normalized;
  cachedRule = rule;
  cachedRulePromise = Promise.resolve(rule);
}

function looksLikeOtpField(field) {
  const name = (field?.name || '').toLowerCase();
  const id = (field?.id || '').toLowerCase();
  const autocomplete = (field?.autocomplete || '').toLowerCase();
  return autocomplete.includes('one-time-code') || /otp|code|2fa|mfa/i.test(name + id);
}

function isVisibleField(field) {
  return Boolean(field && !(field.offsetParent === null && field.getClientRects().length === 0));
}

function isFillableField(field) {
  if (!isVisibleField(field) || field.disabled || field.readOnly) {
    return false;
  }

  const type = (field.type || '').toLowerCase();
  if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'search'].includes(type)) {
    return false;
  }

  return ['text', 'email', 'password', 'tel', 'number', ''].includes(type);
}

function inferFieldType(field) {
  return (field.type || '').toLowerCase() === 'password' ? 'password' : 'text';
}

function getFieldRect(field) {
  const rect = field.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function isLikelyTextField(field) {
  return inferFieldType(field) !== 'password';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function inferFieldLabel(field, index) {
  const labelFromFor = field.id ? document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent : '';
  const wrapperLabel = field.closest('label')?.textContent || '';
  const ariaLabel = field.getAttribute('aria-label') || '';
  const placeholder = field.getAttribute('placeholder') || '';
  const autocomplete = field.getAttribute('autocomplete') || '';
  const name = field.getAttribute('name') || '';
  const id = field.getAttribute('id') || '';
  const text = [labelFromFor, wrapperLabel, ariaLabel, placeholder, autocomplete, name, id]
    .map((value) => (value || '').trim())
    .find(Boolean);

  if (text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  return inferFieldType(field) === 'password' ? 'Password' : `Field ${index + 1}`;
}

function inferFieldMeaning(field, index) {
  const label = normalizeText(inferFieldLabel(field, index));
  const name = normalizeText(field.getAttribute('name'));
  const id = normalizeText(field.getAttribute('id'));
  const placeholder = normalizeText(field.getAttribute('placeholder'));
  const autocomplete = normalizeText(field.getAttribute('autocomplete'));
  const haystack = [label, name, id, placeholder, autocomplete].join(' ');

  if (inferFieldType(field) === 'password') {
    return 'password';
  }

  if (/identity|national id|student id|id number|תעודת זהות|מספר זהות|מספר מזהה/.test(haystack)) {
    return 'identity';
  }

  if (/email|e-mail|username|user name|login|שם משתמש|משתמש/.test(haystack)) {
    return 'username';
  }

  return `text-${index + 1}`;
}

function getFieldDescriptor(field, index) {
  const rect = getFieldRect(field);
  return {
    id: field.id || field.name || `field-${index + 1}`,
    label: inferFieldLabel(field, index),
    type: inferFieldType(field),
    meaning: inferFieldMeaning(field, index),
    position: `${rect.top}:${rect.left}`
  };
}

function detectCaptcha() {
  if (document.body?.textContent && /captcha|recaptcha|hcaptcha/i.test(document.body.textContent)) {
    const visibleCaptchaNodes = Array.from(document.querySelectorAll('iframe, img, div, span, p, label')).filter((element) => {
      if (!isVisibleField(element) && !(element.getClientRects && element.getClientRects().length > 0)) {
        return false;
      }
      const text = (element?.textContent || '').toLowerCase();
      return /captcha|recaptcha|hcaptcha/i.test(text);
    });

    if (visibleCaptchaNodes.length > 0) {
      return true;
    }
  }

  return Array.from(document.querySelectorAll('iframe, img, div, span, p, label')).some((element) => {
    if (!(element.getClientRects && element.getClientRects().length > 0)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    const text = (element?.textContent || '').toLowerCase();
    return /captcha|recaptcha|hcaptcha/i.test(text);
  });
}

function setFieldValue(field, value) {
  if (!field) return false;

  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(field, value);
  } else {
    field.value = value;
  }

  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function getCandidateFields(form) {
  const scope = form || document;
  return Array.from(scope.querySelectorAll('input'))
    .filter((field) => isFillableField(field) && !looksLikeOtpField(field))
    .sort((left, right) => {
      const leftRect = getFieldRect(left);
      const rightRect = getFieldRect(right);
      const verticalDelta = leftRect.top - rightRect.top;

      if (Math.abs(verticalDelta) > 8) {
        return verticalDelta;
      }

      return leftRect.left - rightRect.left;
    });
}

function getFastTextCandidates(scope) {
  const directSelectors = [
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[name*="login" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[id*="login" i]',
    'input[type="text"]',
    'input[type="tel"]',
    'input[type="number"]'
  ];

  const seen = new Set();
  const matches = [];

  directSelectors.forEach((selector) => {
    scope.querySelectorAll(selector).forEach((field) => {
      if (!seen.has(field) && isFillableField(field) && !looksLikeOtpField(field) && isLikelyTextField(field)) {
        seen.add(field);
        matches.push(field);
      }
    });
  });

  return matches.sort((left, right) => {
    const leftRect = getFieldRect(left);
    const rightRect = getFieldRect(right);
    const verticalDelta = leftRect.top - rightRect.top;
    if (Math.abs(verticalDelta) > 8) {
      return verticalDelta;
    }
    return leftRect.left - rightRect.left;
  });
}

function getFastPasswordCandidate(scope) {
  const directMatch =
    scope.querySelector('input[autocomplete="current-password"]') ||
    scope.querySelector('input[autocomplete="password"]') ||
    scope.querySelector('input[type="password"]');

  return directMatch && isFillableField(directMatch) ? directMatch : null;
}

function scoreForm(form) {
  const fastPassword = getFastPasswordCandidate(form);
  const fastText = getFastTextCandidates(form);
  const fields = fastPassword || fastText.length ? [...fastText, ...(fastPassword ? [fastPassword] : [])] : getCandidateFields(form);
  const passwordCount = fields.filter((field) => inferFieldType(field) === 'password').length;
  const textCount = fields.length - passwordCount;
  return passwordCount * 10 + textCount;
}

function findBestLoginFields() {
  const forms = Array.from(document.querySelectorAll('form'));
  const scoredForms = forms
    .map((form) => ({ form, score: scoreForm(form) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scoredForms.length > 0) {
    const bestForm = scoredForms[0].form;
    const fastText = getFastTextCandidates(bestForm);
    const fastPassword = getFastPasswordCandidate(bestForm);

    if (fastText.length || fastPassword) {
      const merged = [...fastText];
      if (fastPassword && !merged.includes(fastPassword)) {
        merged.push(fastPassword);
      }
      return merged;
    }

    return getCandidateFields(bestForm);
  }

  const fastText = getFastTextCandidates(document);
  const fastPassword = getFastPasswordCandidate(document);
  if (fastText.length || fastPassword) {
    const merged = [...fastText];
    if (fastPassword && !merged.includes(fastPassword)) {
      merged.push(fastPassword);
    }
    return merged;
  }

  return getCandidateFields(document);
}

function detectLoginFields() {
  return findBestLoginFields().slice(0, 4).map((field, index) => getFieldDescriptor(field, index));
}

function findSubmitButton(form) {
  const submitCandidates = [];
  if (form) {
    submitCandidates.push(...Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')));
  }
  submitCandidates.push(...Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]')));
  const byText = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')).filter((element) => {
    const text = (element.value || element.textContent || '').trim().toLowerCase();
    return /login|log in|sign in|continue|submit|כניסה|התחבר|התחברות/.test(text);
  });
  submitCandidates.push(...byText);
  const unique = [];
  submitCandidates.forEach((element) => {
    if (!unique.includes(element)) unique.push(element);
  });
  return unique[0] || null;
}

function submitForm(targetField) {
  const form = targetField?.closest('form') || null;
  const submitButton = findSubmitButton(form);

  if (submitButton) {
    submitButton.click();
    return true;
  }

  if (form && typeof form.requestSubmit === 'function') {
    form.requestSubmit();
    return true;
  }

  if (form) {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    if (typeof form.submit === 'function') {
      form.submit();
      return true;
    }
  }

  if (targetField) {
    targetField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    targetField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
  }

  return false;
}

function detectAmbiguousForms() {
  const forms = Array.from(document.querySelectorAll('form'));
  return forms.filter((form) => {
    const fields = getCandidateFields(form);
    const hasPassword = fields.some((field) => inferFieldType(field) === 'password');
    const hasUsername = fields.some((field) => inferFieldType(field) !== 'password');
    return Boolean(hasPassword && hasUsername);
  }).length > 1;
}

function getVisiblePasswordFields(scope) {
  return Array.from(scope.querySelectorAll('input[type="password"], input[autocomplete="current-password"], input[autocomplete="password"]')).filter(
    (field) => isFillableField(field)
  );
}

function getLoginTextSignal(scope) {
  const action = scope instanceof HTMLFormElement ? scope.getAttribute('action') || '' : '';
  const text = [window.location.pathname, document.title, document.body?.innerText || '', action].join(' ').toLowerCase();
  return /login|log in|sign in|signin|auth|כניסה|התחבר|התחברות/.test(text);
}

function pageLooksLikeLoginPage() {
  const forms = Array.from(document.querySelectorAll('form'));

  const formLooksLikeLogin = forms.some((form) => {
    const candidateFields = getCandidateFields(form);
    const passwordFields = candidateFields.filter((field) => inferFieldType(field) === 'password');
    const textFields = candidateFields.filter((field) => inferFieldType(field) !== 'password');
    const hasLoginAutocomplete =
      Boolean(form.querySelector('input[autocomplete="username"]')) && Boolean(form.querySelector('input[autocomplete="current-password"]'));

    if (passwordFields.length === 1 && textFields.length >= 1) {
      return true;
    }

    return hasLoginAutocomplete && getLoginTextSignal(form);
  });

  if (formLooksLikeLogin) {
    return true;
  }

  const pagePasswordFields = getVisiblePasswordFields(document);
  const pageTextFields = getCandidateFields(document).filter((field) => inferFieldType(field) !== 'password');
  return pagePasswordFields.length === 1 && pageTextFields.length >= 1 && getLoginTextSignal(document);
}

function normalizePathname(pathname) {
  const value = String(pathname || '').trim();
  if (!value) {
    return '';
  }

  if (value.startsWith('/')) {
    return value;
  }

  return `/${value}`;
}

function hasVisibleLoginFields() {
  return Boolean(getFastPasswordCandidate(document)) && getFastTextCandidates(document).length > 0;
}

function shouldAttemptAutoFill(rule) {
  const savedLoginPagePath = normalizePathname(rule?.loginPagePath);

  if (savedLoginPagePath) {
    return normalizePathname(window.location.pathname) === savedLoginPagePath;
  }

  if (hasVisibleLoginFields()) {
    return true;
  }

  return pageLooksLikeLoginPage();
}

function normalizeIncomingFields(payload) {
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];

  if (fields.length > 0) {
    return fields.map((field, index) => ({
      id: field?.id || `field-${index + 1}`,
      label: field?.label || `Field ${index + 1}`,
      value: String(field?.value || ''),
      type: field?.type === 'password' ? 'password' : 'text',
      meaning: field?.meaning || (field?.type === 'password' ? 'password' : `text-${index + 1}`)
    }));
  }

  return [
    { id: 'username', label: 'Username or email', value: payload?.username || '', type: 'text', meaning: 'username' },
    { id: 'password', label: 'Password', value: payload?.password || '', type: 'password', meaning: 'password' }
  ];
}

function matchRequestedField(savedField, availableFields) {
  if (!availableFields.length) {
    return null;
  }

  const normalizedMeaning = savedField.meaning || '';

  if (normalizedMeaning) {
    const exactMeaningMatch = availableFields.find((field, index) => {
      if (field.meaning === normalizedMeaning) {
        availableFields.splice(index, 1);
        return true;
      }
      return false;
    });

    if (exactMeaningMatch) {
      return exactMeaningMatch;
    }
  }

  if (savedField.type === 'password') {
    const passwordMatch = availableFields.find((field, index) => {
      if (field.type === 'password') {
        availableFields.splice(index, 1);
        return true;
      }
      return false;
    });

    if (passwordMatch) {
      return passwordMatch;
    }
  }

  const fallback = availableFields.shift() || null;
  return fallback;
}

function fillLoginForm(payload) {
  const result = {
    ok: false,
    message: 'No login form found.',
    matchedFields: 0,
    totalFields: 0,
    submitted: false
  };

  const requestedFields = normalizeIncomingFields(payload).filter((field) => field.value);
  const candidateFields = findBestLoginFields();
  const shouldCheckAutoSubmitSafety = Boolean(payload?.autoSubmit);
  const hasOtp = shouldCheckAutoSubmitSafety ? Array.from(document.querySelectorAll('input')).some((field) => isVisibleField(field) && looksLikeOtpField(field)) : false;
  const hasCaptcha = shouldCheckAutoSubmitSafety ? detectCaptcha() : false;
  const ambiguousForms = shouldCheckAutoSubmitSafety ? detectAmbiguousForms() : false;
  const detectedDescriptors = candidateFields.map((field, index) => ({
    element: field,
    ...getFieldDescriptor(field, index)
  }));
  const availableFields = [...detectedDescriptors];
  const passwordField = candidateFields.find((field) => inferFieldType(field) === 'password') || null;
  let lastFilledField = null;

  if (!candidateFields.length) {
    result.message = 'No login form could be identified.';
    return result;
  }

  result.totalFields = requestedFields.length;

  requestedFields.forEach((savedField) => {
    const targetField = matchRequestedField(savedField, availableFields);
    if (targetField?.element && setFieldValue(targetField.element, savedField.value)) {
      result.matchedFields += 1;
      lastFilledField = targetField.element;
    }
  });

  if (result.matchedFields < requestedFields.length) {
    result.message = 'The form was partially filled.';
    return result;
  }

  if (hasCaptcha || hasOtp || ambiguousForms) {
    result.message = 'Safety checks blocked automatic submission.';
    result.ok = true;
    return result;
  }

  if (payload?.autoSubmit && requestedFields.length > 0) {
    if (submitForm(passwordField || lastFilledField || candidateFields[candidateFields.length - 1] || null)) {
      result.submitted = true;
      result.ok = true;
      result.message = 'Filled and submitted the form.';
      return result;
    }
  }

  result.ok = true;
  result.message = 'Filled the form.';
  return result;
}

function stopAutoFill() {
  autofillStopped = true;
  disconnectObserver();
  clearRetryTimers();
}

function beginAutoFillForCurrentPage() {
  if (autofillStopped) {
    return;
  }

  getCachedRule(window.location.hostname).then((rule) => {
    if (!rule?.autoFill || autofillStopped) {
      return;
    }

    tryAutoFill(rule);

    if (!autofillStopped && autofillAttemptCount < MAX_AUTOFILL_ATTEMPTS) {
      scheduleSecondAttempt();
    }

    setupMutationObserver();
  });
}

function onLocationMaybeChanged() {
  const locationKey = getLocationKey();
  if (locationKey === lastAutoFillLocation) {
    return;
  }

  lastAutoFillLocation = locationKey;
  resetAutoFillSession();
  invalidateRuleCache();
  beginAutoFillForCurrentPage();
}

function installNavigationListeners() {
  window.addEventListener('popstate', onLocationMaybeChanged);
  window.addEventListener('hashchange', onLocationMaybeChanged);

  const { pushState, replaceState } = history;
  history.pushState = function pushStatePatched(...args) {
    const result = pushState.apply(this, args);
    onLocationMaybeChanged();
    return result;
  };
  history.replaceState = function replaceStatePatched(...args) {
    const result = replaceState.apply(this, args);
    onLocationMaybeChanged();
    return result;
  };
}

function tryAutoFill(rule, options = {}) {
  const manual = Boolean(options.manual);

  if (!manual && autofillStopped) {
    return { attempted: false, success: false };
  }

  if (!manual && autofillAttemptCount >= MAX_AUTOFILL_ATTEMPTS) {
    stopAutoFill();
    return { attempted: false, success: false, exhausted: true };
  }

  if (!rule?.autoFill && !manual) {
    return { attempted: false, success: false };
  }

  if (!manual && !shouldAttemptAutoFill(rule)) {
    return { attempted: false, success: false, skipped: true };
  }

  const result = fillLoginForm({
    fields: rule.fields || [],
    autoSubmit: Boolean(rule.autoSubmit)
  });

  const success = Boolean(result.ok && result.matchedFields === result.totalFields && result.totalFields > 0);

  if (!manual) {
    autofillAttemptCount += 1;

    if (success || autofillAttemptCount >= MAX_AUTOFILL_ATTEMPTS) {
      stopAutoFill();
    }
  } else if (success) {
    stopAutoFill();
  }

  return { attempted: true, success, result };
}

async function autoFillIfEnabled() {
  const rule = await getCachedRule(window.location.hostname);
  return tryAutoFill(rule);
}

function normalizeStoredRule(hostname, rule) {
  if (!rule) {
    return null;
  }

  const fields = Array.isArray(rule.fields)
    ? rule.fields.map((field, index) => ({
        id: field?.id || `field-${index + 1}`,
        label: field?.label || `Field ${index + 1}`,
        value: String(field?.value || ''),
        type: field?.type === 'password' ? 'password' : 'text',
        meaning: field?.meaning || (field?.type === 'password' ? 'password' : `text-${index + 1}`)
      }))
    : [
        { id: 'username', label: 'Username or email', value: rule.username || '', type: 'text', meaning: 'username' },
        { id: 'password', label: 'Password', value: rule.password || '', type: 'password', meaning: 'password' }
      ];

  return {
    hostname,
    fields,
    loginPagePath: String(rule.loginPagePath || '').trim(),
    autoFill: Boolean(rule.autoFill),
    autoSubmit: Boolean(rule.autoSubmit)
  };
}

function loadRuleFromStorage(hostname) {
  const normalized = hostname.toLowerCase().trim();
  return browserApi.storage.local
    .get('sites')
    .then((result) => normalizeStoredRule(normalized, (result.sites || {})[normalized] || null))
    .catch(() => null);
}

function invalidateRuleCache() {
  cachedHostname = '';
  cachedRule = null;
  cachedRulePromise = null;
}

async function getCachedRule(hostname) {
  if (cachedHostname === hostname && cachedRule) {
    return cachedRule;
  }

  if (cachedHostname === hostname && cachedRulePromise) {
    return cachedRulePromise;
  }

  cachedHostname = hostname;
  cachedRulePromise = loadRuleFromStorage(hostname).then((rule) => {
    cachedRule = rule;
    return rule;
  });

  return cachedRulePromise;
}

function clearRetryTimers() {
  retryTimers.forEach((timer) => window.clearTimeout(timer));
  retryTimers = [];
}

function disconnectObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  if (observerTimer) {
    window.cancelAnimationFrame(observerTimer);
    observerTimer = null;
  }
}

function setupMutationObserver() {
  if (mutationObserver || autofillStopped) {
    return;
  }

  mutationObserver = new MutationObserver(() => {
    if (observerTimer || autofillStopped || autofillAttemptCount >= MAX_AUTOFILL_ATTEMPTS) {
      return;
    }

    observerTimer = window.requestAnimationFrame(async () => {
      observerTimer = null;
      if (autofillStopped || autofillAttemptCount >= MAX_AUTOFILL_ATTEMPTS) {
        return;
      }

      const outcome = await autoFillIfEnabled();
      if (outcome.success || outcome.exhausted) {
        disconnectObserver();
      }
    });
  });

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function scheduleSecondAttempt() {
  if (autofillStopped || autofillAttemptCount >= MAX_AUTOFILL_ATTEMPTS) {
    return;
  }

  clearRetryTimers();
  const timer = window.setTimeout(async () => {
    if (autofillStopped || autofillAttemptCount >= MAX_AUTOFILL_ATTEMPTS) {
      return;
    }

    await autoFillIfEnabled();
  }, AUTOFILL_SECOND_ATTEMPT_DELAY);

  retryTimers.push(timer);
}

browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'DETECT_LOGIN_FIELDS') {
    sendResponse({ ok: true, fields: detectLoginFields() });
    return true;
  }
  if (message?.type === 'FILL_NOW') {
    resetAutoFillSession();
    const result = fillLoginForm(message.payload || {});
    const success = Boolean(result.ok && result.matchedFields === result.totalFields && result.totalFields > 0);
    if (success) {
      stopAutoFill();
    }
    sendResponse(result);
    return true;
  }
  if (message?.type === 'APPLY_SITE_RULE') {
    resetAutoFillSession();
    const rule = normalizeStoredRule(window.location.hostname, message.payload || {});
    updateCachedRule(window.location.hostname, rule);
    const outcome = tryAutoFill(rule, { manual: true });
    if (!outcome.success && !autofillStopped && autofillAttemptCount < MAX_AUTOFILL_ATTEMPTS) {
      scheduleSecondAttempt();
      setupMutationObserver();
    }
    sendResponse(outcome);
    return true;
  }
  if (message?.type === 'INVALIDATE_RULE_CACHE') {
    resetAutoFillSession();
    invalidateRuleCache();
    beginAutoFillForCurrentPage();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

browserApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.sites) {
    return;
  }

  const hostname = window.location.hostname.toLowerCase().trim();
  const sites = changes.sites.newValue || {};
  const rule = normalizeStoredRule(hostname, sites[hostname] || null);

  if (!rule) {
    invalidateRuleCache();
    resetAutoFillSession();
    stopAutoFill();
    return;
  }

  updateCachedRule(hostname, rule);
  resetAutoFillSession();
  beginAutoFillForCurrentPage();
});

function bootAutoFill() {
  lastAutoFillLocation = getLocationKey();
  installNavigationListeners();
  cachedHostname = window.location.hostname.toLowerCase().trim();
  cachedRulePromise = loadRuleFromStorage(cachedHostname).then((rule) => {
    cachedRule = rule;
    return rule;
  });

  const start = () => beginAutoFillForCurrentPage();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

bootAutoFill();
