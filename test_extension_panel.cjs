const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function ui(connection = 'connected') {
    const nodes = new Map(), listeners = new Map();
    const view = { connection, message: 'Connect once.', hasTarget: true };
    const state = { configured: true, initialized: true, capturing: false, choosing: false, previewReady: false,
        previewKey: 'first-preview', running: false, pending: false, collecting: false, status: 'wait',
        timeframe: '30s', expiry: 2, hasApproval: false, hasAssessment: false, scanOutcome: 'idle',
        localIdentity: null, readiness: null, entryTiming: 'SCAN to assess the current setup.',
        nextIn: 0, elapsed: 0, signalAge: null, captureAge: 0, calls: 0, lastDuration: null,
        cooldownRemaining: 0, cooldownReason: '', pauseKind: null, pauseReason: null };
    const calls = { preview: 0, start: 0, stop: 0, connect: 0, retry: 0 };
    const $ = id => {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false, hidden: false, value: 0, dataset: {}, events: {},
            addEventListener(type, callback) { this.events[type] = callback; } });
        return nodes.get(id);
    };
    const emit = name => { for (const callback of listeners.get(name) || []) callback(); };
    const engine = {
        state: () => ({ ...state }),
        preview() { calls.preview++; state.capturing = true; state.previewReady = true; emit('chart-assistant-state'); },
        approveAndStart(key) {
            if (key !== state.previewKey || !state.previewReady) return false;
            calls.start++; state.hasApproval = true; state.collecting = true; state.running = true; emit('chart-assistant-state'); return true;
        },
        stop() { calls.stop++; state.capturing = false; state.running = false; state.pending = false; state.previewReady = false; emit('chart-assistant-state'); },
        retry() { calls.retry++; }
    };
    const window = {
        ChartAssistant: engine,
        ChartBridge: { state: () => ({ ...view }), connect() { calls.connect++; view.connection = 'approving'; emit('chart-bridge-state'); }, disconnect() {} },
        addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); }
    };
    const document = { body: { dataset: {} }, getElementById: $ };
    vm.runInNewContext(fs.readFileSync('./extension/panel.js', 'utf8'), { window, document });
    await flush();
    return { $, view, state, calls, document, emit, async click(id) { if (!$(id).disabled) $(id).events.click(); await flush(); } };
}

test('saved connection opens local preview automatically but never starts a paid scan', async () => {
    const env = await ui();
    assert.equal(env.calls.preview, 1);
    assert.equal(env.calls.start, 0);
    assert.equal(env.$('previewCard').hidden, false);
    assert.equal(env.$('mainAction').textContent, 'SCAN');
    assert.match(env.$('actionHint').textContent, /two fresh cropped frames/);
    assert.equal(env.$('connectionBadge').textContent, 'MANUAL SCAN');
    await env.click('mainAction');
    assert.equal(env.calls.start, 1);
    assert.equal(env.$('previewCard').hidden, true);
    assert.equal(env.$('mainAction').textContent, 'Scanning…');
    assert.equal(env.$('mainAction').disabled, true);
});

test('new user sees one Connect action, then approval and preview, without a code form', async () => {
    const env = await ui('needs-approval');
    assert.equal(env.$('mainAction').textContent, 'Connect & detect');
    assert.equal(env.calls.preview, 0);
    await env.click('mainAction');
    assert.equal(env.calls.connect, 1);
    assert.equal(env.$('mainAction').disabled, true);
    env.view.connection = 'connected'; env.emit('chart-backend-connected'); await flush();
    assert.equal(env.calls.preview, 1);
    assert.equal(env.calls.start, 0);
});

test('Stop ends capture and manual mode never restarts a scan on its own', async () => {
    const env = await ui(); await env.click('mainAction'); await env.click('stopAction');
    env.emit('chart-assistant-state'); await flush();
    assert.equal(env.calls.preview, 1);
    assert.equal(env.calls.stop, 1);
    assert.equal(env.calls.start, 1);
    assert.equal(env.$('mainAction').textContent, 'Preview chart');
});

test('preview consent cannot authorize a changed crop before the UI has displayed it', async () => {
    const env = await ui();
    env.state.previewKey = 'different-crop';
    await env.click('mainAction');
    assert.equal(env.calls.start, 0);
});

test('waiting for fresh frames keeps local detection alive without claiming a scan is running', async () => {
    const env = await ui();
    env.state.capturing = true; env.state.waitingForFrames = true; env.state.previewReady = false;
    env.emit('chart-assistant-state'); await flush();
    assert.equal(env.$('mainAction').textContent, 'Waiting for fresh frames');
    assert.equal(env.$('mainAction').disabled, true);
    assert.equal(env.$('stopAction').hidden, false);
});

test('API cooldown shows its cause and countdown and keeps scanning manual', async () => {
    const env = await ui();
    env.state.capturing = true; env.state.previewReady = true; env.state.hasApproval = true;
    env.state.cooldownRemaining = 125;
    env.state.cooldownReason = 'Hourly request cap reached. Analysis paused.';
    env.emit('chart-assistant-state'); await flush();
    assert.equal(env.$('mainAction').disabled, true);
    assert.match(env.$('mainAction').textContent, /SCAN in 2:05/);
    assert.match(env.$('actionHint').textContent, /press SCAN/);
    assert.equal(env.$('timeMetricLabel').textContent, 'SCAN IN');
});

test('a paused scan preserves the real explanation instead of generic preview instructions', async () => {
    const env = await ui();
    env.state.capturing = true; env.state.previewReady = true; env.state.hasApproval = true;
    env.state.pauseKind = 'settings'; env.state.pauseReason = 'Strategy changed. Check the required timeframe.';
    env.emit('chart-assistant-state'); await flush();
    assert.equal(env.$('reason').textContent, env.state.pauseReason);
    assert.equal(env.$('mainAction').textContent, 'SCAN');
});

test('readiness shows rule-match progress and honest timing, never a win probability', async () => {
    const env = await ui();
    env.state.capturing = true; env.state.previewReady = true; env.state.hasApproval = true;
    env.state.hasAssessment = true; env.state.scanOutcome = 'complete';
    env.state.readiness = { passed: 2, total: 3, percent: 67, bias: 'BUY', label: 'Rule match — not a win probability' };
    env.state.entryTiming = 'Candle clock unreadable — no timed-entry cue.';
    env.emit('chart-assistant-state'); await flush();
    assert.equal(env.$('setupPercent').textContent, '67%');
    assert.equal(env.$('setupCount').textContent, '2 of 3 setup conditions matched');
    assert.match(env.$('directionBias').textContent, /not an entry instruction/);
    assert.match(env.$('entryTiming').textContent, /unreadable/);
    assert.equal(env.document.body.dataset.phase, 'result');
});

test('local pair detection is shown before scanning without triggering requests', async () => {
    const env = await ui();
    env.state.localIdentity = { asset: 'AUD/CAD OTC', timeframe: '30s' };
    env.emit('chart-assistant-state'); await flush();
    assert.match(env.$('detectionStatus').textContent, /AUD\/CAD OTC · 30s/);
    assert.equal(env.calls.start, 0);
});

test('offline status offers Retry instead of an expired-code form', async () => {
    const env = await ui('offline');
    assert.equal(env.$('mainAction').textContent, 'Retry connection');
    await env.click('mainAction');
    assert.equal(env.calls.retry, 1);
    assert.equal(env.calls.connect, 0);
});

test('compact markup keeps settings collapsed, has no pairing inputs, and explains the manual scan', () => {
    const html = fs.readFileSync('./extension/panel.html', 'utf8');
    assert.ok(html.includes('id="mainAction"'));
    assert.ok(html.includes('id="settingsDrawer"'));
    assert.ok(!/<details[^>]+open/.test(html));
    assert.ok(!html.includes('pairCode'));
    assert.ok(!html.includes('Connect local backend'));
    assert.ok(html.includes('SCAN sends two fresh cropped frames'));
    assert.ok(html.includes('id="setupPercent"'));
    assert.ok(html.includes('id="entryTiming"'));
    assert.ok(html.includes('not a probability of winning'));
});
