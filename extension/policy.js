(function (root) {
    'use strict';
    const backend = 'http://127.0.0.1:5000';
    function allowed(url) {
        try {
            const value = new URL(url);
            return value.protocol === 'https:' && !value.username && !value.password &&
                (!value.port || value.port === '443') &&
                (value.hostname === 'pocketoption.com' || value.hostname.endsWith('.pocketoption.com'));
        } catch { return false; }
    }
    function matches(target, tab, requireActive = true) {
        return !!target && !!tab && tab.id === target.id && tab.windowId === target.windowId &&
            (!requireActive || tab.active === true) && tab.status === 'complete' && !tab.pendingUrl && allowed(tab.url) &&
            new URL(tab.url).origin === target.origin;
    }
    const api = { backend, allowed, matches };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.ChartExtensionPolicy = api;
})(globalThis);
