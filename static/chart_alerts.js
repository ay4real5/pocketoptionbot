(function (root) {
    'use strict';
    function preferences(value) {
        return { sound: value?.sound === true, desktop: value?.desktop === true,
            volume: Number.isFinite(value?.volume) ? Math.max(0, Math.min(100, Math.round(value.volume))) : 50 };
    }
    class TonePlayer {
        constructor(factory) { this.factory = factory; this.context = null; this.nodes = new Set(); this.revision = 0; }
        async unlock() {
            if (!this.context || this.context.state === 'closed') this.context = this.factory();
            if (this.context.state !== 'running') await this.context.resume();
            return this.context.state === 'running';
        }
        get ready() { return this.context?.state === 'running'; }
        cancel() {
            this.revision++;
            for (const node of [...this.nodes]) {
                try { node.oscillator.stop(); } catch {}
                node.cleanup();
            }
        }
        play(direction, volume) {
            if (!this.ready || !['BUY', 'SELL'].includes(direction) || !Number.isFinite(volume) || volume <= 0) return false;
            this.cancel();
            const context = this.context, peak = 0.18 * (Math.min(volume, 100) / 100) ** 2;
            const notes = direction === 'BUY' ? [660, 880] : [660, 440];
            notes.forEach((frequency, index) => {
                const oscillator = context.createOscillator(), gain = context.createGain();
                const start = context.currentTime + index * 0.23;
                const node = { oscillator, cleanup: () => {
                    if (!this.nodes.delete(node)) return;
                    oscillator.disconnect(); gain.disconnect();
                } };
                this.nodes.add(node);
                oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(frequency, start);
                gain.gain.setValueAtTime(0, start);
                gain.gain.linearRampToValueAtTime(peak, start + 0.02);
                gain.gain.linearRampToValueAtTime(0, start + 0.19);
                oscillator.connect(gain); gain.connect(context.destination);
                oscillator.onended = node.cleanup;
                oscillator.start(start); oscillator.stop(start + 0.20);
            });
            return true;
        }
    }
    class AlertGate {
        constructor() { this.reset(); }
        reset() { this.states = new Map(); this.seen = new Set(); }
        valid(result, now) {
            return result && result.chart_readable === true && typeof result.asset === 'string' && result.asset.trim() && result.asset.length <= 80 &&
                ['OTC', 'normal'].includes(result.market_type) && ['aroon_osma', 'trend_range'].includes(result.strategy) &&
                ['30s', '1m'].includes(result.candle_timeframe) && Number.isFinite(result.captured_at) &&
                Number.isFinite(result.expires_at) && now >= result.captured_at && now < result.expires_at &&
                result.expires_at <= result.captured_at + 20000;
        }
        key(result) { return JSON.stringify([result.strategy, result.asset.trim().toUpperCase().replace(/\s+/g, ' '), result.market_type, result.candle_timeframe]); }
        fingerprint(result) {
            const evidence = result.aroon_osma;
            const keys = ['up_previous', 'down_previous', 'up_latest', 'down_latest'];
            return evidence && keys.every(key => Number.isFinite(evidence[key])) ?
                JSON.stringify(keys.map(key => Math.round(evidence[key] / 10))) : null;
        }
        observeWait(result, now) {
            if (!this.valid(result, now) || result.direction !== 'WAIT') return;
            const checks = new Map((Array.isArray(result.checks) ? result.checks : []).filter(Boolean).map(check => [check.id, check.status]));
            const required = result.strategy === 'aroon_osma' ? ['chart', 'timeframe', 'settings', 'closed'] : ['chart', 'timeframe', 'evidence'];
            const rules = result.strategy === 'aroon_osma' ? ['cross', 'gap', 'momentum'] : ['setup'];
            if (required.every(key => checks.get(key) === 'pass') && rules.some(key => checks.get(key) === 'fail')) {
                const previous = this.states.get(this.key(result));
                if (previous && result.captured_at > previous.capturedAt) { previous.armed = true; previous.armedAt = result.captured_at; }
            }
        }
        deliveryFailed(result) {
            const previous = this.states.get(this.key(result));
            if (previous?.capturedAt === result.captured_at) { previous.armed = true; previous.at = -Infinity; }
        }
        accept(result, now, candle = null) {
            if (!this.valid(result, now) || !['BUY', 'SELL'].includes(result.direction)) return false;
            const key = this.key(result), id = `${key}:${result.captured_at}`;
            if (this.seen.has(id)) return false;
            const previous = this.states.get(key), fingerprint = this.fingerprint(result);
            const period = result.candle_timeframe === '30s' ? 30000 : 60000;
            if (!Number.isFinite(candle) || candle > result.captured_at || result.captured_at - candle > period + 5000) candle = null;
            const newCandle = previous && candle !== null && previous.candle !== null && candle > previous.candle &&
                fingerprint !== null && previous.fingerprint !== null && fingerprint !== previous.fingerprint;
            if (previous && (result.captured_at <= previous.capturedAt || result.captured_at <= (previous.armedAt ?? -Infinity))) return false;
            if (previous && previous.direction === result.direction &&
                (now - previous.at < 30000 || (!previous.armed && !newCandle))) return false;
            this.states.set(key, { direction: result.direction, capturedAt: result.captured_at, at: now, candle, fingerprint, armed: false });
            this.seen.add(id);
            while (this.states.size > 64) this.states.delete(this.states.keys().next().value);
            while (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
            return true;
        }
    }
    const api = { preferences, TonePlayer, AlertGate };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ChartAlerts = api;
})(globalThis);
