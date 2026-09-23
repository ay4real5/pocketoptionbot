const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Policy = require('./extension/policy.js');
const ScreenAnalysis = require('./static/screen_analysis.js');
const flush = () => new Promise(resolve => setImmediate(resolve));

function event() {
    const callbacks = [];
    return { addListener(callback) { callbacks.push(callback); }, emit(...args) { callbacks.forEach(callback => callback(...args)); } };
}
async function panel({ delayCapture = false, responseStatus = 200, approveConnect = false, layoutProbe = null } = {}) {
    const elements = new Map(), dispatched = [], requests = [], captures = [];
    const tab = { id: 7, windowId: 2, active: true, status: 'complete', url: 'https://pocketoption.com/en/cabinet/demo-quick-high-low/' };
    const windowInfo = { focused: true };
    const state = { target: { id: 7, windowId: 2, origin: 'https://pocketoption.com', selectedAt: 1 },
        backendAuth: { token: 'test-session-token', expiresAt: Date.now() + 100000 } };
    const $ = id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', disabled: false, events: {}, addEventListener(name, callback) { this.events[name] = callback; } });
        return elements.get(id);
    };
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    let resumeCapture;
    const chrome = {
        runtime: { id: 'a'.repeat(32) },
        storage: { onChanged: event(), session: {
            async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map(item => [item, state[item]])); },
            async set(values) { for (const [key, value] of Object.entries(values)) { state[key] = value; chrome.storage.onChanged.emit({ [key]: { newValue: value } }, 'session'); } },
            async remove(key) { delete state[key]; chrome.storage.onChanged.emit({ [key]: {} }, 'session'); }
        }, local: {
            async get(key) { return { [key]: state[key] }; },
            async set(values) { Object.assign(state, values); },
            async remove(key) { delete state[key]; chrome.storage.onChanged.emit({ [key]: {} }, 'local'); },
            async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); }
        } },
        tabs: { get: async () => tab, async create(value) { state.openedApproval = value.url; }, async update(id) { assert.equal(id, 7); }, onActivated: event(), onUpdated: event(), onRemoved: event() },
        windows: { get: async () => windowInfo, onFocusChanged: event() },
        tabCapture: { async getMediaStreamId(options) { captures.push(options); return 'test-stream-id'; } }
    };
    const document = { hidden: false, events: {}, getElementById: $, addEventListener(name, callback) { this.events[name] = callback; } };
    const window = { events: {}, addEventListener(name, callback) { this.events[name] = callback; }, dispatchEvent(value) { dispatched.push(value.type); } };
    const context = { ChartExtensionPolicy: Policy, chrome, document, window, URL, Headers, Event, DOMException, Date,
        crypto: require('node:crypto').webcrypto, TextEncoder, Uint8Array, AbortController, setTimeout, clearTimeout, setInterval() {},
        navigator: { mediaDevices: { async getUserMedia(options) {
            assert.equal(options.audio, false);
            assert.equal(options.video.mandatory.chromeMediaSourceId, 'test-stream-id');
            if (delayCapture) return new Promise(resolve => { resumeCapture = () => resolve(stream); });
            return stream;
        } } },
        fetch: async (url, options) => { requests.push({ url, options }); return { ok: responseStatus === 200, status: responseStatus,
            json: async () => approveConnect && url.endsWith('/claim') ? { access_token: 'new-test-token', expires_in: 2592000 } : {} }; }
    };
    if (layoutProbe) {
        context.ChartProbe = require('./extension/chart_probe.js');
        chrome.scripting = { async executeScript(options) {
            assert.equal(options.target.tabId, 7);
            assert.equal(options.func, context.ChartProbe.inspectVisibleChart);
            return [{ frameId: 0, result: layoutProbe }];
        } };
    }
    vm.runInNewContext(fs.readFileSync('./extension/bridge.js', 'utf8'), context);
    await flush();
    return { $, chrome, document, window, state, tab, windowInfo, track, captures, dispatched, requests,
        bridge: window.ChartBridge, resumeCapture: () => resumeCapture() };
}

test('manifest uses explicit capture permissions, localhost only, and no injected or remote scripts', () => {
    const manifest = JSON.parse(fs.readFileSync('./extension/manifest.json', 'utf8'));
    assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'sidePanel', 'storage', 'tabCapture', 'scripting'].sort());
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.externally_connectable, undefined);
    assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
});

test('capture policy accepts only HTTPS Pocket Option hosts and exact selected active tab', () => {
    for (const url of ['https://pocketoption.com/chart', 'https://m.pocketoption.com/chart']) assert.ok(Policy.allowed(url));
    for (const url of ['https://pocketoption.com.evil.example', 'https://evilpocketoption.com', 'http://pocketoption.com',
        'https://pocketoption.com:8080', 'https://user:password@pocketoption.com', 'chrome://extensions', 'file:///private']) assert.ok(!Policy.allowed(url));
    assert.ok(!Policy.matches({ id: 1, windowId: 1, origin: 'https://pocketoption.com' }, { id: 2, windowId: 1, active: true, status: 'complete', url: 'https://pocketoption.com' }));
});

test('side-panel-sized crop preserves bounded preview and still rejects mobile-sized charts', () => {
    const crop = ScreenAnalysis.cloudCrop(680, 600, false, true);
    assert.ok(crop && crop.x + crop.width <= 680 && crop.y + crop.height <= 600);
    assert.equal(ScreenAnalysis.cloudCrop(500, 600, false, true), null);
});

test('capture is bound to selected tab and starting it does not cancel the shared controller', async () => {
    const env = await panel();
    await env.bridge.capture();
    assert.equal(env.captures.length, 1);
    assert.equal(env.captures[0].targetTabId, 7);
    assert.equal(env.dispatched.includes('chart-capture-ended'), false);
    assert.equal(env.track.readyState, 'live');
});

test('layout inspection is limited to the selected tab and returns local geometry without a network upload', async () => {
    const probe = { source: 'visible-chart-dom', viewport: { width: 1024, height: 600 },
        bounds: { x: 80, y: 60, width: 700, height: 500 }, labels: ['Aroon'], candleOpen: null };
    const env = await panel({ layoutProbe: probe });
    await env.bridge.capture();
    assert.equal(env.bridge.layout().source, 'visible-chart-dom');
    assert.ok(Number.isFinite(env.bridge.layout().seenAt));
    assert.equal(env.requests.length, 0);
});

test('extension transport uses only localhost and session token, never the local page token', async () => {
    const env = await panel(); await env.bridge.capture();
    await env.bridge.request('/api/vision/analyze', { method: 'POST', headers: { 'X-Vision-Token': 'must-not-send' }, body: '{}' });
    const request = env.requests[0];
    assert.equal(request.url, 'http://127.0.0.1:5000/api/extension/analyze');
    assert.equal(request.options.headers.get('X-Vision-Token'), null);
    assert.equal(request.options.headers.get('X-Extension-Token'), 'test-session-token');
    assert.equal(request.options.redirect, 'error');
    await assert.rejects(env.bridge.request('https://evil.example'));
    assert.equal(env.requests.length, 1);
});

test('no image request is permitted without live authorized capture', async () => {
    const env = await panel();
    await assert.rejects(env.bridge.request('/api/vision/analyze', { method: 'POST' }));
    assert.equal(env.requests.length, 0);
    env.tab.url = 'https://evil.example';
    await assert.rejects(env.bridge.capture());
    assert.equal(env.captures.length, 0);
});

test('navigation and closing the selected tab still stop capture', async () => {
    const triggers = [
        env => env.chrome.tabs.onUpdated.emit(7, { status: 'loading' }),
        env => env.chrome.tabs.onRemoved.emit(7)
    ];
    for (const trigger of triggers) {
        const env = await panel(); await env.bridge.capture(); trigger(env);
        assert.equal(env.track.readyState, 'ended');
        assert.ok(env.dispatched.includes('chart-capture-ended'));
        await assert.rejects(env.bridge.request('/api/vision/analyze', { method: 'POST' }));
        assert.equal(env.requests.length, 0);
    }
});

test('minimizing and switching focus keep monitoring the originally selected tab', async () => {
    const env = await panel(); await env.bridge.capture();
    env.windowInfo.focused = false; env.document.hidden = true; env.tab.active = false;
    env.chrome.windows.onFocusChanged.emit(-1);
    env.document.events.visibilitychange?.();
    env.chrome.tabs.onActivated.emit({ tabId: 8, windowId: 2 });
    assert.equal(env.track.readyState, 'live');
    assert.ok(!env.dispatched.includes('chart-capture-ended'));
    await env.bridge.request('/api/vision/analyze', { method: 'POST', body: '{}' });
    assert.equal(env.requests.length, 1);
    assert.equal(env.captures[0].targetTabId, 7);
});

test('initial capture still requires the explicitly selected foreground chart', async () => {
    const env = await panel(); env.tab.active = false;
    await assert.rejects(env.bridge.capture());
    assert.equal(env.captures.length, 0);
});

test('navigation during capture setup discards the late stream', async () => {
    const env = await panel({ delayCapture: true });
    const capture = env.bridge.capture(); await flush();
    env.tab.url = 'https://evil.example'; env.resumeCapture();
    await assert.rejects(capture);
    assert.equal(env.track.readyState, 'ended');
    assert.equal(env.requests.length, 0);
});

test('revoked backend authorization stops capture and removes the session token', async () => {
    const env = await panel({ responseStatus: 403 }); await env.bridge.capture();
    await env.bridge.request('/api/vision/status');
    assert.equal(env.state.backendAuth, undefined);
    assert.equal(env.track.readyState, 'ended');
    assert.equal(env.bridge.state().connection, 'needs-approval');
});

test('connection handoff transfers a private challenge without putting it in URLs or asking for an API key', async () => {
    const env = await panel({ approveConnect: true });
    await env.bridge.connect();
    const claim = env.requests.find(item => item.url.endsWith('/claim'));
    const secret = JSON.parse(claim.options.body).secret;
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.ok(!env.state.openedApproval.includes(secret));
    assert.ok(env.state.openedApproval.includes('request='));
    assert.equal(env.state.backendAuth.token, 'new-test-token');
    assert.equal(env.state.pendingConnection, undefined);
    assert.equal(env.bridge.state().connection, 'connected');
    assert.ok(env.dispatched.includes('chart-backend-connected'));
});

test('status uses an authenticated POST so browser origin checks are consistent', async () => {
    const env = await panel();
    await env.bridge.request('/api/vision/status');
    assert.equal(env.requests[0].options.method, 'POST');
    assert.equal(env.requests[0].options.headers.get('Content-Type'), 'application/json');
    assert.equal(env.requests[0].options.body, '{}');
});

test('toolbar action selects only Pocket Option tabs and navigation revokes selection', async () => {
    const state = {}, opened = [];
    const chrome = {
        action: { onClicked: event() }, sidePanel: { open: async value => { opened.push(value); } },
        storage: { session: { async set(value) { Object.assign(state, value); }, async get() { return state; }, async remove(key) { delete state[key]; } } },
        tabs: { onUpdated: event(), onRemoved: event() }
    };
    vm.runInNewContext(fs.readFileSync('./extension/worker.js', 'utf8'), { chrome, importScripts() {}, ChartExtensionPolicy: Policy, Date, URL });
    chrome.action.onClicked.emit({ id: 7, windowId: 2, status: 'complete', url: 'https://pocketoption.com/chart' });
    await flush();
    assert.equal(state.target.id, 7);
    assert.equal(opened[0].windowId, 2);
    chrome.tabs.onUpdated.emit(7, { status: 'loading' }); await flush();
    assert.equal(state.target, undefined);
    chrome.action.onClicked.emit({ id: 8, windowId: 2, status: 'complete', url: 'https://evil.example' }); await flush();
    assert.equal(state.target, null);
});

test('build contains every shared controller element and only packaged script references', () => {
    const html = fs.readFileSync('./extension_dist/panel.html', 'utf8');
    const controller = fs.readFileSync('./static/screen_capture.js', 'utf8');
    for (const match of controller.matchAll(/\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="${match[1]}"`), match[1]);
    assert.ok(html.includes('name="vision-token" content=""'));
    assert.ok(html.includes('src="bridge.js"'));
    assert.equal(html.includes('{{'), false);
    assert.equal(/<script[^>]*src="https?:/.test(html), false);
    assert.equal(fs.readFileSync('./extension_dist/screen_capture.js', 'utf8'), controller);
});
