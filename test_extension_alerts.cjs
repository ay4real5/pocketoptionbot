const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ChartAlerts = require('./static/chart_alerts.js');
const Policy = require('./extension/policy.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...args) { listeners.forEach(fn => fn(...args)); } }; };

async function fixture({ permission = true, delayedCreate = false } = {}) {
    let now = 100000, permissionRequests = 0, networkCalls = 0, nextTimer = 0, finishCreate;
    const state = {}, notifications = [], cleared = [], messages = [], timers = new Map();
    const chrome = {
        runtime: { id: 'a'.repeat(32), getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}`,
            async sendMessage(message) { messages.push(message); return { ok: true }; } },
        storage: { onChanged: event(), session: { async get() { return {}; } }, local: {
            async get(key) { return { [key]: state[key] }; }, async set(value) { Object.assign(state, value); }, async setAccessLevel() {}
        } },
        tabs: { onUpdated: event(), onRemoved: event() },
        permissions: { async contains() { return permission; }, async request() { permissionRequests++; return permission; } },
        notifications: { async getPermissionLevel() { return permission ? 'granted' : 'denied'; },
            async create(id, options) {
                notifications.push({ id, options });
                if (delayedCreate) return new Promise(resolve => { finishCreate = () => resolve(id); });
                return id;
            },
            async clear(id) { cleared.push(id); return true; }
        }
    };
    const window = { dispatchEvent() {}, addEventListener() {} };
    const context = { chrome, window, document: {}, ChartExtensionPolicy: Policy, ChartAlerts,
        URL, Headers, AbortController, DOMException, Event, TextEncoder, Uint8Array, crypto: require('node:crypto').webcrypto,
        Date: class extends Date { static now() { return now; } },
        setInterval() {}, setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); }, fetch() { networkCalls++; throw new Error('Unexpected network call'); } };
    vm.runInNewContext(fs.readFileSync('./extension/bridge.js', 'utf8'), context);
    await flush();
    return { bridge: window.ChartBridge, state, notifications, cleared, messages, timers, chrome,
        permissionRequests: () => permissionRequests, networkCalls: () => networkCalls,
        advance(ms) { now += ms; }, finishCreate: () => finishCreate() };
}
const cue = { direction: 'BUY', asset: 'EUR/USD OTC', captured_at: 99000, expires_at: 119000 };

test('notifications remain optional and are never requested on load', async () => {
    const manifest = JSON.parse(fs.readFileSync('./extension/manifest.json', 'utf8'));
    assert.deepEqual(manifest.optional_permissions, ['notifications']);
    assert.ok(!manifest.permissions.includes('notifications'));
    const env = await fixture({ permission: false });
    assert.equal(env.permissionRequests(), 0);
    assert.equal(await env.bridge.sendDesktopAlert(cue, () => true), false);
    assert.equal(await env.bridge.requestDesktopPermission(), false);
    assert.equal(env.permissionRequests(), 1);
    assert.equal(env.notifications.length, 0);
    assert.equal(env.networkCalls(), 0);
});

test('extension preferences persist only alert fields and clamp volume', async () => {
    const env = await fixture();
    await env.bridge.saveAlertPreferences({ sound: true, volume: 120, desktop: true, apiKey: 'must-not-save' });
    assert.deepEqual(await env.bridge.loadAlertPreferences(), { sound: true, desktop: true, volume: 100 });
    assert.ok(!JSON.stringify(env.state).includes('must-not-save'));
});

test('live notifications include time and expiry, are silent, and arm automatic cleanup', async () => {
    const env = await fixture();
    assert.equal(await env.bridge.sendDesktopAlert(cue, () => true), true);
    const notification = env.notifications[0];
    assert.match(notification.options.title, /BUY.*EUR\/USD OTC/);
    assert.match(notification.options.message, /stale after/);
    assert.equal(notification.options.silent, true);
    assert.equal(notification.options.requireInteraction, false);
    assert.equal(env.messages[0].expiresAt, cue.expires_at);
    assert.equal(env.messages[0].type, 'armAlertExpiry');
    env.bridge.clearDesktopAlerts();
    assert.ok(env.cleared.includes(notification.id));
    assert.equal(env.networkCalls(), 0);
});

test('WAIT, stale, future and invalidated cues never create notifications', async () => {
    const env = await fixture();
    for (const value of [{ ...cue, direction: 'WAIT' }, { ...cue, expires_at: 99999 }, { ...cue, captured_at: 101000 }]) {
        assert.equal(await env.bridge.sendDesktopAlert(value, () => true), false);
    }
    assert.equal(await env.bridge.sendDesktopAlert(cue, () => false), false);
    const pending = env.bridge.sendDesktopAlert(cue, () => true);
    env.advance(21000);
    assert.equal(await pending, false);
    assert.equal(env.notifications.length, 0);
});

test('Stop during notification creation removes the late banner and cannot revive an alert', async () => {
    const env = await fixture({ delayedCreate: true });
    const pending = env.bridge.sendDesktopAlert(cue, () => true); await flush();
    env.bridge.clearDesktopAlerts(); env.finishCreate();
    assert.equal(await pending, false);
    assert.ok(env.cleared.includes(env.notifications[0].id));
    assert.equal(env.messages.length, 0);
});

test('test notification is clearly labelled and makes no chart or AI request', async () => {
    const env = await fixture();
    assert.equal(await env.bridge.sendDesktopAlert(null, () => true, true), true);
    assert.match(env.notifications[0].options.title, /^TEST.*no trading signal/);
    assert.equal(env.messages[0].expiresAt, 104000);
    assert.equal(env.networkCalls(), 0);
});

test('worker expiry messages are restricted to the extension panel and clear banners at their deadline', () => {
    let callback;
    const cleared = [], messageEvent = event(), responses = [];
    const chrome = { runtime: { id: 'a'.repeat(32), getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}`, onMessage: messageEvent },
        action: { onClicked: event() }, tabs: { onUpdated: event(), onRemoved: event() },
        notifications: { async clear(id) { cleared.push(id); } } };
    vm.runInNewContext(fs.readFileSync('./extension/worker.js', 'utf8'), {
        chrome, importScripts() {}, ChartExtensionPolicy: Policy, Date: class extends Date { static now() { return 100000; } },
        setTimeout(fn, delay) { callback = fn; assert.equal(delay, 10000); return 1; }, clearTimeout() {}
    });
    const message = { type: 'armAlertExpiry', id: 'chart-cue-test', expiresAt: 110000 };
    messageEvent.emit(message, { id: 'evil', url: 'https://evil.example' }, value => responses.push(value));
    assert.equal(callback, undefined);
    messageEvent.emit(message, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, value => responses.push(value));
    assert.equal(responses[0].ok, true);
    callback(); assert.deepEqual(cleared, ['chart-cue-test']);
    messageEvent.emit({ ...message, expiresAt: 140000 }, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, value => responses.push(value));
    assert.equal(responses[1].ok, false);
});
