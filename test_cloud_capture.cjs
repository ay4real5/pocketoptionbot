const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const ScreenAnalysis = require('./static/screen_analysis.js');
const ChartAlerts = require('./static/chart_alerts.js');

const source = fs.readFileSync(require.resolve('./static/screen_capture.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function browser({ configured = true, surface = 'browser', delayed = false, captureErrors = [], delayedCapture = false, focused = true, secure = true, supported = true, playbackError = false, resultChanges = {}, confirmationInterval = 30, analysisStatus = 200, journal = null, journalFail = false, layoutReport = null, preferenceStore = new Map() } = {}) {
    let now = 10000, frameCallback, tickCallback, imageCount = 0, stopCount = 0, captureCount = 0, acceptCapture, setupFailure = false;
    let headerPixels = new Uint8ClampedArray(96 * 24 * 4);
    const posts = [], pending = [], elements = new Map(), journalPosts = [], toneFrequencies = [], audioContexts = [];
    let staleLayout = false;
    function element(id = '') {
        return {
            id, disabled: false, checked: false, value: '', textContent: '', dataset: {}, style: {}, events: {}, children: [],
            width: 960, height: 400,
            addEventListener(name, callback) { this.events[name] = callback; },
            replaceChildren(...children) { this.children = children; },
            appendChild(child) { this.children.push(child); },
            prepend(child) { this.children.unshift(child); },
            querySelector() { return this.children.find(c => c.tag === 'button'); },
            getContext() { return { clearRect() {}, drawImage() {}, getImageData() { return { data: headerPixels }; } }; },
            toDataURL() { return `data:image/jpeg;base64,fixture-${imageCount++}`; }
        };
    }
    const $ = id => { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); };
    const track = { muted: false, getSettings: () => ({ displaySurface: surface }), addEventListener() {}, stop() { stopCount++; } };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const video = $('video'); video.videoWidth = 1024; video.videoHeight = 600;
    video.requestVideoFrameCallback = callback => { frameCallback = callback; };
    video.play = async () => { if (playbackError) throw Object.assign(new Error('Playback blocked'), { name: 'NotAllowedError' }); };
    const strategies = { aroon_osma: { label: 'Aroon + OsMA', candle_timeframe: '30s' }, trend_range: { label: 'Trend / range', candle_timeframe: '1m' } };
    const output = payload => ({
        direction: 'BUY', chart_readable: true, candle_timeframe: strategies[payload.strategy]?.candle_timeframe,
        strategy: payload.strategy, expiry_minutes: 2, reference_verified: true, asset: 'EUR/USD OTC', market_type: 'OTC',
        reason: 'Mocked opinion', observations: ['Mock structure', 'Mock indicator'], invalidation: 'Mock invalidation',
        captured_at: payload.captured_at, expires_at: payload.captured_at + 20000,
        ...(journal ? { analysis_id: String(payload.captured_at).padStart(32, '0') } : {}), ...resultChanges
    });
    let responseCode = analysisStatus;
    const fetch = async (url, options) => {
        if (url === '/api/vision/status') return { ok: !setupFailure, json: async () => ({ configured, model: 'test', interval_seconds: 30, max_calls_per_hour: 60,
            expiry_minutes: 2, default_strategy: 'aroon_osma', strategies, aroon_min_gap: 20, confirmation_interval_seconds: confirmationInterval,
            min_scan_interval_seconds: confirmationInterval, journal_enabled: !!journal, scan_mode: 'manual', scan_protocol: 2 }) };
        if (url.startsWith('/api/vision/journal/')) {
            const action = url.split('/').at(-1), payload = JSON.parse(options.body);
            journalPosts.push({ action, payload });
            if (journalFail) return { ok: false, json: async () => ({ reason: 'Journal unavailable; not saved.' }) };
            if (action === 'present') journal.shown.push(payload.analysis_id);
            if (action === 'entry') journal.entries.push({ id: 'b'.repeat(32), analysis_id: payload.analysis_id, asset: 'EUR/USD OTC',
                direction: 'BUY', entered_at: 1000000 + now, expires_at: 1120000 + now, result: 'open', pnl_minor: null });
            if (action === 'outcome') journal.entries.find(entry => entry.id === payload.entry_id).result = payload.result;
            return { ok: true, json: async () => action === 'query' ? { entries: journal.entries, signals: [], groups: [], summary: {
                displayed_signals: journal.shown.length, wins: 0, losses: 0, open: journal.entries.filter(row => row.result === 'open').length,
                win_rate: null, net_units: 0, priced_results: 0, unpriced_results: 0
            } } : { saved: true } };
        }
        assert.equal(url, '/api/vision/analyze');
        const payload = JSON.parse(options.body); posts.push(payload);
        if (delayed) return new Promise(resolve => pending.push(() => resolve({ ok: true, json: async () => output(payload) })));
        return { ok: responseCode === 200, status: responseCode, json: async () => output(payload) };
    };
    const context = {
        ScreenAnalysis, ChartAlerts, Uint8ClampedArray, AbortController, fetch,
        AudioContext: class {
            constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; audioContexts.push(this); }
            async resume() { this.state = 'running'; }
            createOscillator() { return { frequency: { setValueAtTime(value) { toneFrequencies.push(value); } }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
            createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
        },
        performance: { now: () => now }, Date: class extends Date { static now() { return 1000000 + now; } },
        document: { hasFocus: () => focused, getElementById: $, querySelector: () => ({ content: 'test-token' }), createElement: tag => ({ ...element(), tag }) },
        navigator: { mediaDevices: supported ? { getDisplayMedia: async () => {
            captureCount++;
            const name = captureErrors.shift();
            if (name) throw Object.assign(new Error('Internal browser detail'), { name });
            if (delayedCapture) return new Promise(resolve => { acceptCapture = () => resolve(stream); });
            return stream;
        } } : undefined },
        window: { isSecureContext: secure, addEventListener() {}, localStorage: {
            getItem(key) { return preferenceStore.get(key) || null; }, setItem(key, value) { preferenceStore.set(key, value); }
        } },
        setInterval(callback) { tickCallback = callback; }, setTimeout() { return 1; }, clearTimeout() {}
    };
    if (layoutReport) {
        $('autoFrame').checked = true;
        context.window.ChartBridge = { request: fetch, capture: async () => stream,
            layout: () => ({ ...layoutReport, seenAt: 1000000 + now - (staleLayout ? 7000 : 0) }),
            state: () => ({ connection: 'connected' }) };
    }
    vm.runInNewContext(source, context);
    await flush();
    return {
        $, posts, pending, journalPosts, toneFrequencies, audioContexts, engine: context.window.ChartAssistant,
        async change(id, values, event = 'change') { Object.assign($(id), values); await $(id).events[event](); await flush(); },
        staleLayout(value) { staleLayout = value; },
        frame() { if (frameCallback) frameCallback(); },
        async click(id) { if (!$(id).disabled) await $(id).events.click(); await flush(); },
        async tick(seconds = 1, frames = true) {
            for (let i = 0; i < seconds; i++) { now += 1000; if (frames && frameCallback) frameCallback(); tickCallback(); await flush(); }
        },
        consent() { $('consent').checked = true; $('consent').events.change(); },
        changeHeader() { headerPixels = new Uint8ClampedArray(headerPixels.length).fill(255); },
        changeStrategy(value) { $('strategy').value = value; $('strategy').events.change(); },
        changeFraming() { $('moreToolbar').checked = !$('moreToolbar').checked; $('moreToolbar').events.change(); },
        failSetup() { setupFailure = true; },
        responseCode(value) { responseCode = value; },
        async scan() { await this.click('start'); await this.tick(); },
        stopped: () => stopCount,
        captureCount: () => captureCount,
        acceptCapture: () => acceptCapture()
    };
}

test('missing API key disables watching and never uploads', async () => {
    const env = await browser({ configured: false });
    assert.equal(env.$('share').disabled, true);
    await env.tick(3);
    assert.equal(env.posts.length, 0);
});

test('manual SCAN sends one two-frame request and never rescans automatically', async () => {
    const env = await browser();
    await env.click('share'); await env.tick(2);
    assert.equal(env.posts.length, 0);
    assert.equal(env.$('start').disabled, true);
    env.consent(); await env.click('start');
    assert.equal(env.posts.length, 0);
    assert.equal(env.engine.state().collecting, true);
    await env.tick();
    assert.equal(env.posts.length, 1);
    assert.equal(env.posts[0].consent, true);
    assert.equal(env.posts[0].mode, 'manual');
    assert.notEqual(env.posts[0].image, env.posts[0].reference_image);
    assert.equal(env.$('direction').textContent, 'BUY');
    await env.tick(60);
    assert.equal(env.posts.length, 1);
    assert.equal(env.engine.state().running, false);
    assert.equal(env.$('direction').textContent, 'WAIT');
});

test('sharing a monitor instead of a tab is rejected', async () => {
    const env = await browser({ surface: 'monitor' });
    await env.click('share'); await env.tick(2);
    assert.ok(env.stopped() > 0);
    assert.equal(env.posts.length, 0);
});

test('stop prevents late responses from reviving a cue or further uploads', async () => {
    const env = await browser({ delayed: true });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(env.posts.length, 1);
    await env.click('stop'); env.pending.shift()(); await flush();
    await env.tick(40);
    assert.equal(env.posts.length, 1);
    assert.equal(env.$('direction').textContent, 'WAIT');
    assert.equal(env.$('logTrade').disabled, true);
});

test('chart header changes invalidate an outstanding response', async () => {
    const env = await browser({ delayed: true });
    await env.click('share'); await env.tick(); env.consent(); await env.click('start');
    env.changeHeader(); await env.tick();
    assert.equal(env.posts.length, 0);
    assert.equal(env.engine.state().running, false);
});

for (const [name, message] of [
    ['NotAllowedError', /same browser profile/],
    ['InvalidStateError', /focus/],
    ['NotReadableError', /browser or operating system/],
    ['NotFoundError', /No shareable tab/],
    ['AbortError', /interrupted/],
    ['TypeError', /update Chrome or Edge/],
    ['UnexpectedError', /could not start/]
]) {
    test(`${name} gives recovery instructions without uploading`, async () => {
        const env = await browser({ captureErrors: [name] });
        await env.click('share'); await env.tick();
        assert.match(env.$('reason').textContent, message);
        assert.equal(env.$('captureHelp').open, true);
        assert.equal(env.$('direction').textContent, 'WAIT');
        assert.equal(env.$('share').disabled, false);
        assert.equal(env.$('start').disabled, true);
        assert.equal(env.posts.length, 0);
        assert.doesNotMatch(env.$('reason').textContent, /Internal browser detail/);
    });
}

test('retry after denial starts preview but still requires upload consent', async () => {
    const env = await browser({ captureErrors: ['NotAllowedError'] });
    await env.click('share'); await env.click('share'); await env.tick();
    assert.equal(env.captureCount(), 2);
    assert.equal(env.$('share').disabled, true);
    assert.equal(env.$('captureHelp').open, false);
    assert.equal(env.$('consent').checked, false);
    assert.equal(env.$('start').disabled, true);
    assert.equal(env.posts.length, 0);
});

test('setup recheck cannot open a second chooser; Stop discards a pending capture', async () => {
    const env = await browser({ delayedCapture: true });
    const sharing = env.click('share');
    await flush();
    await env.click('checkSetup');
    assert.equal(env.$('share').disabled, true);
    assert.equal(env.$('stop').disabled, false);
    await env.click('stop');
    env.acceptCapture(); await sharing; await env.tick();
    assert.equal(env.captureCount(), 1);
    assert.equal(env.stopped(), 1);
    assert.equal(env.$('share').disabled, false);
    assert.equal(env.$('start').disabled, true);
    assert.equal(env.posts.length, 0);
});

for (const [options, message] of [
    [{ focused: false }, /focus/],
    [{ secure: false }, /localhost/],
    [{ supported: false }, /Chrome or Edge/]
]) {
    test(`capture preflight explains ${Object.keys(options)[0]} failure`, async () => {
        const env = await browser(options);
        await env.click('share');
        assert.equal(env.captureCount(), 0);
        assert.match(env.$('reason').textContent, message);
        assert.equal(env.$('captureHelp').open, true);
        assert.equal(env.posts.length, 0);
    });
}

test('default strategy requests 30s Aroon/OsMA and manual timer lasts two minutes', async () => {
    const env = await browser();
    assert.equal(env.$('strategy').value, 'aroon_osma');
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(env.posts[0].strategy, 'aroon_osma');
    await env.click('logTrade');
    const timer = env.$('trades').children[0].children[3];
    await env.tick();
    assert.match(timer.textContent, /^1:59/);
    await env.tick(119);
    assert.equal(timer.textContent, 'Platform result: ');
    assert.equal(timer.children.length, 3);
});

test('earlier trend/range mode still supports one-minute candles with two-minute expiry', async () => {
    const env = await browser();
    env.changeStrategy('trend_range');
    await env.click('checkSetup');
    assert.equal(env.$('strategy').value, 'trend_range');
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(env.posts[0].strategy, 'trend_range');
    assert.equal(env.$('direction').textContent, 'BUY');
});

test('a failed setup recheck pauses analysis and no further scans are sent', async () => {
    const env = await browser();
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    env.failSetup(); await env.click('checkSetup'); await env.tick(31);
    assert.equal(env.posts.length, 1);
    assert.equal(env.$('direction').textContent, 'WAIT');
    assert.equal(env.engine.state().pauseKind, 'setup');
});

test('changing strategy aborts pending analysis and requires a deliberate new scan', async () => {
    const env = await browser({ delayed: true });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    env.changeStrategy('trend_range'); env.pending.shift()(); await flush();
    await env.tick(31);
    assert.equal(env.$('direction').textContent, 'WAIT');
    assert.equal(env.posts.length, 1);
    assert.equal(env.$('pause').disabled, true);
    await env.scan();
    assert.equal(env.posts[1].strategy, 'trend_range');
});

for (const resultChanges of [{ candle_timeframe: '1m' }, { strategy: 'trend_range' }, { expiry_minutes: 5 }]) {
    test(`mismatched strategy/timeframe/expiry cannot produce a cue: ${JSON.stringify(resultChanges)}`, async () => {
        const env = await browser({ resultChanges });
        await env.click('share'); await env.tick(); env.consent(); await env.scan();
        assert.equal(env.$('direction').textContent, 'WAIT');
        assert.equal(env.$('logTrade').disabled, true);
    });
}

test('expanded toolbar framing stops uploads, clears consent and rejects late responses', async () => {
    const env = await browser({ delayed: true });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    env.changeFraming(); env.pending.shift()(); await flush(); await env.tick(31);
    assert.equal(env.$('consent').checked, false);
    assert.equal(env.$('start').disabled, true);
    assert.equal(env.$('direction').textContent, 'WAIT');
    assert.equal(env.posts.length, 1);
});

test('each SCAN needs a fresh click; results display in one request cycle', async () => {
    const env = await browser({ confirmationInterval: 10 });
    await env.click('share'); await env.tick(); env.consent(); await env.click('start');
    assert.equal(env.$('analysisState').textContent, 'PREPARING SCAN');
    assert.equal(env.posts.length, 0);
    await env.tick(); assert.equal(env.posts.length, 1);
    assert.equal(env.$('direction').textContent, 'BUY');
    await env.tick(60); assert.equal(env.posts.length, 1);
    await env.scan(); assert.equal(env.posts.length, 2);
});

test('provider validation failures have a technical-error status, not a trade cue', async () => {
    const env = await browser({ analysisStatus: 502, resultChanges: { reason: 'AI response rejected: invalid reason.' } });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(env.$('analysisState').textContent, 'TECHNICAL ERROR');
    assert.equal(env.$('direction').textContent, 'WAIT');
    assert.equal(env.$('logTrade').disabled, true);
});

test('pending reads show elapsed seconds and prevent overlapping uploads', async () => {
    const env = await browser({ delayed: true });
    await env.click('share'); await env.tick(); env.consent(); await env.scan(); await env.tick(5);
    assert.match(env.$('requestStatus').textContent, /5.0s elapsed/);
    assert.equal(env.$('analysisState').textContent, 'READING CHART');
    assert.equal(env.posts.length, 1);
    await env.click('start');
    assert.equal(env.posts.length, 1);
});

test('frozen frames cancel an in-progress scan without auto-retry and keep consent', async () => {
    const env = await browser();
    await env.click('share'); await env.tick(); env.consent(); await env.click('start');
    await env.tick(40, false);
    assert.equal(env.$('direction').textContent, 'WAIT');
    assert.equal(env.engine.state().running, false);
    assert.equal(env.engine.state().waitingForFrames, true);
    assert.equal(env.$('consent').checked, true);
    assert.equal(env.stopped(), 0);
    assert.equal(env.posts.length, 0);
    await env.tick();
    assert.equal(env.posts.length, 0);
    assert.equal(env.engine.state().waitingForFrames, false);
    await env.scan();
    assert.equal(env.posts.length, 1);
    assert.equal(env.$('direction').textContent, 'BUY');
});

test('stale geometry suspends scans without losing approval and resumes with the same crop', async () => {
    const env = await browser({ layoutReport: { source: 'visible-chart-dom', viewport: { width: 1024, height: 600 },
        bounds: { x: 80, y: 60, width: 700, height: 500 }, candleOpen: null, blocked: false } });
    await env.click('share'); await env.tick(); env.consent(); await env.click('start');
    const key = env.engine.state().previewKey;
    env.staleLayout(true); await env.tick(35);
    assert.equal(env.engine.state().waitingForFrames, true);
    assert.equal(env.$('consent').checked, true);
    assert.equal(env.posts.length, 0);
    env.staleLayout(false); await env.tick();
    assert.equal(env.engine.state().previewKey, key);
    assert.equal(env.engine.state().waitingForFrames, false);
    await env.scan();
    assert.equal(env.posts.length, 1);
});

test('only displayed cues are acknowledged; manual entries and restored outcomes use the durable journal', async () => {
    const store = { entries: [], shown: [] };
    const env = await browser({ journal: store });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(store.shown.length, 1);
    env.$('journalStake').value = '10'; env.$('journalPayout').value = '92';
    await env.click('logTrade');
    assert.equal(store.entries.length, 1);
    const entryRequest = env.journalPosts.find(item => item.action === 'entry');
    assert.equal(entryRequest.payload.payout_percent, '92');
    const reopened = await browser({ journal: store });
    assert.equal(reopened.$('trades').children.length, 1);
    await reopened.tick(160);
    const win = reopened.$('trades').children[0].children[3].children[0];
    await win.events.click(); await flush();
    assert.equal(store.entries[0].result, 'win');
    assert.equal(reopened.posts.length, 0);
});

test('journal failures are visible and never claim a demo entry was saved', async () => {
    const env = await browser({ journal: { entries: [], shown: [] }, journalFail: true });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    await env.click('logTrade');
    assert.match(env.$('journalStatus').textContent, /not confirmed saved/);
    assert.equal(env.journalPosts.some(item => item.action === 'entry'), false);
});

test('first decoded frame prepares a local preview before the periodic timer and sends no image', async () => {
    const env = await browser();
    await env.click('share');
    assert.equal(env.engine.state().previewReady, false);
    env.frame();
    assert.equal(env.engine.state().previewReady, true);
    assert.equal(env.posts.length, 0);
    assert.equal(env.$('consent').checked, false);
});

test('guided Start requires a fresh matching preview and cannot reuse consent after reframing', async () => {
    const env = await browser();
    await env.engine.preview(); env.frame();
    const key = env.engine.state().previewKey;
    assert.equal(env.engine.approveAndStart('wrong-preview'), false);
    assert.equal(env.posts.length, 0);
    env.changeFraming(); env.frame();
    assert.equal(env.engine.approveAndStart(key), false);
    assert.equal(env.posts.length, 0);
    assert.equal(env.engine.approveAndStart(env.engine.state().previewKey), true);
    assert.equal(env.posts.length, 0);
    await env.tick();
    assert.equal(env.posts.length, 1);
    assert.equal(env.posts[0].consent, true);
});

test('API rate limits keep the preview approved, show a countdown, and allow manual rescan after the deadline', async () => {
    const env = await browser({ analysisStatus: 429, resultChanges: { reason: 'Hourly request cap reached.', retry_after: 120 } });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(env.engine.state().running, false);
    assert.equal(env.engine.state().cooldownRemaining, 120);
    assert.match(env.engine.state().cooldownReason, /Hourly/);
    assert.equal(env.$('consent').checked, true);
    await env.tick(119); assert.equal(env.posts.length, 1);
    env.responseCode(200); await env.tick();
    assert.equal(env.posts.length, 1);
    assert.equal(env.engine.state().cooldownRemaining, 0);
    await env.scan();
    assert.equal(env.posts.length, 2);
    assert.equal(env.engine.state().running, false);
});

test('Stop ends capture during a cooldown and Start cannot bypass a server deadline', async () => {
    const env = await browser({ analysisStatus: 429, resultChanges: { reason: 'Hourly request cap reached.', retry_after: 120 } });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    await env.click('stop'); await env.tick(10);
    assert.equal(env.engine.state().capturing, false);
    await env.click('share'); await env.tick(); env.consent(); await env.click('start');
    assert.equal(env.posts.length, 1);
    assert.ok(env.engine.state().cooldownRemaining > 0);
    await env.tick(130);
    assert.equal(env.posts.length, 1);
});

test('a crop change during cooldown still requires fresh approval before scanning again', async () => {
    const env = await browser({ analysisStatus: 429, resultChanges: { reason: 'Hourly request cap reached.', retry_after: 120 } });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    env.changeFraming(); env.responseCode(200); await env.tick(121);
    assert.equal(env.posts.length, 1);
    assert.equal(env.engine.state().running, false);
    assert.equal(env.$('consent').checked, false);
    assert.equal(env.engine.state().pauseKind, 'preview');
});

test('provider errors preserve their pause reason and do not retry automatically', async () => {
    const env = await browser({ analysisStatus: 503, resultChanges: { reason: 'OpenAI quota reached. Check billing.' } });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.equal(env.engine.state().pauseKind, 'api');
    assert.match(env.engine.state().pauseReason, /Check billing/);
    await env.tick(120);
    assert.equal(env.posts.length, 1);
});

test('test tones work without an API key or capture and never change the displayed cue', async () => {
    const env = await browser({ configured: false });
    await env.click('testBuySound'); await env.click('testSellSound');
    assert.deepEqual(env.toneFrequencies, [660, 880, 660, 440]);
    assert.equal(env.posts.length, 0);
    assert.equal(env.captureCount(), 0);
    assert.equal(env.$('direction').textContent, '');
    assert.match(env.$('soundStatus').textContent, /TEST SELL/);
});

test('sound preferences survive reopening but do not play or start AudioContext automatically', async () => {
    const preferenceStore = new Map(), env = await browser({ preferenceStore });
    await env.change('soundVolume', { value: '75' }, 'input');
    await env.change('sound', { checked: true });
    const reopened = await browser({ preferenceStore });
    assert.equal(reopened.$('sound').checked, true);
    assert.equal(reopened.$('soundVolume').value, '75');
    assert.equal(reopened.audioContexts.length, 0);
    assert.equal(reopened.toneFrequencies.length, 0);
});

test('sound alerts fire on a manual scan result and repeated identical scans stay quiet', async () => {
    const env = await browser();
    await env.click('share'); await env.tick(); env.consent(); await env.change('sound', { checked: true });
    await env.scan();
    assert.deepEqual(env.toneFrequencies, [660, 880]);
    await env.tick(30); await env.scan();
    assert.equal(env.toneFrequencies.length, 2);
    await env.change('sound', { checked: false });
    await env.tick(30); await env.scan();
    assert.equal(env.toneFrequencies.length, 2);
});

test('a validated no-setup read allows a later same-direction alert; WAIT and stale reads never sound', async () => {
    const changes = {}, env = await browser({ resultChanges: changes });
    await env.change('sound', { checked: true });
    await env.click('share'); await env.tick(); env.consent(); await env.scan();
    assert.deepEqual(env.toneFrequencies, [660, 880]);
    changes.direction = 'WAIT'; changes.checks = [...['chart', 'timeframe', 'identity', 'settings', 'closed'].map(id => ({ id, status: 'pass' })), { id: 'cross', status: 'fail' }];
    await env.tick(30); await env.scan(); assert.equal(env.toneFrequencies.length, 2);
    changes.direction = 'BUY'; await env.tick(30); await env.scan(); assert.equal(env.toneFrequencies.length, 4);
    changes.direction = 'SELL'; changes.expires_at = 1; await env.tick(30); await env.scan();
    assert.equal(env.toneFrequencies.length, 4);
});

test('preview playback failure is not reported as sharing denied', async () => {
    const env = await browser({ playbackError: true });
    await env.click('share');
    assert.equal(env.stopped(), 1);
    assert.match(env.$('reason').textContent, /preview/);
    assert.doesNotMatch(env.$('reason').textContent, /cancelled or denied/);
    assert.equal(env.$('share').disabled, false);
    assert.equal(env.posts.length, 0);
});
