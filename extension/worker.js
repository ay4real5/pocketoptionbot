'use strict';
importScripts('policy.js');

const alertExpiries = new Map();
if (chrome.runtime?.onMessage) chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html') || message?.type !== 'armAlertExpiry') return false;
    const delay = message.expiresAt - Date.now();
    if (typeof message.id !== 'string' || !/^chart-cue-[a-zA-Z0-9-]{1,64}$/.test(message.id) ||
        !Number.isFinite(message.expiresAt) || delay <= 0 || delay > 20000 || alertExpiries.size >= 64) {
        reply({ ok: false }); return false;
    }
    if (alertExpiries.has(message.id)) clearTimeout(alertExpiries.get(message.id));
    const timer = setTimeout(() => {
        chrome.notifications?.clear(message.id).catch(() => {});
        alertExpiries.delete(message.id);
    }, delay);
    alertExpiries.set(message.id, timer);
    reply({ ok: true }); return false;
});

chrome.action.onClicked.addListener(tab => {
    const opening = chrome.sidePanel.open({ windowId: tab.windowId });
    const target = ChartExtensionPolicy.allowed(tab.url) && tab.status === 'complete' ?
        { id: tab.id, windowId: tab.windowId, origin: new URL(tab.url).origin, selectedAt: Date.now() } : null;
    chrome.storage.session.set({ target }).catch(() => {});
    opening.catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'loading' && !change.url) return;
    chrome.storage.session.get('target').then(({ target }) => {
        if (target?.id === tabId) return chrome.storage.session.remove('target');
    }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => {
    chrome.storage.session.get('target').then(({ target }) => {
        if (target?.id === tabId) return chrome.storage.session.remove('target');
    }).catch(() => {});
});
