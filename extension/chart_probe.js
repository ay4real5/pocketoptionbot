(function (root) {
    'use strict';
    function inspectVisibleChart() {
        const viewport = { width: innerWidth, height: innerHeight };
        const visibleRect = element => {
            const box = element.getBoundingClientRect(), style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ||
                box.width < 1 || box.height < 1 || box.left < 0 || box.top < 0 ||
                box.right > innerWidth + 1 || box.bottom > innerHeight + 1) return null;
            return { x: box.left, y: box.top, width: box.width, height: box.height };
        };
        const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, 64)
            .map(element => ({ element, box: visibleRect(element) })).filter(item => item.box &&
                item.box.width >= Math.max(280, innerWidth * 0.4) && item.box.height >= 60);
        const main = canvases.filter(item => item.box.height >= 140)
            .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
        if (!main) return null;
        const container = main.element.parentElement?.closest('[data-chart], [role="figure"], [class*="chart"]');
        if (!container || container === document.body || container === document.documentElement) return null;
        const area = visibleRect(container);
        if (!area || area.width > main.box.width * 1.35) return null;
        const aligned = canvases.filter(item => container.contains(item.element) &&
            Math.abs(item.box.x - main.box.x) <= 32 && Math.abs(item.box.width - main.box.width) <= 64);
        let top = Math.min(...aligned.map(item => item.box.y)), bottom = Math.max(...aligned.map(item => item.box.y + item.box.height));
        const bounds = { x: Math.max(area.x, main.box.x - 8), y: Math.max(area.y, top - 56),
            width: Math.min(area.x + area.width, main.box.x + main.box.width + 32) - Math.max(area.x, main.box.x - 8),
            height: Math.min(area.y + area.height, bottom + 18) - Math.max(area.y, top - 56) };
        const overlap = box => box && box.x < bounds.x + bounds.width && box.x + box.width > bounds.x &&
            box.y < bounds.y + bounds.height && box.y + box.height > bounds.y;
        const blocked = Array.from(document.querySelectorAll('[role="dialog"], dialog[open]')).some(element => overlap(visibleRect(element)));
        const labels = new Set();
        for (const element of Array.from(container.querySelectorAll('[data-indicator-name], [class*="indicator"] span, [class*="indicator"] label, [class*="indicator"] button')).slice(0, 200)) {
            if (element.children.length || !visibleRect(element)) continue;
            const text = (element.textContent || '').trim();
            if (/^aroon(?:\s|$)/i.test(text) && text.length < 60) labels.add('Aroon');
            if (/^osma(?:\s|$)/i.test(text) && text.length < 60) labels.add('OsMA');
        }
        const assets = new Set(), timeframes = new Set();
        const currencies = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNH', 'SGD', 'MXN', 'ZAR', 'TRY', 'NOK', 'SEK']);
        for (const element of Array.from(container.querySelectorAll('button, [role="button"], [aria-selected="true"]')).slice(0, 80)) {
            const box = visibleRect(element);
            if (!box || box.y + box.height > main.box.y + 36 || box.x < bounds.x || box.x + box.width > bounds.x + bounds.width) continue;
            if (element.getAttribute('aria-selected') === 'false' || element.getAttribute('aria-pressed') === 'false') continue;
            const text = (element.textContent || '').trim().toUpperCase();
            const pair = /^([A-Z]{3})\s*\/?\s*([A-Z]{3})(?:\s+(OTC))?$/.exec(text);
            if (pair && currencies.has(pair[1]) && currencies.has(pair[2]) && pair[1] !== pair[2]) assets.add(`${pair[1]}/${pair[2]}${pair[3] ? ' OTC' : ''}`);
            if (/^(S30|30S|30 S)$/.test(text)) timeframes.add('30s');
            if (/^(M1|1M|1 M)$/.test(text)) timeframes.add('1m');
        }
        const identity = { asset: assets.size === 1 ? [...assets][0] : null, timeframe: timeframes.size === 1 ? [...timeframes][0] : null };
        let candleOpen = null;
        const clock = container.querySelector('time[aria-label="Current candle open time"][datetime]');
        if (clock && visibleRect(clock)) {
            const parsed = Date.parse(clock.getAttribute('datetime'));
            if (Number.isFinite(parsed) && Math.abs(Date.now() - parsed) <= 120000) candleOpen = parsed;
        }
        return { viewport, bounds, blocked, labels: [...labels], identity, candleOpen, source: 'visible-chart-dom' };
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = { inspectVisibleChart };
    else root.ChartProbe = { inspectVisibleChart };
})(globalThis);
