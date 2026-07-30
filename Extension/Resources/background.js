const browserApi = globalThis.browser || globalThis.chrome;
const actionApi = browserApi.action || browserApi.browserAction;
const STORAGE_KEY = 'sites';
const SCHEMA_VERSION_KEY = 'schemaVersion';
const CURRENT_SCHEMA_VERSION = 2;
const STORAGE_KEYS = [STORAGE_KEY, SCHEMA_VERSION_KEY];
const NATIVE_APP_ID = 'Sharbel.AutoLogin.Extension';
const ICON_ACTIVE = {
  18: 'images/toolbar-icon-18.png',
  36: 'images/toolbar-icon-36.png',
  48: 'images/toolbar-icon-48.png'
};
const ICON_INACTIVE = {
  18: 'images/toolbar-icon-inactive-18.png',
  36: 'images/toolbar-icon-inactive-36.png',
  48: 'images/toolbar-icon-inactive-48.png'
};
function getStorage() {
  return browserApi.storage.local;
}

// --- Keychain bridge (secrets live in the macOS Keychain via the native
// extension handler; extension storage only holds opaque secretRef ids) ---

async function nativeRequest(payload) {
  if (typeof browserApi.runtime?.sendNativeMessage !== 'function') {
    return null;
  }

  try {
    const response = await browserApi.runtime.sendNativeMessage(NATIVE_APP_ID, payload);
    return response?.ok ? response : null;
  } catch (_error) {
    return null;
  }
}

function makeSecretRef() {
  return globalThis.crypto?.randomUUID?.() || `ref-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function storeSecret(secretRef, value) {
  return Boolean(await nativeRequest({ action: 'set-secret', id: secretRef, value }));
}

async function resolveSecrets(secretRefs) {
  if (!secretRefs.length) {
    return {};
  }

  const response = await nativeRequest({ action: 'get-secrets', ids: secretRefs });
  return response?.values || {};
}

async function deleteSecretsByRefs(secretRefs) {
  if (secretRefs.length) {
    await nativeRequest({ action: 'delete-secrets', ids: secretRefs });
  }
}

async function deleteAllSecrets() {
  await nativeRequest({ action: 'delete-all-secrets' });
}

function collectSecretRefs(rule) {
  return (rule?.fields || []).map((field) => field?.secretRef).filter(Boolean);
}

async function protectSecretFields(fields, previousFields) {
  const previousRefs = new Map(
    (previousFields || [])
      .filter((field) => field?.secretRef)
      .map((field) => [field.id, field.secretRef])
  );

  const protectedFields = [];
  for (const field of fields) {
    if (field.type !== 'password') {
      protectedFields.push({ ...field, secretRef: '' });
      continue;
    }

    if (!field.value) {
      // No new value entered: keep whatever secret this field already had.
      protectedFields.push({ ...field, secretRef: field.secretRef || previousRefs.get(field.id) || '' });
      continue;
    }

    const secretRef = field.secretRef || previousRefs.get(field.id) || makeSecretRef();
    if (await storeSecret(secretRef, field.value)) {
      protectedFields.push({ ...field, value: '', secretRef });
    } else {
      // Keychain unavailable: fall back to plain extension storage.
      protectedFields.push({ ...field, secretRef: '' });
    }
  }

  return protectedFields;
}

async function resolveRuleSecretsForUi(rule) {
  const pending = (rule?.fields || []).filter((field) => field.secretRef && !field.value);
  if (!pending.length) {
    return rule;
  }

  const values = await resolveSecrets(pending.map((field) => field.secretRef));
  return {
    ...rule,
    fields: rule.fields.map((field) =>
      field.secretRef && !field.value ? { ...field, value: values[field.secretRef] || '' } : field
    )
  };
}

async function migrateStoredData() {
  try {
    const storage = getStorage();
    const data = await storage.get(STORAGE_KEYS);
    const sites = data[STORAGE_KEY] || {};
    let changed = false;
    let plaintextRemains = false;

    for (const rule of Object.values(sites)) {
      const fields = Array.isArray(rule?.fields) ? rule.fields : [];
      for (const field of fields) {
        if (field?.type !== 'password' || !field.value) {
          continue;
        }

        const secretRef = field.secretRef || makeSecretRef();
        if (await storeSecret(secretRef, field.value)) {
          field.secretRef = secretRef;
          field.value = '';
          changed = true;
        } else {
          plaintextRemains = true;
        }
      }
    }

    if (changed) {
      await storage.set({ [STORAGE_KEY]: sites });
    }

    // Only stamp the schema version once every password made it into the
    // Keychain, so a failed native connection is retried on the next launch.
    if (!plaintextRemains && data[SCHEMA_VERSION_KEY] !== CURRENT_SCHEMA_VERSION) {
      await storage.set({ [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION });
    }
  } catch (error) {
    console.error('AutoLogin migration error', error);
  }
}

function isTrustedUiSender(sender) {
  if (!sender) {
    return false;
  }

  if (sender.url) {
    const base = browserApi.runtime.getURL('');
    return Boolean(base) && sender.url.startsWith(base);
  }

  return !sender.tab;
}

function normalizeHostname(hostname) {
  return (hostname || '').toLowerCase().trim();
}

function getDefaultSiteRule(hostname) {
  return {
    fields: [
      { id: 'username', label: 'Username or email', value: '', type: 'text' },
      { id: 'password', label: 'Password', value: '', type: 'password' }
    ],
    loginPagePath: '',
    autoFill: true,
    autoSubmit: true,
    updatedAt: new Date().toISOString()
  };
}

function normalizeLoginPagePath(path) {
  return String(path || '').trim();
}

function sanitizeFields(fields) {
  const safeFields = Array.isArray(fields)
    ? fields
        .map((field, index) => ({
          id: field?.id || `field-${index + 1}`,
          label: (field?.label || `Field ${index + 1}`).trim(),
          value: String(field?.value || ''),
          type: field?.type === 'password' ? 'password' : 'text',
          meaning: String(field?.meaning || (field?.type === 'password' ? 'password' : `text-${index + 1}`)),
          position: String(field?.position || ''),
          secretRef: typeof field?.secretRef === 'string' ? field.secretRef : ''
        }))
        .filter((field) => field.label)
    : [];

  if (safeFields.length) {
    return safeFields;
  }

  return getDefaultSiteRule('').fields;
}

function normalizeSiteRule(hostname, rule) {
  if (!rule) {
    return null;
  }

  const fallback = getDefaultSiteRule(hostname);
  const fields = sanitizeFields(
    rule.fields ||
      [
        { id: 'username', label: 'Username or email', value: rule.username || '', type: 'text' },
        { id: 'password', label: 'Password', value: rule.password || '', type: 'password' }
      ]
  );

  return {
    ...fallback,
    ...rule,
    hostname,
    fields,
    loginPagePath: normalizeLoginPagePath(rule.loginPagePath),
    // Auto-fill and auto-submit are built-in behavior, not user settings;
    // older stored rules may still carry false here.
    autoFill: true,
    autoSubmit: true
  };
}

async function getSites() {
  const storage = getStorage();
  const result = await storage.get(STORAGE_KEY);
  const rawSites = result[STORAGE_KEY] || {};
  const sites = {};

  Object.entries(rawSites).forEach(([hostname, rule]) => {
    const normalized = normalizeSiteRule(hostname, rule);
    if (normalized) {
      sites[hostname] = normalized;
    }
  });

  return sites;
}

async function getRawSites() {
  const storage = getStorage();
  const result = await storage.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

async function writeSites(sites) {
  const storage = getStorage();
  if (!sites || Object.keys(sites).length === 0) {
    await storage.remove(STORAGE_KEY);
    return {};
  }

  await storage.set({ [STORAGE_KEY]: sites });
  return getSites();
}

async function getSite(hostname) {
  const rawSites = await getRawSites();
  return normalizeSiteRule(hostname, rawSites[hostname]);
}

async function saveSite(hostname, payload) {
  const rawSites = await getRawSites();
  const normalized = normalizeSiteRule(hostname, {
    ...payload,
    updatedAt: new Date().toISOString()
  });
  rawSites[hostname] = normalized;
  const verifiedSites = await writeSites(rawSites);
  return verifiedSites[hostname] || null;
}

async function deleteSite(hostname) {
  const rawSites = await getRawSites();
  await deleteSecretsByRefs(collectSecretRefs(rawSites[hostname]));
  delete rawSites[hostname];
  const verifiedSites = await writeSites(rawSites);
  return {
    ok: true,
    deletedHostname: hostname,
    verified: !Object.prototype.hasOwnProperty.call(verifiedSites, hostname),
    remainingHostnames: Object.keys(verifiedSites),
    remainingCount: Object.keys(verifiedSites).length
  };
}

async function clearAllSites() {
  await deleteAllSecrets();
  await writeSites({});
  const verifiedSites = await getSites();
  return {
    ok: true,
    verified: Object.keys(verifiedSites).length === 0,
    remainingHostnames: [],
    remainingCount: 0
  };
}

async function clearExtensionData() {
  await deleteAllSecrets();
  const storage = getStorage();
  await storage.remove(STORAGE_KEYS);
  const after = await storage.get(null);
  const remainingKeys = Object.keys(after);
  return {
    ok: true,
    verified: STORAGE_KEYS.every((key) => !(key in after)),
    remainingKeys
  };
}

async function getSiteRule(hostname) {
  return getSite(hostname);
}

async function getAllSiteRules() {
  return getSites();
}

async function resolveTabId(message, sender) {
  if (message?.tabId) {
    return message.tabId;
  }

  if (sender.tab?.id) {
    return sender.tab.id;
  }

  return null;
}

function tryGetHostname(url) {
  if (!url || !/^https?:/i.test(url)) {
    return '';
  }

  try {
    return normalizeHostname(new URL(url).hostname);
  } catch (_error) {
    return '';
  }
}

async function hostnameHasSavedRule(hostname) {
  if (!hostname) {
    return false;
  }

  const rawSites = await getRawSites();
  return Object.prototype.hasOwnProperty.call(rawSites, hostname);
}

async function updateToolbarIconForTab(tab, hostnameHint) {
  if (!tab?.id || !actionApi?.setIcon) {
    return;
  }

  const hostname = hostnameHint || tryGetHostname(tab.url);
  const active = await hostnameHasSavedRule(hostname);
  const path = active ? ICON_ACTIVE : ICON_INACTIVE;

  try {
    await actionApi.setIcon({ tabId: tab.id, path });
  } catch (_error) {
    // Per-tab icons are optional; keep the manifest default icon instead.
  }
}

browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message?.type) {
      case 'SAVE_SITE_RULE': {
        if (!isTrustedUiSender(sender)) {
          return { ok: false, message: 'Not allowed.' };
        }
        const hostname = normalizeHostname(message.hostname || '');
        if (!hostname) {
          return { ok: false, message: 'No hostname provided.' };
        }

        const plainFields = sanitizeFields(message.fields);
        const previousRule = (await getRawSites())[hostname];
        const saved = await saveSite(hostname, {
          fields: await protectSecretFields(plainFields, previousRule?.fields),
          loginPagePath: normalizeLoginPagePath(message.loginPagePath),
          autoFill: true,
          autoSubmit: true
        });

        await updateToolbarIconForTab(
          message.tabId ? { id: message.tabId } : sender.tab,
          hostname
        );

        const tabId = message.tabId || sender.tab?.id || null;
        if (tabId && saved) {
          try {
            await browserApi.tabs.sendMessage(tabId, {
              type: 'APPLY_SITE_RULE',
              // Send the plaintext values for the immediate fill; storage only
              // keeps the Keychain references.
              payload: { ...saved, fields: plainFields }
            });
          } catch (_error) {
            // Content script may not be injected on this tab yet.
          }
        }

        return { ok: true, message: 'Saved site rule.', rule: saved };
      }
      case 'REFRESH_TOOLBAR_ICON': {
        const tabId = message.tabId || sender.tab?.id || null;
        if (!tabId) {
          return { ok: false, message: 'No tab to update.' };
        }

        const hostname = normalizeHostname(message.hostname || '') || tryGetHostname(sender.tab?.url);
        await updateToolbarIconForTab({ id: tabId, url: sender.tab?.url || '' }, hostname);
        return { ok: true };
      }
      case 'RESOLVE_SECRETS': {
        const requestedRefs = Array.isArray(message.refs)
          ? message.refs.filter((ref) => typeof ref === 'string' && ref)
          : [];

        let allowedRefs = requestedRefs;
        if (!isTrustedUiSender(sender)) {
          // Content scripts only get the secrets saved for their own hostname.
          const senderHostname = tryGetHostname(sender.tab?.url || sender.url || '');
          if (!senderHostname) {
            return { ok: false, values: {} };
          }

          const rawSites = await getRawSites();
          const ruleRefs = new Set(collectSecretRefs(rawSites[senderHostname]));
          allowedRefs = requestedRefs.filter((ref) => ruleRefs.has(ref));
        }

        const values = await resolveSecrets(allowedRefs);
        return { ok: true, values };
      }
      case 'FILL_NOW': {
        const tabId = await resolveTabId(message, sender);
        if (!tabId) {
          return { ok: false, message: 'No active tab.' };
        }
        return browserApi.tabs.sendMessage(tabId, { type: 'FILL_NOW', payload: message.payload });
      }
      case 'INVALIDATE_RULE_CACHE': {
        const tabId = await resolveTabId(message, sender);
        if (!tabId) {
          return { ok: false, message: 'No active tab.' };
        }
        return browserApi.tabs.sendMessage(tabId, { type: 'INVALIDATE_RULE_CACHE' });
      }
      case 'DETECT_LOGIN_FIELDS': {
        const tabId = await resolveTabId(message, sender);
        if (!tabId) {
          return { ok: false, message: 'No active tab.' };
        }
        return browserApi.tabs.sendMessage(tabId, { type: 'DETECT_LOGIN_FIELDS' });
      }
      case 'GET_SITE_RULE': {
        const hostname = normalizeHostname(message.hostname || '');
        const rule = await getSiteRule(hostname);
        // Only the extension's own pages get secrets resolved for editing.
        const resolved = rule && isTrustedUiSender(sender) ? await resolveRuleSecretsForUi(rule) : rule;
        return { ok: true, rule: resolved };
      }
      case 'GET_ALL_SITE_RULES': {
        const rules = await getAllSiteRules();
        return { ok: true, rules };
      }
      case 'DELETE_SITE_RULE': {
        if (!isTrustedUiSender(sender)) {
          return { ok: false, message: 'Not allowed.' };
        }
        const hostname = normalizeHostname(message.hostname || '');
        if (!hostname) {
          return { ok: false, message: 'No hostname provided.' };
        }
        const deletionResult = await deleteSite(hostname);
        return {
          ...deletionResult,
          message: deletionResult.verified ? 'Deleted site rule.' : 'Could not verify deletion.'
        };
      }
      case 'CLEAR_ALL_SITE_RULES': {
        if (!isTrustedUiSender(sender)) {
          return { ok: false, message: 'Not allowed.' };
        }
        const clearResult = await clearAllSites();
        return {
          ...clearResult,
          message: clearResult.verified ? 'Cleared all site rules.' : 'Could not verify clearing site rules.'
        };
      }
      case 'RESET_EXTENSION_DATA': {
        if (!isTrustedUiSender(sender)) {
          return { ok: false, message: 'Not allowed.' };
        }
        const resetResult = await clearExtensionData();
        return {
          ...resetResult,
          message: resetResult.verified ? 'Reset extension data.' : 'Could not verify extension data reset.'
        };
      }
      default:
        return { ok: false, message: 'Unknown action.' };
    }
  };

  handler().then((result) => sendResponse(result)).catch((error) => {
    console.error('AutoLogin background error', error);
    sendResponse({ ok: false, message: 'Background error.', error: String(error) });
  });

  return true;
});

if (browserApi.tabs?.onActivated) {
  browserApi.tabs.onActivated.addListener(async ({ tabId }) => {
    try {
      const tab = await browserApi.tabs.get(tabId);
      await updateToolbarIconForTab(tab);
    } catch (_error) {
      // The tab may already be gone or inaccessible.
    }
  });
}

if (browserApi.tabs?.onUpdated) {
  browserApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      updateToolbarIconForTab(tab);
    }
  });
}

migrateStoredData();
