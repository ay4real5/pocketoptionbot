(function (root) {
    'use strict';
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

    function readLines(image, macdColor, signalColor) {
        const fail = reason => ({ valid: false, reason });
        if (!image || image.width < 60 || image.height < 25) return fail('Select a larger MACD area.');
        if (!macdColor || !signalColor || distance(macdColor, signalColor) < 100) return fail('Pick two distinct line colours.');
        const { data, width, height } = image;
        const points = [];
        let rightmostPaint = 0, signature = 2166136261;
        for (let x = 0; x < width; x++) {
            const ys = [[], []];
            for (let y = 0; y < height; y++) {
                const p = (y * width + x) * 4;
                const rgb = [data[p], data[p + 1], data[p + 2]];
                signature = Math.imul(signature ^ (rgb[0] + rgb[1] * 3 + rgb[2] * 7), 16777619);
                if (distance(rgb, macdColor) <= 65) ys[0].push(y);
                if (distance(rgb, signalColor) <= 65) ys[1].push(y);
            }
            if (ys[0].length || ys[1].length) rightmostPaint = x;
            if (ys.every(list => list.length && list.length <= 5 && list.at(-1) - list[0] <= 5)) {
                points.push({ x, macd: median(ys[0]), signal: median(ys[1]) });
            }
        }
        if (points.length < 25) return fail('Not enough clean line pixels. Exclude histogram bars and labels.');
        const end = points.at(-1);
        if (rightmostPaint - end.x > 8) return fail('Latest line endpoints are obscured or ambiguous.');
        const tail = points.filter(p => p.x >= end.x - 6);
        if (tail.length < 4) return fail('Latest lines cannot be read consistently.');
        const deltas = tail.map(p => p.signal - p.macd);
        const delta = median(deltas);
        const touching = Math.abs(delta) < 2 || deltas.some(d => d * delta < 0);
        return { valid: true, relation: touching ? 0 : delta > 0 ? 1 : -1, signature: signature >>> 0, endpoint: end };
    }

    class CrossoverTracker {
        constructor() { this.reset(); }
        reset() {
            this.baseline = null;
            this.candidate = null;
            this.count = 0;
            this.signature = null;
            this.changedAt = null;
            this.sampleAt = null;
            this.event = null;
        }
        update(reading, now) {
            const wait = reason => ({ direction: 'WAIT', reason });
            if (!reading.valid) {
                this.reset();
                return wait(reading.reason || 'Unreadable chart.');
            }
            if (this.sampleAt !== null && now - this.sampleAt > 3500) this.reset();
            this.sampleAt = now;
            if (reading.signature !== this.signature) {
                this.signature = reading.signature;
                this.changedAt = now;
            }
            if (now - this.changedAt >= 15000) {
                this.baseline = null;
                this.candidate = null;
                this.count = 0;
                this.event = null;
                return wait('MACD image unchanged for 15 seconds. Waiting for fresh movement.');
            }
            if (reading.relation === 0) {
                this.candidate = null;
                this.count = 0;
                this.event = null;
                return wait('Lines are touching; waiting for separation.');
            }
            if (this.candidate === reading.relation) this.count++;
            else { this.candidate = reading.relation; this.count = 1; }
            if (this.count >= 3) {
                if (this.baseline === null) this.baseline = reading.relation;
                else if (this.baseline !== reading.relation) {
                    this.baseline = reading.relation;
                    this.event = {
                        direction: reading.relation === 1 ? 'UP' : 'DOWN',
                        emittedAt: now,
                        reason: 'New visual MACD crossover persisted for three readings. Candle close is NOT verified.'
                    };
                }
            }
            if (this.event && now - this.event.emittedAt < 10000) return this.event;
            return wait(this.baseline === null ? 'Establishing a baseline; old crosses are not signals.' : 'Monitoring for a new crossover.');
        }
    }
    function cloudCrop(width, height, moreToolbar = false, compact = false) {
        if (width < (compact ? 600 : 900) || height < 450 || width / height < (compact ? 0.9 : 1.4) || width / height > 2.7) return null;
        const y = Math.round(height * (moreToolbar ? 0.07 : 0.11));
        return { x: Math.round(width * 0.04), y,
            width: Math.round(width * 0.80), height: Math.round(height * 0.985) - y };
    }

    function chartDomCrop(width, height, report, now, moreToolbar = false) {
        if (!report || report.source !== 'visible-chart-dom' || report.blocked || !report.bounds || !report.viewport ||
            !Number.isFinite(report.seenAt) || now < report.seenAt || now - report.seenAt > 6000) return null;
        const { x, y, width: w, height: h } = report.bounds, view = report.viewport;
        if (![width, height, x, y, w, h, view.width, view.height].every(Number.isFinite) ||
            view.width < 400 || view.height < 300 || width < 400 || height < 300 || x < 0 || y < 0 || w < 280 || h < 180 ||
            x + w > view.width + 1 || y + h > view.height + 1) return null;
        const sx = width / view.width, sy = height / view.height;
        if (Math.abs(sx / sy - 1) > 0.02) return null;
        const top = moreToolbar ? Math.max(0, y - 40) : y;
        const left = Math.round(x * sx), upper = Math.round(top * sy);
        return { x: left, y: upper, width: Math.min(width - left, Math.round(w * sx)),
            height: Math.min(height - upper, Math.round((y + h - top) * sy)) };
    }

    class CandleClock {
        constructor() { this.reset(); }
        reset() { this.open = null; this.lastSample = null; this.lastChange = null; this.matches = 0; this.closedAt = null; this.period = null; }
        update(open, now, seconds) {
            if (!Number.isFinite(open) || ![30, 60].includes(seconds) ||
                (this.lastSample !== null && (now < this.lastSample || now - this.lastSample > 6000)) || this.period !== seconds) this.reset();
            this.period = seconds;
            this.lastSample = now;
            if (!Number.isFinite(open)) return { ready: false, closedAt: null };
            if (this.open === null) { this.open = open; this.lastChange = now; }
            else if (open !== this.open) {
                const elapsed = now - this.lastChange;
                const consistent = open - this.open === seconds * 1000 && Math.abs(elapsed - seconds * 1000) <= 4000;
                this.matches = consistent ? this.matches + 1 : 0;
                this.open = open; this.lastChange = now;
                this.closedAt = this.matches >= 2 ? now : null;
            }
            if (now - this.lastChange > seconds * 1000 + 6000) { this.reset(); return { ready: false, closedAt: null }; }
            return { ready: this.matches >= 2, closedAt: this.closedAt };
        }
    }

    function headerChanged(previous, next) {
        if (!previous || previous.length !== next.length) return true;
        let changed = 0;
        for (let i = 0; i < next.length; i += 4) {
            if (Math.abs(previous[i] - next[i]) + Math.abs(previous[i + 1] - next[i + 1]) + Math.abs(previous[i + 2] - next[i + 2]) > 100) changed++;
        }
        return changed > Math.max(8, next.length / 4 * 0.015);
    }

    function localIdentity(value) {
        if (!value || typeof value !== 'object') return null;
        const asset = typeof value.asset === 'string' && /^[A-Z]{3}\/[A-Z]{3}( OTC)?$/.test(value.asset) ? value.asset : null;
        const timeframe = ['30s', '1m'].includes(value.timeframe) ? value.timeframe : null;
        return asset || timeframe ? { asset, timeframe } : null;
    }
    function identityMatches(local, result) {
        if (!local) return true;
        if (local.timeframe && local.timeframe !== result.candle_timeframe) return false;
        if (!local.asset) return true;
        const normalize = value => String(value || '').toUpperCase().replace(/[\s/]/g, '').replace(/OTC$/, '');
        return normalize(local.asset) === normalize(result.asset) && (!local.asset.endsWith(' OTC') || result.market_type === 'OTC');
    }
    function entryTiming(result, open, now) {
        if (!result) return 'SCAN to assess the current setup. No future direction is predicted.';
        if (now >= result.expires_at) return 'Expired assessment. SCAN again.';
        if (result.direction === 'WAIT') return 'WAIT — no confirmed setup to time.';
        const period = result.candle_timeframe === '30s' ? 30000 : 60000;
        if (!Number.isFinite(open) || open > now || now - open >= period) return 'Candle clock unreadable — no timed-entry cue.';
        if (result.captured_at < open) return 'A new candle opened after capture. SCAN again before considering entry.';
        return `Observed candle age ${Math.floor((now - open) / 1000)}s; next candle in ${Math.ceil((open + period - now) / 1000)}s. This is clock timing, not a prediction.`;
    }
    function freshCloudResult(result, capturedAt, now, frameAge, sameChart, strategy = 'aroon_osma', timeframe = '30s', expiry = 2) {
        return sameChart && frameAge >= 0 && frameAge < 2500 && result &&
            ['BUY', 'SELL'].includes(result.direction) && result.chart_readable === true && result.reference_verified === true &&
            result.strategy === strategy && result.expiry_minutes === expiry &&
            result.candle_timeframe === timeframe && typeof result.asset === 'string' && result.asset.trim() &&
            result.captured_at === capturedAt && Number.isFinite(result.expires_at) &&
            now >= capturedAt && now < result.expires_at && result.expires_at <= capturedAt + 20000;
    }

    const api = { readLines, CrossoverTracker, cloudCrop, chartDomCrop, CandleClock, headerChanged, localIdentity, identityMatches, entryTiming, freshCloudResult };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ScreenAnalysis = api;
})(globalThis);
