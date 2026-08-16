/**
 * Browser Video Player — service worker (MV3).
 * Receives the hand-off payload from the content script, stores it in
 * session storage, and opens the player tab. Also clears stale payloads
 * if the opener tab navigates away or is closed before consumption.
 */
'use strict';

const PLAYER_URL = chrome.runtime.getURL('player/player.html');
const PENDING_KEY = 'bvp:pending';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'bvp:open-player') {
    const payload = msg.payload || {};
    payload.openedAt = Date.now();
    payload.openerTabId = sender.tab ? sender.tab.id : null;

    chrome.storage.session.set({ [PENDING_KEY]: payload }, () => {
      const opts = { url: PLAYER_URL };
      if (payload.openerTabId != null) opts.openerTabId = payload.openerTabId;
      chrome.tabs.create(opts, (newTab) => {
        void chrome.runtime.lastError;
        if (newTab && newTab.id && payload.pageUrl) {
          applyHeaderRules(newTab.id, payload.pageUrl);
        }
        sendResponse({ ok: true });
      });
    });
    return true; // async response
  }
});

chrome.tabs.onRemoved.addListener((tabId) => clearIfStale(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') clearIfStale(tabId);
});

chrome.runtime.onInstalled.addListener(() => setupDynamicDnrRules());
chrome.runtime.onStartup.addListener(() => setupDynamicDnrRules());
setupDynamicDnrRules();

function setupDynamicDnrRules() {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateDynamicRules) return;
  const rules = [
    {
      id: 1,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' }
        ]
      },
      condition: {
        urlFilter: '*://*.youtube.com/embed/*',
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'media', 'other']
      }
    },
    {
      id: 2,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://www.youtube-nocookie.com/' },
          { header: 'Origin', operation: 'set', value: 'https://www.youtube-nocookie.com' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' }
        ]
      },
      condition: {
        urlFilter: '*://*.youtube-nocookie.com/embed/*',
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'media', 'other']
      }
    }
  ];

  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: rules
  }).catch(() => {});
}

function clearIfStale(tabId) {
  chrome.storage.session.get(PENDING_KEY, (data) => {
    const pending = data[PENDING_KEY];
    if (pending && pending.openerTabId === tabId) {
      chrome.storage.session.remove(PENDING_KEY);
    }
  });
  removeHeaderRules(tabId);
}

function applyHeaderRules(tabId, pageUrl) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  try {
    let refererUrl = pageUrl;
    let originUrl = 'https://www.youtube.com';
    try {
      const u = new URL(pageUrl);
      originUrl = u.origin;
    } catch (_) {}

    if (!refererUrl || refererUrl.startsWith('chrome-extension:')) {
      refererUrl = 'https://www.youtube.com/';
    }

    const ruleId = (tabId % 10000) + 100;
    const rule = {
      id: ruleId,
      priority: 5,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: refererUrl },
          { header: 'Origin', operation: 'set', value: originUrl },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' }
        ]
      },
      condition: {
        tabIds: [tabId],
        resourceTypes: ['sub_frame', 'xmlhttprequest', 'media', 'other']
      }
    };
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule]
    }).catch(() => {});
  } catch (_) {}
}

function removeHeaderRules(tabId) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  try {
    const ruleId = (tabId % 10000) + 100;
    chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    }).catch(() => {});
  } catch (_) {}
}
