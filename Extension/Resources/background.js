const browserApi = globalThis.browser || globalThis.chrome;
const STORAGE_KEY = 'sites';
const STORAGE_KEYS = [STORAGE_KEY];
const ICON_ACTIVE = 'images/toolbar-icon-active.svg';
const ICON_INACTIVE = 'images/toolbar-icon-inactive.svg';
function getStorage() {
  return browserApi.storage.local;
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
    autoFill: false,
    autoSubmit: false,
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
          position: String(field?.position || '')
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
    loginPagePath: normalizeLoginPagePath(rule.loginPagePath)
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

  const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id || null;
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

async function updateToolbarIconForTab(tab) {
  if (!tab?.id) {
    return;
  }

  const hostname = tryGetHostname(tab.url);
  const active = await hostnameHasSavedRule(hostname);
  const path = active ? ICON_ACTIVE : ICON_INACTIVE;

  try {
    await browserApi.action.setIcon({ tabId: tab.id, path });
  } catch (_error) {
    try {
      await browserApi.action.setIcon({ path });
    } catch (_fallbackError) {
      // Safari may not support setIcon in all builds.
    }
  }
}

async function refreshToolbarIcons(hostnames) {
  let tabs = [];

  try {
    tabs = await browserApi.tabs.query({});
  } catch (_error) {
    tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  }

  const hostnameFilter = Array.isArray(hostnames) && hostnames.length
    ? new Set(hostnames.map((hostname) => normalizeHostname(hostname)))
    : null;

  for (const tab of tabs) {
    if (hostnameFilter) {
      const tabHostname = tryGetHostname(tab.url);
      if (!hostnameFilter.has(tabHostname)) {
        continue;
      }
    }

    await updateToolbarIconForTab(tab);
  }
}

browserApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = async () => {
    switch (message?.type) {
      case 'SAVE_SITE_RULE': {
        const hostname = normalizeHostname(message.hostname || '');
        if (!hostname) {
          return { ok: false, message: 'No hostname provided.' };
        }
        const saved = await saveSite(hostname, {
          fields: sanitizeFields(message.fields),
          loginPagePath: normalizeLoginPagePath(message.loginPagePath),
          autoFill: Boolean(message.autoFill),
          autoSubmit: Boolean(message.autoSubmit)
        });

        await refreshToolbarIcons([hostname]);

        const tabId = message.tabId || sender.tab?.id || null;
        if (tabId && saved?.autoFill) {
          try {
            await browserApi.tabs.sendMessage(tabId, {
              type: 'APPLY_SITE_RULE',
              payload: saved
            });
          } catch (_error) {
            // Content script may not be injected on this tab yet.
          }
        }

        return { ok: true, message: 'Saved site rule.', rule: saved };
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
        return { ok: true, rule };
      }
      case 'GET_ALL_SITE_RULES': {
        const rules = await getAllSiteRules();
        return { ok: true, rules };
      }
      case 'DELETE_SITE_RULE': {
        const hostname = normalizeHostname(message.hostname || '');
        if (!hostname) {
          return { ok: false, message: 'No hostname provided.' };
        }
        const deletionResult = await deleteSite(hostname);
        await refreshToolbarIcons([hostname]);
        return {
          ...deletionResult,
          message: deletionResult.verified ? 'Deleted site rule.' : 'Could not verify deletion.'
        };
      }
      case 'CLEAR_ALL_SITE_RULES': {
        const clearResult = await clearAllSites();
        await refreshToolbarIcons();
        return {
          ...clearResult,
          message: clearResult.verified ? 'Cleared all site rules.' : 'Could not verify clearing site rules.'
        };
      }
      case 'RESET_EXTENSION_DATA': {
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

browserApi.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.sites) {
    return;
  }

  const oldSites = changes.sites.oldValue || {};
  const newSites = changes.sites.newValue || {};
  const affectedHostnames = new Set([
    ...Object.keys(oldSites),
    ...Object.keys(newSites)
  ]);

  refreshToolbarIcons([...affectedHostnames]);
});

browserApi.tabs.onActivated.addListener(async ({ tabId }) => {
  const tabs = await browserApi.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]) {
    await updateToolbarIconForTab(tabs[0]);
  }
});

browserApi.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    await updateToolbarIconForTab(tab);
  }
});

refreshToolbarIcons();
