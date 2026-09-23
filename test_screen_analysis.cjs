const assert = require('node:assert/strict');
const test = require('node:test');
const { readLines, CrossoverTracker, cloudCrop, headerChanged, freshCloudResult } = require('./static/screen_analysis.js');

test('cloud crop excludes usual header and order panel and rejects unsupported layouts', () => {
    const rect = cloudCrop(1024, 504);
    assert.ok(rect.y > 50);
    assert.ok(rect.x + rect.width < 880);
    assert.ok(rect.y + rect.height <= 504);
    assert.equal(cloudCrop(450, 900), null);
    assert.equal(cloudCrop(600, 300), null);
    assert.equal(rect.y, Math.round(504 * 0.11));
    for (const [width, height] of [[1024, 504], [1366, 768], [1920, 1080]]) {
        const normal = cloudCrop(width, height), expanded = cloudCrop(width, height, true);
        assert.ok(expanded.y < normal.y);
        assert.equal(expanded.x, normal.x);
        assert.equal(expanded.width, normal.width);
        assert.equal(expanded.y + expanded.height, normal.y + normal.height);
        assert.ok(expanded.y + expanded.height <= height);
    }
});

test('chart identity guard detects header changes', () => {
    const a = new Uint8ClampedArray(96 * 24 * 4);
    const b = new Uint8ClampedArray(a);
    assert.equal(headerChanged(a, b), false);
    b.fill(255, 0, 1000);
    assert.equal(headerChanged(a, b), true);
    assert.equal(headerChanged(null, b), true);
});

test('stale, changed-chart, future and mismatched cloud responses cannot show directions', () => {
    const result = { direction: 'BUY', chart_readable: true, reference_verified: true, candle_timeframe: '30s', strategy: 'aroon_osma', expiry_minutes: 2, asset: 'EUR/USD OTC', captured_at: 1000, expires_at: 21000 };
    assert.ok(freshCloudResult(result, 1000, 5000, 100, true));
    assert.ok(!freshCloudResult({ ...result, reference_verified: false }, 1000, 5000, 100, true));
    assert.ok(!freshCloudResult(result, 1000, 22000, 100, true));
    assert.ok(!freshCloudResult(result, 1000, 5000, 3000, true));
    assert.ok(!freshCloudResult(result, 1000, 5000, 100, false));
    assert.ok(!freshCloudResult(result, 2000, 5000, 100, true));
    assert.ok(!freshCloudResult(result, 1000, 999, 100, true));
    assert.ok(!freshCloudResult({ ...result, expires_at: 9999999 }, 1000, 5000, 100, true));
    assert.ok(!freshCloudResult({ ...result, candle_timeframe: 'unknown' }, 1000, 5000, 100, true));
    assert.ok(!freshCloudResult({ ...result, candle_timeframe: '1m' }, 1000, 5000, 100, true));
    assert.ok(!freshCloudResult({ ...result, strategy: 'trend_range' }, 1000, 5000, 100, true));
    assert.ok(!freshCloudResult({ ...result, expiry_minutes: 5 }, 1000, 5000, 100, true));
    assert.ok(freshCloudResult({ ...result, strategy: 'trend_range', candle_timeframe: '1m' }, 1000, 5000, 100, true, 'trend_range', '1m', 2));
});

function fixture({ above = true, bars = false } = {}) {
    const width = 180, height = 100;
    const data = new Uint8ClampedArray(width * height * 4);
    const paint = (x, y, rgb) => data.set([...rgb, 255], (y * width + x) * 4);
    for (let x = 10; x < 150; x++) {
        paint(x, above ? 60 : 80, [0, 160, 255]);
        paint(x, 70, [255, 40, 0]);
        if (bars) for (let y = 10; y < 25; y++) paint(x, y, [255, 40, 0]);
    }
    return { width, height, data };
}
const blue = [0, 160, 255], red = [255, 40, 0];

test('reads blue above/below red and rejects missing or ambiguous lines', () => {
    assert.equal(readLines(fixture(), blue, red).relation, 1);
    assert.equal(readLines(fixture({ above: false }), blue, red).relation, -1);
    assert.equal(readLines(fixture({ bars: true }), blue, red).valid, false);
    assert.equal(readLines(fixture(), blue, blue).valid, false);
    const empty = fixture(); empty.data.fill(0);
    assert.equal(readLines(empty, blue, red).valid, false);
});

test('requires a baseline then three consecutive opposite readings', () => {
    const tracker = new CrossoverTracker();
    const sample = (relation, now) => tracker.update({ valid: true, relation, signature: now }, now);
    for (let t = 0; t <= 2000; t += 1000) assert.equal(sample(-1, t).direction, 'WAIT');
    assert.equal(sample(1, 3000).direction, 'WAIT');
    assert.equal(sample(1, 4000).direction, 'WAIT');
    const signal = sample(1, 5000);
    assert.equal(signal.direction, 'UP');
    assert.equal(signal.emittedAt, 5000);
    assert.equal(sample(1, 6000).emittedAt, 5000);
    assert.equal(sample(1, 16000).direction, 'WAIT');
});

test('detects DOWN, suppresses noisy crossings, and clears invalid/stale observations', () => {
    const tracker = new CrossoverTracker();
    const sample = (relation, now, signature = now) => tracker.update({ valid: true, relation, signature }, now);
    sample(1, 0); sample(1, 1000); sample(1, 2000);
    sample(-1, 3000); sample(1, 4000); sample(-1, 5000); sample(-1, 6000);
    assert.equal(sample(-1, 7000).direction, 'DOWN');
    assert.equal(tracker.update({ valid: false, reason: 'unreadable' }, 8000).direction, 'WAIT');
    sample(1, 9000); sample(1, 10000); sample(1, 11000);
    assert.equal(sample(-1, 32000, 11000).direction, 'WAIT');
    assert.equal(sample(-1, 33000, 11000).direction, 'WAIT');
});

test('touching lines wait without mistaking the established baseline for a fresh signal', () => {
    const tracker = new CrossoverTracker();
    const sample = (relation, now) => tracker.update({ valid: true, relation, signature: now }, now);
    sample(-1, 0); sample(-1, 1000); sample(-1, 2000);
    assert.equal(sample(0, 3000).direction, 'WAIT');
    sample(1, 4000); sample(1, 5000);
    assert.equal(sample(1, 6000).direction, 'UP');
});

test('a long sampling gap cannot create a new crossover signal', () => {
    const tracker = new CrossoverTracker();
    for (let t = 0; t <= 2000; t += 1000) tracker.update({ valid: true, relation: -1, signature: t }, t);
    const result = tracker.update({ valid: true, relation: 1, signature: 9000 }, 9000);
    assert.equal(result.direction, 'WAIT');
});
