const test = require('node:test');
const assert = require('node:assert/strict');
const { preferences, TonePlayer, AlertGate } = require('./static/chart_alerts.js');

function audioFixture() {
    const frequencies = [], gains = [], nodes = [];
    const context = { state: 'suspended', currentTime: 5, destination: {},
        async resume() { this.state = 'running'; },
        createOscillator() {
            const node = { frequency: { setValueAtTime(value) { frequencies.push(value); } }, connect() {}, disconnect() {},
                start() {}, stop() { this.stopped = true; } };
            nodes.push(node); return node;
        },
        createGain() { return { connect() {}, disconnect() {}, gain: {
            setValueAtTime(value) { gains.push(value); }, linearRampToValueAtTime(value) { gains.push(value); }
        } }; }
    };
    return { context, frequencies, gains, nodes };
}
const cue = (time, changes = {}) => ({ asset: 'EUR/USD OTC', market_type: 'OTC', strategy: 'aroon_osma', candle_timeframe: '30s',
    direction: 'BUY', captured_at: time, expires_at: time + 20000, chart_readable: true,
    aroon_osma: { up_previous: 20, down_previous: 70, up_latest: 80, down_latest: 30 }, ...changes });
const clearSetup = time => cue(time, { direction: 'WAIT', checks: [
    ...['chart', 'timeframe', 'settings', 'closed'].map(id => ({ id, status: 'pass' })), { id: 'cross', status: 'fail' }
] });

test('preferences have quiet defaults and validate saved settings', () => {
    assert.deepEqual(preferences(null), { sound: false, volume: 50, desktop: false });
    assert.deepEqual(preferences({ sound: true, volume: 150, desktop: true, secret: 'discard' }), { sound: true, volume: 100, desktop: true });
    assert.equal(preferences({ volume: NaN, sound: 'yes' }).volume, 50);
    assert.equal(preferences({ volume: -2 }).volume, 0);
});

test('BUY rises, SELL falls, volume is bounded, and cancellation stops scheduled tones', async () => {
    const fixture = audioFixture(), player = new TonePlayer(() => fixture.context);
    assert.equal(player.play('BUY', 50), false);
    await player.unlock();
    assert.equal(player.play('BUY', 50), true);
    assert.deepEqual(fixture.frequencies, [660, 880]);
    assert.ok(Math.max(...fixture.gains) <= 0.18);
    player.cancel();
    assert.ok(fixture.nodes.every(node => node.stopped));
    fixture.frequencies.length = 0;
    assert.equal(player.play('SELL', 50), true);
    assert.deepEqual(fixture.frequencies, [660, 440]);
    assert.equal(player.play('WAIT', 50), false);
    assert.equal(player.play('BUY', 0), false);
});

test('a closed AudioContext can be recreated on a user gesture', async () => {
    const first = audioFixture(), second = audioFixture();
    let count = 0;
    const player = new TonePlayer(() => count++ ? second.context : first.context);
    await player.unlock(); first.context.state = 'closed'; await player.unlock();
    assert.equal(count, 2);
    assert.equal(player.play('BUY', 60), true);
});

test('continuous repeated opinions and invalid readings do not spam or rearm alerts', () => {
    const gate = new AlertGate();
    assert.equal(gate.accept(cue(100000), 101000), true);
    assert.equal(gate.accept(cue(130000), 131000), false);
    gate.observeWait(cue(160000, { direction: 'WAIT', chart_readable: false }), 161000);
    assert.equal(gate.accept(cue(190000), 191000), false);
    assert.equal(gate.accept(cue(200000), 230000), false);
    assert.equal(gate.accept(cue(210000, { direction: 'SELL' }), 211000), true);
});

test('a confirmed no-setup reading rearms a later same-direction cue without replaying an old result', () => {
    const gate = new AlertGate();
    assert.equal(gate.accept(cue(100000), 101000), true);
    gate.observeWait(clearSetup(105000), 106000);
    assert.equal(gate.accept(cue(110000), 111000), false);
    assert.equal(gate.accept(cue(140000), 141000), true);
    gate.observeWait(clearSetup(145000), 146000);
    assert.equal(gate.accept(cue(140000), 147000), false);
});

test('failed delivery allows a fresh retry but never replays the same snapshot', () => {
    const gate = new AlertGate(), original = cue(100000);
    assert.equal(gate.accept(original, 101000), true);
    gate.deliveryFailed(original);
    assert.equal(gate.accept(original, 102000), false);
    assert.equal(gate.accept(cue(110000), 111000), true);
});

test('an out-of-order opinion predating the reset cannot rearm an old setup', () => {
    const gate = new AlertGate();
    gate.accept(cue(100000), 101000);
    gate.observeWait(clearSetup(135000), 136000);
    assert.equal(gate.accept(cue(130000), 137000), false);
});

test('a new observed candle needs changed crossover evidence; a new scan ID alone is not a new setup', () => {
    const gate = new AlertGate();
    assert.equal(gate.accept(cue(100000), 101000, 90000), true);
    assert.equal(gate.accept(cue(130000, { analysis_id: 'another' }), 131000, 120000), false);
    const changed = cue(160000, { aroon_osma: { up_previous: 10, down_previous: 90, up_latest: 100, down_latest: 10 } });
    assert.equal(gate.accept(changed, 161000, 150000), true);
    assert.equal(gate.accept(cue(190000, { aroon_osma: { up_previous: 11, down_previous: 89, up_latest: 99, down_latest: 11 } }), 191000, 180000), false);
});
