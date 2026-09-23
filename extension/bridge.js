(() => {
    'use strict';
    const { backend, matches, allowed } = ChartExtensionPolicy;
    let activeStream = null, captureGeneration = 0, target = null, connecting = null, layout = null, probing = false;
    let view = { connection: 'checking', message: 'Checking connection…', hasTarget: false };
    const publish = (connection, message) => {
        view = { ...view, connection, message };
        window.dispatchEvent(new Event('chart-bridge-state'));
    };
    const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    async function localFetch(path, options = {}) {
        const controller = new AbortController();
        const timeout = options.signal ? null : setTimeout(() => controller.abort(), 4000);
        try {
            return await fetch(backend + path, { ...options, signal: options.signal || controller.signal,
                cache: 'no-store', credentials: 'omit', redirect: 'error' });
        } finally { if (timeout) clearTimeout(timeout); }
    }
    function stopCapture(notify = true) {
        captureGeneration++;
        if (activeStream) activeStream.getTracks().forEach(track => track.stop());
        activeStream = null; layout = null;
        if (notify) window.dispatchEvent(new Event('chart-capture-ended'));
    }
    async function selectedTab(requireActive = false) {
        const { target: candidate } = await chrome.storage.session.get('target');
        if (!candidate) throw new Error('Open your chart and click the extension icon to select it.');
        const [tab, windowInfo] = await Promise.all([chrome.tabs.get(candidate.id), chrome.windows.get(candidate.windowId)]);
        if (!matches(candidate, tab, requireActive) || (requireActive && (!windowInfo.focused || document.hidden))) {
            throw new Error('The selected chart is unavailable. Open it to start a new capture.');
        }
        return candidate;
    }
    async function inspectLayout() {
        if (probing || !activeStream || !activeStream.getVideoTracks().some(track => track.readyState === 'live') ||
            !chrome.scripting?.executeScript || typeof ChartProbe === 'undefined') return;
        const generation = captureGeneration;
        probing = true;
        try {
            const selected = await selectedTab();
            const results = await chrome.scripting.executeScript({ target: { tabId: selected.id }, func: ChartProbe.inspectVisibleChart });
            const latest = await selectedTab();
            if (generation === captureGeneration && selected.id === latest.id && selected.selectedAt === latest.selectedAt) {
                const report = results.find(item => item.frameId === 0)?.result;
                layout = report ? { ...report, seenAt: Date.now() } : null;
            }
        } catch { if (generation === captureGeneration) layout = null; }
        finally { probing = false; }
    }
    async function capture() {
        stopCapture(false);
        const generation = captureGeneration;
        const selected = await selectedTab(true);
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: selected.id });
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
            video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 5 } } });
        try {
            const latest = await selectedTab();
            if (generation !== captureGeneration || latest.selectedAt !== selected.selectedAt || latest.id !== selected.id) {
                throw new Error('Chart selection changed.');
            }
            target = selected; activeStream = stream;
            await inspectLayout();
            if (generation !== captureGeneration) throw new Error('Chart selection changed.');
            return stream;
        } catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
    }
    async function credentials() {
        const { backendAuth } = await chrome.storage.local.get('backendAuth');
        if (!backendAuth || backendAuth.expiresAt <= Date.now()) {
            if (view.connection !== 'approving') publish('needs-approval', 'Connect once to enable chart analysis.');
            throw new Error('Connection approval required.');
        }
        return backendAuth;
    }
    async function request(path, options = {}) {
        const endpoints = { '/api/vision/status': '/api/extension/status', '/api/vision/analyze': '/api/extension/analyze',
            ...Object.fromEntries(['query', 'present', 'entry', 'outcome'].map(action => [`/api/vision/journal/${action}`, `/api/extension/journal/${action}`])) };
        if (!Object.hasOwn(endpoints, path)) throw new Error('Unsupported backend request.');
        const auth = await credentials();
        if (path === '/api/vision/analyze') {
            const latest = await selectedTab();
            if (!activeStream || !activeStream.getVideoTracks().some(track => track.readyState === 'live') ||
                !target || latest.id !== target.id || latest.selectedAt !== target.selectedAt) {
                stopCapture(); throw new Error('Selected capture is no longer active.');
            }
        }
        if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const headers = new Headers(options.headers);
        headers.delete('X-Vision-Token'); headers.set('X-Extension-Token', auth.token);
        const statusRequest = path === '/api/vision/status';
        if (statusRequest) headers.set('Content-Type', 'application/json');
        let response;
        try {
            response = await localFetch(endpoints[path], { ...options, headers,
                ...(statusRequest ? { method: 'POST', body: '{}' } : {}) });
        } catch (error) {
            if (!options.signal?.aborted) publish('offline', 'Local service unavailable. Start the dashboard, then Retry.');
            throw error;
        }
        if (response.status === 403) {
            stopCapture(); await chrome.storage.local.remove('backendAuth');
            publish('needs-approval', 'Connection needs approval. Press Connect; no codes required.');
        } else if (response.ok) publish('connected', 'Connected');
        else if (statusRequest) publish('offline', 'Local service needs attention. Restart the dashboard, then Retry.');
        return response;
    }
    async function finishConnection(pending) {
        publish('approving', 'Approve the connection in the local tab.');
        while (Date.now() < pending.expiresAt) {
            const response = await localFetch('/api/extension/claim', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: pending.secret }) });
            const result = await response.json();
            if (response.status === 200) {
                if (typeof result.access_token !== 'string' || result.expires_in !== 2592000) throw new Error('Unexpected connection response. Update the local server.');
                await chrome.storage.local.set({ backendAuth: { token: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 } });
                await chrome.storage.session.remove('pendingConnection');
                const { target: selected } = await chrome.storage.session.get('target');
                if (selected && selected.id === pending.targetId) {
                    try {
                        const tab = await chrome.tabs.get(selected.id);
                        if (allowed(tab.url) && new URL(tab.url).origin === selected.origin) await chrome.tabs.update(selected.id, { active: true });
                    } catch {}
                }
                publish('connected', 'Connected. Preparing chart preview…');
                window.dispatchEvent(new Event('chart-backend-connected'));
                return;
            }
            if (response.status !== 202) throw new Error(result.reason || 'Connection request rejected. Try Connect again.');
            await sleep(1200);
        }
        throw new Error('Approval request timed out. Press Connect to try again.');
    }
    function connect() {
        if (connecting) return connecting;
        stopCapture();
        connecting = (async () => {
            const { pendingConnection: existing, target: selected } = await chrome.storage.session.get(['pendingConnection', 'target']);
            let pending = existing;
            if (!pending || pending.expiresAt <= Date.now()) {
                const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
                const requestHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))));
                pending = { secret, requestHash, expiresAt: Date.now() + 120000, targetId: selected?.id };
                await chrome.storage.session.set({ pendingConnection: pending });
            }
            publish('approving', 'Approve the connection in the local tab.');
            await chrome.tabs.create({ url: `${backend}/extension-pair?extension_id=${chrome.runtime.id}&request=${pending.requestHash}` });
            await finishConnection(pending);
        })().catch(async error => {
            await chrome.storage.session.remove('pendingConnection');
            publish('needs-approval', error.name === 'TypeError' || error.name === 'AbortError' ?
                'Could not reach the local service. Start the dashboard, then Connect again.' : error.message);
        }).finally(() => { connecting = null; });
        return connecting;
    }
    async function disconnect() {
        stopCapture();
        try {
            const auth = await credentials();
            const response = await localFetch('/api/extension/revoke', { method: 'POST', headers: { 'X-Extension-Token': auth.token } });
            if (!response.ok) throw new Error('Revocation failed.');
            await chrome.storage.local.remove('backendAuth');
            publish('needs-approval', 'Disconnected. Access revoked.');
        } catch {
            publish('offline', 'Could not revoke access. Retry when the local service is running.');
        }
        window.dispatchEvent(new Event('chart-backend-connected'));
    }
    const notificationIds = new Set();
    let notificationGeneration = 0;
    async function loadAlertPreferences() {
        const { chartAlertPreferences } = await chrome.storage.local.get('chartAlertPreferences');
        return chartAlertPreferences;
    }
    async function saveAlertPreferences(value) {
        await chrome.storage.local.set({ chartAlertPreferences: ChartAlerts.preferences(value) });
    }
    async function desktopPermissionGranted() {
        return !!chrome.notifications && await chrome.permissions.contains({ permissions: ['notifications'] }) &&
            await chrome.notifications.getPermissionLevel() === 'granted';
    }
    function requestDesktopPermission() {
        return chrome.permissions.request({ permissions: ['notifications'] }).then(granted => granted && desktopPermissionGranted());
    }
    function clearDesktopAlerts() {
        notificationGeneration++;
        for (const id of notificationIds) chrome.notifications?.clear(id).catch(() => {});
        notificationIds.clear();
    }
    async function sendDesktopAlert(cue, stillCurrent, test = false) {
        const generation = notificationGeneration;
        const fresh = () => generation === notificationGeneration && stillCurrent() && (test ||
            (cue && ['BUY', 'SELL'].includes(cue.direction) && typeof cue.asset === 'string' && cue.asset.length <= 80 &&
             Number.isFinite(cue.captured_at) && Number.isFinite(cue.expires_at) && Date.now() >= cue.captured_at &&
             Date.now() < cue.expires_at && cue.expires_at <= cue.captured_at + 20000));
        if (!fresh() || !await desktopPermissionGranted()) return false;
        if (!fresh()) return false;
        const id = `chart-cue-${crypto.randomUUID()}`;
        const expiresAt = test ? Date.now() + 4000 : cue.expires_at;
        const title = test ? 'TEST notification — no trading signal' : `${cue.direction} · ${cue.asset.replace(/[\r\n]/g, ' ')}`;
        const message = test ? 'Notification setup check. No chart was scanned and no AI request was made.' :
            `2-minute demo opinion. Read ${new Date(cue.captured_at).toLocaleTimeString()}; stale after ${new Date(cue.expires_at).toLocaleTimeString()}. Check the live panel before acting.`;
        notificationIds.add(id);
        try {
            await chrome.notifications.create(id, { type: 'basic', iconUrl: chrome.runtime.getURL('icon128.png'),
                title, message, requireInteraction: false, silent: true, eventTime: test ? Date.now() : cue.captured_at });
            if (!fresh()) { await chrome.notifications.clear(id); notificationIds.delete(id); return false; }
            const armed = await chrome.runtime.sendMessage({ type: 'armAlertExpiry', id, expiresAt });
            if (!armed?.ok || !fresh()) { await chrome.notifications.clear(id); notificationIds.delete(id); return false; }
            setTimeout(() => { chrome.notifications.clear(id).catch(() => {}); notificationIds.delete(id); }, Math.max(0, expiresAt - Date.now()));
            return true;
        } catch (error) {
            notificationIds.delete(id); chrome.notifications.clear(id).catch(() => {}); throw error;
        }
    }
    window.ChartBridge = { capture, request, connect, disconnect, layout: () => layout, state: () => ({ ...view }),
        loadAlertPreferences, saveAlertPreferences, desktopPermissionGranted, requestDesktopPermission, sendDesktopAlert, clearDesktopAlerts };
    setInterval(inspectLayout, 2000);
    chrome.tabs.onUpdated.addListener((tabId, change) => { if (target?.id === tabId && (change.status === 'loading' || change.url)) stopCapture(); });
    chrome.tabs.onRemoved.addListener(tabId => { if (target?.id === tabId) stopCapture(); });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.target) {
            stopCapture(); view.hasTarget = !!changes.target.newValue;
            window.dispatchEvent(new Event('chart-bridge-state'));
            if (view.hasTarget) window.dispatchEvent(new Event('chart-target-selected'));
        }
        if (area === 'local' && changes.backendAuth && !changes.backendAuth.newValue) stopCapture();
    });
    window.addEventListener('pagehide', stopCapture);
    (async () => {
        await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        const { target: selected, pendingConnection } = await chrome.storage.session.get(['target', 'pendingConnection']);
        view.hasTarget = !!selected;
        if (pendingConnection && pendingConnection.expiresAt > Date.now()) {
            connecting = finishConnection(pendingConnection).catch(error => publish('needs-approval', error.message)).finally(() => { connecting = null; });
        } else {
            try { await credentials(); if (view.connection === 'checking') publish('checking', 'Checking saved connection…'); }
            catch { publish('needs-approval', 'Connect once to enable chart analysis.'); }
        }
    })().catch(() => publish('needs-approval', 'Press Connect to initialize the extension.'));
})();
