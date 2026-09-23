const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { inspectVisibleChart } = require('./extension/chart_probe.js');
const { chartDomCrop, CandleClock } = require('./static/screen_analysis.js');

const report = () => ({ viewport: { width: 1000, height: 700 }, bounds: { x: 80, y: 90, width: 700, height: 560 },
    source: 'visible-chart-dom', seenAt: 10000, blocked: false, candleOpen: null, labels: ['Aroon', 'OsMA'] });

test('DOM crop scales CSS bounds to captured pixels and rejects stale or mismatched geometry', () => {
    assert.deepEqual(chartDomCrop(2000, 1400, report(), 11000), { x: 160, y: 180, width: 1400, height: 1120 });
    assert.equal(chartDomCrop(2000, 1400, report(), 17000), null);
    assert.equal(chartDomCrop(1800, 1400, report(), 11000), null);
    assert.equal(chartDomCrop(2000, 1400, { ...report(), bounds: { x: -5, y: 0, width: 700, height: 700 } }, 11000), null);
    assert.equal(chartDomCrop(2000, 1400, { ...report(), blocked: true }, 11000), null);
});

test('candle scheduling needs real observed timestamps and resets after missing samples or timeframe changes', () => {
    const tracker = new CandleClock();
    assert.equal(tracker.update(null, 10000, 30).ready, false);
    let reading;
    for (let now = 10000; now <= 70000; now += 2000) {
        const open = 1000000 + Math.floor((now - 10000) / 30000) * 30000;
        reading = tracker.update(open, now, 30);
    }
    assert.equal(reading.ready, true);
    assert.equal(reading.closedAt, 70000);
    assert.equal(tracker.update(1060000, 72000, 30).closedAt, 70000);
    assert.equal(tracker.update(1090000, 105000, 30).ready, false);
    assert.equal(tracker.update(1090000, 107000, 60).ready, false);
    assert.equal(tracker.update(null, 109000, 60).ready, false);
});

test('local identity accepts unique visible chart-header controls and rejects ambiguous pairs', () => {
    const box = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h });
    const controls = ['AUD/CAD OTC', 'S30'].map((text, index) => ({ textContent: text,
        getAttribute: () => null, getBoundingClientRect: () => box(90 + index * 150, 80, 100, 25) }));
    const canvas = { getBoundingClientRect: () => box(80, 120, 700, 480) };
    const root = { getBoundingClientRect: () => box(80, 70, 720, 560), contains: () => true,
        querySelectorAll: selector => selector.startsWith('button') ? controls : [], querySelector: () => null };
    canvas.parentElement = { closest: () => root };
    const context = { document: { body: {}, documentElement: {}, querySelectorAll: selector => selector === 'canvas' ? [canvas] : [] },
        innerWidth: 1000, innerHeight: 700, Date, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
    const probe = () => vm.runInNewContext(`(${inspectVisibleChart.toString()})()`, context);
    assert.equal(probe().identity.asset, 'AUD/CAD OTC');
    assert.equal(probe().identity.timeframe, '30s');
    controls.push({ ...controls[0], textContent: 'EUR/USD OTC' });
    assert.equal(probe().identity.asset, null);
    controls[2].getAttribute = name => name === 'aria-selected' ? 'false' : null;
    assert.equal(probe().identity.asset, 'AUD/CAD OTC');
});

test('visual DOM probe returns only chart geometry and explicitly labelled candle time, never arbitrary page text', () => {
    const box = (x, y, width, height) => ({ left: x, top: y, right: x + width, bottom: y + height, width, height });
    const label = text => ({ children: [], textContent: text, getBoundingClientRect: () => box(90, 460, 90, 20) });
    const main = { getBoundingClientRect: () => box(80, 120, 700, 300) };
    const indicator = { getBoundingClientRect: () => box(80, 430, 700, 180) };
    const root = { getBoundingClientRect: () => box(80, 70, 720, 560), contains: element => [main, indicator].includes(element),
        querySelectorAll: () => [label('Aroon 10'), label('OsMA 10 20 10'), label('not-returned')], querySelector: () => null };
    main.parentElement = { closest: () => root }; main.closest = () => root;
    const document = { body: {}, documentElement: {}, querySelectorAll: selector => selector === 'canvas' ? [main, indicator] : [] };
    const result = vm.runInNewContext(`(${inspectVisibleChart.toString()})()`, {
        document, innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), Date
    });
    assert.equal(result.source, 'visible-chart-dom');
    assert.equal(result.candleOpen, null);
    assert.equal(result.bounds.x, 80);
    assert.ok(result.bounds.y <= 90 && result.bounds.height >= 520);
    assert.deepEqual(Array.from(result.labels), ['Aroon', 'OsMA']);
    assert.ok(!JSON.stringify(result).includes('not-returned'));
});
