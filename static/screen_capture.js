(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const video = $('video'), preview = $('preview');
    const ctx = preview.getContext('2d', { willReadFrequently: true });
    const header = document.createElement('canvas'); header.width = 96; header.height = 24;
    const hc = header.getContext('2d', { willReadFrequently: true });
    const token = document.querySelector('meta[name="vision-token"]').content;
    const bridge = window.ChartBridge;
    const apiFetch = (url, options) => bridge ? bridge.request(url, options) : fetch(url, options);
    let settings = null, stream = null, generation = 0, chartVersion = 0, frameAt = 0;
    let running = false, pending = null, current = null, assessment = null, scanReference = null;
    let scanOutcome = 'idle', localIdentity = null, lastIdentityKey = null;
    let lastHeader = null, shape = '', lastTick = performance.now();
    const tones = new ChartAlerts.TonePlayer(() => new AudioContext());
    const alertGate = new ChartAlerts.AlertGate();
    let preferenceRevision = 0, preferenceWrites = Promise.resolve(), soundAction = 0, desktopAction = 0;
    let calls = 0, choosing = false, requestStarted = 0, lastDuration = null;
    const records = [];
    const candleClock = new ScreenAnalysis.CandleClock();
    let framingMode = 'preset', candleReading = { ready: false, closedAt: null };
    let lastDetected = false, waitingForLayout = false;
    let retryNotBefore = 0, journalLoading = false, journalRefreshQueued = false;
    let pauseInfo = null, cooldownReason = '';
    const notify = () => window.dispatchEvent?.(new Event('chart-assistant-state'));
    const strategyConfig = () => settings?.strategies?.[$('strategy').value];
    const freshResult = (result, capturedAt, frameAge, sameChart) => !!stream && !stream.getVideoTracks()[0].muted && ScreenAnalysis.freshCloudResult(
        result, capturedAt, Date.now(), frameAge, sameChart, $('strategy').value,
        strategyConfig()?.candle_timeframe, settings?.expiry_minutes);

    function strategyInfo() {
        const selected = strategyConfig();
        $('strategyInfo').textContent = selected ?
            `${selected.label}: ${selected.candle_timeframe} candles; ${settings.expiry_minutes}-minute manual expiry. Set this duration on Pocket Option yourself.` : 'Checking available strategies…';
        $('strategyRules').textContent = !selected ? '' : $('strategy').value === 'aroon_osma' ?
            `Aroon 10 (Up turquoise, Down red) + OsMA 10/20/10. Between the last two completed candles: BUY needs Up crossing above Down by at least ${settings.aroon_min_gap} points, with OsMA positive and increasing. SELL needs the opposite cross and gap, with OsMA negative and decreasing. Touches and old crosses do not qualify. Values are visual estimates, not a candle-feed calculation.` :
            'A trend pullback or tested range rejection, supported by price structure and a readable momentum indicator. AI interpretation, not a fixed numerical trading system.';
    }
    function cancelAlertDelivery() {
        soundAction++; tones.cancel();
        bridge?.clearDesktopAlerts?.();
    }
    function wait(reason) {
        if (current) cancelAlertDelivery();
        current = null; assessment = null;
        $('analysisState').textContent = 'WAIT'; $('analysisState').dataset.state = 'wait';
        $('direction').textContent = 'WAIT'; $('direction').dataset.value = 'WAIT';
        $('reason').textContent = reason; $('logTrade').disabled = true;
        $('observations').replaceChildren(); $('ruleChecks').replaceChildren(); $('invalidation').textContent = ''; $('readings').textContent = '';
        notify();
    }
    function technicalError(reason) {
        wait(reason);
        $('analysisState').textContent = 'TECHNICAL ERROR'; $('analysisState').dataset.state = 'error';
        notify();
    }
    function timing() {
        const limited = performance.now() < retryNotBefore;
        const progress = pending ? `Reading chart: ${((performance.now() - requestStarted) / 1000).toFixed(1)}s elapsed.` :
            running ? 'Collecting two fresh frames for this scan.' : limited ? `Next manual scan available in ${Math.ceil((retryNotBefore - performance.now()) / 1000)}s.` :
            'Manual mode. No paid request until SCAN.';
        $('requestStatus').textContent = `${progress} Attempts: ${calls}.${lastDuration === null ? '' : ` Last attempt: ${lastDuration.toFixed(1)}s.`}`;
        notify();
    }
    function controls() {
        $('strategy').disabled = !settings?.strategies;
        $('moreToolbar').disabled = !stream;
        $('share').disabled = !settings?.configured || !!stream || choosing;
        $('share').textContent = choosing ? 'Starting capture…' : bridge ? 'Watch selected chart' : 'Watch my chart';
        $('stop').disabled = !stream && !choosing;
        $('consent').disabled = !stream || !shape;
        $('start').disabled = !settings?.configured || !strategyConfig() || !stream || !shape || !$('consent').checked || running || !!pending || performance.now() < retryNotBefore;
        $('pause').disabled = !running;
        notify();
    }
    function invalidate(reason) {
        chartVersion++; running = false; scanReference = null; scanOutcome = 'idle'; cancelAlertDelivery();
        if (pending) pending.abort();
        wait(reason); controls();
    }
    function pause(reason, kind = 'paused') {
        pauseInfo = { kind, reason };
        running = false; invalidate(reason); controls();
    }
    function cooldown(reason, retryAfter) {
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 30;
        cooldownReason = reason;
        retryNotBefore = performance.now() + seconds * 1000;
        running = false; scanReference = null; scanOutcome = 'cooldown';
        wait(reason);
        $('analysisState').textContent = 'API COOLDOWN'; $('analysisState').dataset.state = 'cooldown';
        controls();
    }
    function stop() {
        generation++; alertGate.reset();
        const old = stream; stream = null;
        if (old) old.getTracks().forEach(t => t.stop());
        video.srcObject = null;
        shape = ''; lastHeader = null; frameAt = 0; localIdentity = null; lastIdentityKey = null;
        candleClock.reset(); candleReading = { ready: false, closedAt: null };
        lastDetected = false; waitingForLayout = false;
        $('consent').checked = false;
        pause(choosing && !old ? 'Capture cancelled. Close the browser sharing chooser before trying again. No images sent.' :
            'Sharing stopped. No further images will be sent. A request already sent may still be billed.', 'stopped');
        ctx.clearRect(0, 0, preview.width, preview.height);
        $('captureStatus').textContent = 'Not sharing.';
        $('assetName').textContent = 'No chart identified';
        $('freshness').textContent = 'No live capture.';
    }
    async function checkSetup() {
        try {
            const response = await apiFetch('/api/vision/status', { cache: 'no-store' });
            if (!response.ok) throw new Error('Local setup check failed.');
            settings = await response.json();
            if (settings.scan_mode !== 'manual' || settings.scan_protocol !== 2 || settings.expiry_minutes !== 2 || !settings.strategies?.aroon_osma || !settings.strategies?.trend_range) {
                throw new Error('Server settings are out of date. Restart the dashboard and reload this page.');
            }
            const selected = $('strategy').value;
            $('strategy').replaceChildren();
            for (const [id, strategy] of Object.entries(settings.strategies)) {
                const option = document.createElement('option'); option.value = id;
                option.textContent = `${strategy.label} — ${strategy.candle_timeframe}`;
                $('strategy').appendChild(option);
            }
            $('strategy').value = Object.hasOwn(settings.strategies, selected) ? selected : settings.default_strategy;
            strategyInfo();
            if (settings.journal_enabled) refreshJournal();
            $('setupStatus').textContent = settings.configured ?
                `Manual scan: two fresh cropped frames in one ${settings.model} request per click. At least ${settings.min_scan_interval_seconds}s between requests; maximum ${settings.max_calls_per_hour}/hour. Local detection makes no paid calls.` :
                'Setup required: add OPENAI_API_KEY to the local .env file and restart the dashboard. No paid requests can run yet.';
            $('setupHelp').open = !settings.configured;
            if (settings.configured && !stream && !choosing) wait(bridge ? 'Connected. Select your Pocket Option tab with the extension icon, then Watch selected chart.' : 'Ready. Click Watch my chart to preview your chart.');
        } catch (error) {
            settings = null; $('setupStatus').textContent = error.message;
            pause('Setup unavailable. Recheck the local server before restarting analysis.', 'setup');
            if (bridge && ['needs-approval', 'approving'].includes(bridge.state().connection)) wait(bridge.state().message);
            else technicalError(bridge ? bridge.state().message : error.message);
            strategyInfo();
        }
        controls();
    }
    function captureFailure(name) {
        const reasons = {
            NotAllowedError: 'Sharing was cancelled or blocked. Open Pocket Option in the same browser profile as this page. Click Watch my chart, choose the Pocket Option tab under Microsoft Edge Tab or Chrome Tab, then click Share. If the chooser never opens, check browser permission or administrator restrictions; this page cannot override them.',
            InvalidStateError: 'Bring this assistant page into focus, then click Watch my chart directly. Close any other sharing chooser first.',
            NotReadableError: 'The browser or operating system could not capture the selected tab. Close other capture sessions, reopen the Pocket Option tab, and retry. If it persists, check browser or operating-system restrictions.',
            NotFoundError: 'No shareable tab was found. Open Pocket Option in a normal tab in this same browser profile, then retry.',
            AbortError: 'The browser interrupted capture. Close the sharing chooser and click Watch my chart again.',
            TypeError: 'The browser rejected the capture options. Please update Chrome or Edge and retry from localhost.',
            TabRequiredError: 'Select the Pocket Option browser TAB, not a window or entire screen. If it is missing, open it in this same browser profile.',
            UnsupportedBrowser: 'Use current desktop Chrome or Edge on localhost with browser-tab sharing. This browser does not provide the required capture features.',
            InsecureContext: 'Open this assistant on localhost in a normal Chrome or Edge tab. Capture requires a secure browser context.',
            PreviewError: 'The tab was selected, but its video preview could not start. Reload this assistant page and share the tab again.',
            CaptureError: 'Browser capture could not start. Reload this page, use current Chrome or Edge, and follow the sharing steps below.'
        };
        const code = Object.hasOwn(reasons, name) ? name : 'CaptureError';
        technicalError(bridge ? 'Chart capture could not start. Keep the Pocket Option tab active, click the extension icon on it, then retry Watch selected chart.' : reasons[code]);
        $('captureStatus').textContent = `Capture status: ${code}. No chart images uploaded by this attempt.`;
        $('captureHelp').open = true;
    }
    async function share() {
        if (!settings?.configured || choosing || stream) return;
        stop();
        if (!window.isSecureContext) { captureFailure('InsecureContext'); return; }
        if ((!bridge && !navigator.mediaDevices?.getDisplayMedia) || !video.requestVideoFrameCallback) {
            captureFailure('UnsupportedBrowser'); return;
        }
        if (!bridge && !document.hasFocus()) { captureFailure('InvalidStateError'); return; }
        const session = generation;
        choosing = true; controls();
        wait(bridge ? 'Starting the selected chart preview. Nothing is uploaded until you approve it.' : 'Choose Microsoft Edge Tab or Chrome Tab, select Pocket Option, then click Share. Do not select this assistant.');
        $('captureStatus').textContent = 'Waiting for browser permission. No chart images uploaded by this attempt.';
        try {
            const selected = bridge ? await bridge.capture() : await navigator.mediaDevices.getDisplayMedia({
                video: { displaySurface: 'browser', frameRate: { ideal: 3, max: 5 } },
                audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude'
            });
            if (session !== generation) { selected.getTracks().forEach(t => t.stop()); return; }
            const track = selected.getVideoTracks()[0];
            if (!track || (!bridge && track.getSettings().displaySurface !== 'browser')) {
                selected.getTracks().forEach(t => t.stop());
                throw Object.assign(new Error(), { name: 'TabRequiredError' });
            }
            stream = selected; frameAt = 0;
            track.addEventListener('ended', stop, { once: true });
            video.srcObject = selected;
            const onFrame = () => {
                if (stream !== selected) return;
                const firstFrame = !frameAt;
                frameAt = performance.now();
                if (firstFrame && video.videoWidth) drawFrame();
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
            await video.play();
            if (session !== generation) return;
            $('captureHelp').open = false;
            $('captureStatus').textContent = 'Preview only. Check the crop, approve cloud upload below, then start. No image sent yet.';
        } catch (error) {
            if (session === generation) {
                const code = stream ? 'PreviewError' : error.name;
                stop(); captureFailure(code);
            }
        } finally {
            choosing = false; controls();
        }
    }
    function drawFrame() {
        const now = performance.now(), report = bridge?.layout?.();
        const reportFresh = report && Number.isFinite(report.seenAt) && Date.now() - report.seenAt >= 0 && Date.now() - report.seenAt <= 6000;
        if (reportFresh && report.blocked) {
            shape = ''; $('consent').checked = false;
            pause('Close the dialog covering the chart, then approve the new preview.', 'preview');
            ctx.clearRect(0, 0, preview.width, preview.height); return false;
        }
        const detected = $('autoFrame').checked ? ScreenAnalysis.chartDomCrop(video.videoWidth, video.videoHeight, report, Date.now(), $('moreToolbar').checked) : null;
        waitingForLayout = $('autoFrame').checked && lastDetected && !detected;
        if (waitingForLayout) {
            candleClock.reset(); candleReading = { ready: false, closedAt: null };
            invalidate('Waiting for fresh chart-layout data. Monitoring will resume automatically with the approved crop.');
            return false;
        }
        lastDetected = !!detected;
        const bounds = detected || ScreenAnalysis.cloudCrop(video.videoWidth, video.videoHeight, $('moreToolbar').checked, !!bridge);
        framingMode = detected ? 'Chart boundaries detected' : 'Preset crop — verify framing';
        $('framingStatus').textContent = framingMode;
        candleReading = candleClock.update(reportFresh ? report.candleOpen : null, now, strategyConfig()?.candle_timeframe === '30s' ? 30 : 60);
        $('candleTiming').textContent = candleReading.ready ? 'Candle clock observed locally. Scans are still manual.' : 'Candle timing unavailable. No entry countdown is guessed.';
        localIdentity = reportFresh ? ScreenAnalysis.localIdentity(report.identity) : null;
        const identityKey = localIdentity ? JSON.stringify(localIdentity) : null;
        if (identityKey && lastIdentityKey && identityKey !== lastIdentityKey) invalidate('Selected pair or timeframe changed. Press SCAN for this chart.');
        if (identityKey) lastIdentityKey = identityKey;
        if (!assessment && !running) $('assetName').textContent = localIdentity?.asset || 'Chart detected — pair read during scan';
        if (!bounds) {
            if (shape) { shape = ''; $('consent').checked = false; pause('Unsupported layout. Use a standard desktop chart and approve the new preview.', 'preview'); }
            wait(`Enlarge the chart to at least ${bridge ? '600' : '900'} × 450 pixels. Narrow the side panel or maximize the browser.`); return false;
        }
        const newShape = `${video.videoWidth}:${video.videoHeight}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${!!detected}`;
        if (newShape !== shape) {
            const changed = !!shape;
            shape = newShape; lastHeader = null;
            $('consent').checked = false;
            pause(changed ? 'Chart framing changed. Uploads are paused until you approve the new crop.' :
                'Preview ready. Check that only your chart is included before starting.', 'preview');
            const scale = Math.min(1, 1280 / bounds.width);
            preview.width = Math.round(bounds.width * scale); preview.height = Math.round(bounds.height * scale);
            controls();
        }
        ctx.drawImage(video, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, preview.width, preview.height);
        hc.drawImage(preview, 0, 0, Math.min(250, preview.width), Math.min(50, preview.height), 0, 0, 96, 24);
        const pixels = hc.getImageData(0, 0, 96, 24).data;
        if (!(localIdentity?.asset && localIdentity?.timeframe) && lastHeader && ScreenAnalysis.headerChanged(lastHeader, pixels)) {
            invalidate('Chart header changed. Discarding old analysis and re-identifying the asset.');
            $('assetName').textContent = 'Re-identifying chart';
        }
        lastHeader = new Uint8ClampedArray(pixels);
        return true;
    }
    function alertPreferences() {
        return ChartAlerts.preferences({ sound: $('sound').checked, volume: Number($('soundVolume').value), desktop: $('desktopAlerts').checked });
    }
    function saveAlertPreferences() {
        const value = alertPreferences(); preferenceRevision++;
        preferenceWrites = preferenceWrites.catch(() => {}).then(async () => {
            if (bridge?.saveAlertPreferences) await bridge.saveAlertPreferences(value);
            else {
                if (!window.localStorage) throw new Error('Storage unavailable.');
                window.localStorage.setItem('chart-assistant.alerts.v1', JSON.stringify(value));
            }
        }).catch(() => { $('soundStatus').textContent = 'Preferences could not be saved. Current settings still work for this session.'; });
        return preferenceWrites;
    }
    async function loadAlertPreferences() {
        const revision = preferenceRevision;
        try {
            const saved = bridge?.loadAlertPreferences ? await bridge.loadAlertPreferences() :
                JSON.parse(window.localStorage?.getItem('chart-assistant.alerts.v1') || 'null');
            const value = ChartAlerts.preferences(saved);
            if (value.desktop && (!bridge?.desktopPermissionGranted || !await bridge.desktopPermissionGranted())) value.desktop = false;
            if (revision !== preferenceRevision) return;
            $('sound').checked = value.sound; $('soundVolume').value = String(value.volume);
            $('volumeValue').textContent = `${value.volume}%`; $('desktopAlerts').checked = value.desktop;
            $('testDesktop').disabled = !value.desktop || !bridge?.sendDesktopAlert;
            $('soundStatus').textContent = value.sound ? 'Sound saved. Start analysis or use a test tone to enable audio.' : 'Sound is off. Test tones work without scanning.';
        } catch { $('soundStatus').textContent = 'Saved preferences unavailable; using this session’s settings.'; }
    }
    async function prepareSound() {
        const revision = preferenceRevision;
        try {
            const ready = await tones.unlock();
            if (revision !== preferenceRevision || !$('sound').checked) return;
            $('soundStatus').textContent = ready ? 'Sound ready: BUY rises, SELL falls.' : 'Audio blocked. Click a test tone to retry.';
        } catch { $('soundStatus').textContent = 'Audio unavailable. Try a test tone and check Edge’s sound settings.'; }
    }
    async function testSound(direction) {
        const attempt = ++soundAction;
        try {
            await tones.unlock();
            if (attempt !== soundAction) return;
            const volume = alertPreferences().volume;
            const played = tones.play(direction, volume);
            $('soundStatus').textContent = played ? `TEST ${direction} tone played — not a trading signal.` :
                volume === 0 ? 'Volume is zero. Increase it to hear the test.' : 'Audio blocked. Check browser and Windows volume settings.';
        } catch { $('soundStatus').textContent = 'Test tone unavailable. Check browser audio permissions and Windows volume.'; }
    }
    function deliverAlert(cue) {
        const preferences = alertPreferences();
        const audible = preferences.sound && preferences.volume > 0 && tones.ready;
        if (!audible && !preferences.desktop) {
            if (preferences.sound && !tones.ready) $('soundStatus').textContent = 'Sound is not ready. Click a test tone to enable it; analysis continues.';
            return;
        }
        if (!alertGate.accept(cue, Date.now(), candleReading.ready ? candleClock.open : null)) return;
        let played = false;
        if (audible) {
            try { played = tones.play(cue.direction, preferences.volume); }
            catch { $('soundStatus').textContent = 'Sound could not play. Use a test tone to retry.'; }
        }
        if (preferences.desktop && bridge?.sendDesktopAlert) {
            bridge.sendDesktopAlert(cue, () => !!stream && current === cue && $('desktopAlerts').checked &&
                freshResult(cue, cue.captured_at, performance.now() - frameAt, cue.version === chartVersion))
                .then(shown => {
                    if (shown) $('desktopStatus').textContent = 'Notification sent. Always check the live panel before acting.';
                    else if (!played) alertGate.deliveryFailed(cue);
                })
                .catch(() => {
                    if (!played) alertGate.deliveryFailed(cue);
                    $('desktopStatus').textContent = 'Desktop notification unavailable. Check Edge/Windows notification settings.';
                });
        } else if (!played) alertGate.deliveryFailed(cue);
    }
    function show(result) {
        assessment = result; scanOutcome = 'complete';
        $('assetName').textContent = bridge ? result.asset || 'Unidentified chart' : `${result.asset || 'Unidentified asset'} — ${result.market_type || 'unknown'} (AI-read; verify)`;
        $('direction').textContent = result.direction; $('direction').dataset.value = result.direction;
        $('analysisState').textContent = 'ANALYSIS RECEIVED'; $('analysisState').dataset.state = 'ready';
        $('reason').textContent = result.reason;
        $('observations').replaceChildren();
        $('ruleChecks').replaceChildren();
        for (const check of result.checks || []) {
            const item = document.createElement('li');
            item.dataset.status = ['pass', 'fail', 'unknown'].includes(check.status) ? check.status : 'unknown';
            const label = { pass: 'Passed', fail: 'Not met', unknown: 'Unreadable' }[item.dataset.status];
            item.textContent = `${check.label}: ${label}${check.detail ? ` — ${check.detail}` : ''}`;
            $('ruleChecks').appendChild(item);
        }
        for (const observation of result.observations || []) {
            const li = document.createElement('li'); li.textContent = observation; $('observations').appendChild(li);
        }
        $('invalidation').textContent = result.invalidation ? `Invalidation: ${result.invalidation}` : '';
        const evidence = result.aroon_osma;
        const number = value => Number.isFinite(value) ? String(value) : 'unreadable';
        $('readings').textContent = evidence ?
            `Visual estimates (previous → latest completed candle): Aroon Up ${number(evidence.up_previous)} → ${number(evidence.up_latest)}; Down ${number(evidence.down_previous)} → ${number(evidence.down_latest)}; OsMA ${number(evidence.osma_previous)} → ${number(evidence.osma_latest)}. Verify against your chart.` : '';
        notify();
    }
    async function analyze() {
        const now = performance.now(), reference = scanReference;
        if (!running || pending || !reference) return;
        if (now - reference.at > 2500) { pause('No second fresh frame arrived. Wait for chart movement and press SCAN again.'); return; }
        if (now - reference.at < 700 || frameAt <= reference.frameAt) return;
        if (now - frameAt > 2500 || stream.getVideoTracks()[0].muted || !drawFrame()) return;
        if (!running || scanReference !== reference || !$('consent').checked || now < retryNotBefore) return;
        const image = preview.toDataURL('image/jpeg', 0.82);
        if (image.length + reference.image.length > 2000000) { pause('The two frames are too large. Reduce the shared chart size and approve the new preview.'); return; }
        if (image === reference.image) { pause('Chart image unchanged. No AI request sent; wait for movement and SCAN again.'); return; }
        const capturedAt = Date.now(), session = generation, version = chartVersion, strategy = $('strategy').value;
        const ctl = new AbortController(); pending = ctl; scanReference = null;
        retryNotBefore = now + settings.min_scan_interval_seconds * 1000;
        requestStarted = now; scanOutcome = 'reading';
        calls++; wait('Reading this chart. One request; no automatic rescan.');
        $('analysisState').textContent = 'READING CHART'; $('analysisState').dataset.state = 'reading'; timing();
        const timeout = setTimeout(() => ctl.abort(), 19000);
        try {
            const response = await apiFetch('/api/vision/analyze', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vision-Token': token },
                body: JSON.stringify({ mode: 'manual', image, captured_at: capturedAt, reference_image: reference.image,
                    reference_captured_at: reference.capturedAt, consent: true, strategy }), signal: ctl.signal, cache: 'no-store'
            });
            const result = await response.json();
            if (result.journal_warning) $('journalStatus').textContent = result.journal_warning;
            if (session !== generation || version !== chartVersion || !running) return;
            if (!response.ok) {
                if (response.status === 429) cooldown(result.reason || 'API limit reached. Scan again after the countdown.', result.retry_after);
                else { pause(result.reason || 'Analysis unavailable. Press SCAN to retry when ready.', 'api'); technicalError(result.reason || 'Analysis unavailable.'); }
                return;
            }
            if (!drawFrame() || version !== chartVersion || !running) return;
            const frameAge = performance.now() - frameAt;
            if (Date.now() - capturedAt >= 20000 || frameAge >= 2500 || stream.getVideoTracks()[0].muted || result.captured_at !== capturedAt) {
                wait('Response arrived too late. Press SCAN for a fresh assessment.'); scanOutcome = 'expired'; return;
            }
            if (candleReading.ready && capturedAt < candleClock.open) {
                wait('A new candle opened while this scan was being read. Press SCAN again for the current setup.'); scanOutcome = 'expired'; return;
            }
            if (result.strategy !== strategy || result.expiry_minutes !== settings.expiry_minutes) {
                pause('Response settings do not match this scan. Reload the extension before retrying.', 'api'); return;
            }
            if (!ScreenAnalysis.identityMatches(localIdentity, result)) {
                wait('AI identity differs from the locally detected chart. No cue issued; check the pair and scan again.'); return;
            }
            if (!result.chart_readable || result.reference_verified !== true || result.candle_timeframe !== strategyConfig()?.candle_timeframe || !result.asset) {
                wait(result.reason || 'The two frames did not confirm a readable chart.'); show({ ...result, direction: 'WAIT' }); return;
            }
            if (result.direction === 'WAIT') { alertGate.observeWait(result, Date.now()); wait(result.reason); show(result); return; }
            if (!freshResult(result, capturedAt, frameAge, version === chartVersion)) {
                wait('Response failed freshness or chart checks. Press SCAN for a fresh assessment.'); return;
            }
            current = { ...result, version };
            if (result.analysis_id) {
                current.saved = journalPost('present', { analysis_id: result.analysis_id }).then(() => {
                    $('journalStatus').textContent = 'Displayed cue saved locally.'; refreshJournal(); return true;
                }).catch(error => { $('journalStatus').textContent = error.message; return false; });
            }
            show(result); $('logTrade').disabled = false; deliverAlert(current);
        } catch (error) {
            if (session === generation && version === chartVersion && running) technicalError(error.name === 'AbortError' ?
                'Scan timed out or was cancelled. Press SCAN to try again.' : 'Local API unavailable. No signal issued.');
        } finally {
            lastDuration = (performance.now() - requestStarted) / 1000;
            clearTimeout(timeout);
            if (pending === ctl) { pending = null; running = false; }
            controls();
        }
    }
    async function journalPost(action, payload) {
        const response = await apiFetch(`/api/vision/journal/${action}`, { method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Vision-Token': token }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.reason || 'Journal request failed. Record not confirmed saved.');
        return result;
    }
    async function refreshJournal() {
        if (!settings?.journal_enabled) return;
        if (journalLoading) { journalRefreshQueued = true; return; }
        journalLoading = true;
        try {
            const data = await journalPost('query', {}), summary = data.summary;
            $('journalSummary').textContent = `${summary.displayed_signals} displayed cues · ${summary.wins} wins / ${summary.losses} losses · ${summary.open} open. Win rate: ${summary.win_rate === null ? 'not available' : `${summary.win_rate}%`}. Net: ${summary.net_units.toFixed(2)} account units across ${summary.priced_results} priced results; ${summary.unpriced_results} unpriced.`;
            $('journalGroups').replaceChildren();
            for (const group of data.groups || []) {
                const item = document.createElement('li');
                item.textContent = `${group.strategy} · ${group.market_type}: ${group.wins}W / ${group.losses}L · ${group.net_units.toFixed(2)} units (${group.priced_results} priced results)`;
                $('journalGroups').appendChild(item);
            }
            $('trades').replaceChildren(); records.length = 0;
            for (const entry of data.entries) {
                const row = document.createElement('tr'), cells = Array.from({ length: 4 }, () => document.createElement('td'));
                cells[0].textContent = entry.asset; cells[1].textContent = entry.direction;
                cells[2].textContent = new Date(entry.entered_at).toLocaleString();
                if (entry.result !== 'open') cells[3].textContent = `${entry.result} (manual)${entry.pnl_minor === null ? ' — unpriced' : ` · ${(entry.pnl_minor / 100).toFixed(2)} units`}`;
                cells.forEach(cell => row.appendChild(cell)); $('trades').appendChild(row);
                records.push({ key: entry.analysis_id, id: entry.id, end: entry.expires_at, cell: cells[3], resolved: entry.result !== 'open' });
            }
            $('savedSignals').replaceChildren();
            for (const signal of data.signals) {
                const item = document.createElement('li');
                item.textContent = `${new Date(signal.captured_at).toLocaleString()} · ${signal.asset || 'Unknown chart'} · ${signal.direction} · ${signal.displayed_at ? 'displayed cue' : 'analysis only'} · ${signal.latency_ms}ms`;
                $('savedSignals').appendChild(item);
            }
            updateTrades();
        } catch (error) { $('journalStatus').textContent = error.message; }
        finally {
            journalLoading = false;
            if (journalRefreshQueued) { journalRefreshQueued = false; refreshJournal(); }
        }
    }
    async function addTrade() {
        if (!current || !freshResult(current, current.captured_at, performance.now() - frameAt, current.version === chartVersion)) return;
        if (records.some(r => r.key === (current.analysis_id || current.captured_at))) return;
        if (current.analysis_id) {
            const cue = current;
            $('logTrade').disabled = true;
            try {
                if (!await cue.saved) throw new Error('The displayed cue was not confirmed saved. No entry recorded.');
                await journalPost('entry', { analysis_id: cue.analysis_id,
                    stake: $('journalStake').value || null, payout_percent: $('journalPayout').value || null });
                $('journalStatus').textContent = 'Demo entry saved. The timer is an estimate; report the actual platform result.';
                await refreshJournal();
            } catch (error) { $('journalStatus').textContent = error.message; if (current === cue) $('logTrade').disabled = false; }
            return;
        }
        const row = document.createElement('tr'), cells = Array.from({ length: 4 }, () => document.createElement('td'));
        cells[0].textContent = current.asset; cells[1].textContent = current.direction; cells[2].textContent = new Date().toLocaleTimeString();
        cells.forEach(cell => row.appendChild(cell)); $('trades').prepend(row);
        records.push({ key: current.captured_at, end: Date.now() + current.expiry_minutes * 60000, cell: cells[3], resolved: false });
        $('logTrade').disabled = true;
    }
    function updateTrades() {
        for (const record of records) {
            if (record.resolved) continue;
            const remaining = Math.max(0, Math.ceil((record.end - Date.now()) / 1000));
            if (remaining) record.cell.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} — manual timer`;
            else if (!record.cell.querySelector('button')) {
                record.cell.textContent = 'Platform result: ';
                for (const result of ['Win', 'Loss', 'Tie / void']) {
                    const button = document.createElement('button'); button.textContent = result;
                    button.addEventListener('click', async () => {
                        if (!record.id) { record.resolved = true; record.cell.textContent = `${result} (manually reported)`; return; }
                        button.disabled = true;
                        try {
                            await journalPost('outcome', { entry_id: record.id, result: { Win: 'win', Loss: 'loss', 'Tie / void': 'void' }[result] });
                            $('journalStatus').textContent = 'Platform result saved as manually reported.'; await refreshJournal();
                        } catch (error) { $('journalStatus').textContent = error.message; button.disabled = false; }
                    });
                    record.cell.appendChild(button);
                }
            }
        }
    }
    $('share').addEventListener('click', share); $('stop').addEventListener('click', stop);
    $('checkSetup').addEventListener('click', checkSetup);
    $('strategy').addEventListener('change', () => {
        pause('Strategy changed. Check its required candle timeframe, then SCAN.', 'settings');
        strategyInfo();
    });
    function changeFraming() {
        $('consent').checked = false; shape = '';
        pause('Framing changed. Inspect the new preview for private information and approve it before restarting.', 'preview');
        if (stream && frameAt) drawFrame();
    }
    $('moreToolbar').addEventListener('change', changeFraming);
    $('autoFrame').addEventListener('change', changeFraming);
    $('consent').addEventListener('change', () => { if (!$('consent').checked) pause('Upload consent removed. Approve the chart preview before resuming.', 'preview'); controls(); });
    $('pause').addEventListener('click', () => pause('Uploads paused.'));
    $('logTrade').addEventListener('click', addTrade);
    $('refreshJournal').addEventListener('click', refreshJournal);
    $('soundVolume').value = '50'; $('volumeValue').textContent = '50%';
    $('desktopAlerts').disabled = !bridge?.requestDesktopPermission;
    $('testDesktop').disabled = true;
    $('sound').addEventListener('change', () => {
        soundAction++;
        saveAlertPreferences();
        if ($('sound').checked) prepareSound();
        else { tones.cancel(); $('soundStatus').textContent = 'Sound alerts off.'; }
    });
    $('soundVolume').addEventListener('input', () => {
        soundAction++; tones.cancel();
        $('volumeValue').textContent = `${alertPreferences().volume}%`;
        saveAlertPreferences();
    });
    $('testBuySound').addEventListener('click', () => testSound('BUY'));
    $('testSellSound').addEventListener('click', () => testSound('SELL'));
    $('desktopAlerts').addEventListener('change', async () => {
        const attempt = ++desktopAction; preferenceRevision++;
        if (!$('desktopAlerts').checked) {
            bridge?.clearDesktopAlerts?.(); $('testDesktop').disabled = true;
            $('desktopStatus').textContent = 'Desktop alerts off.'; saveAlertPreferences(); return;
        }
        try {
            const granted = await bridge.requestDesktopPermission();
            if (attempt !== desktopAction) return;
            $('desktopAlerts').checked = granted; $('testDesktop').disabled = !granted;
            $('desktopStatus').textContent = granted ? 'Desktop alerts enabled. Windows may hide them under Do Not Disturb.' : 'Notification permission was not granted. Sound alerts are independent.';
        } catch {
            if (attempt !== desktopAction) return;
            $('desktopAlerts').checked = false; $('testDesktop').disabled = true;
            $('desktopStatus').textContent = 'Could not enable notifications. No other setting was changed.';
        }
        saveAlertPreferences();
    });
    $('testDesktop').addEventListener('click', async () => {
        if (!$('desktopAlerts').checked || !bridge?.sendDesktopAlert) return;
        try {
            await preferenceWrites;
            const shown = await bridge.sendDesktopAlert(null, () => $('desktopAlerts').checked, true);
            $('desktopStatus').textContent = shown ? 'TEST notification sent — not a trading signal.' : 'Notification not shown. Check permissions and Windows settings.';
        } catch { $('desktopStatus').textContent = 'Test notification unavailable. Check notification permissions.'; }
    });
    loadAlertPreferences();
    function startAnalysis() {
        if ($('start').disabled || pending || !drawFrame() || !$('consent').checked || performance.now() - frameAt >= 2500 || stream.getVideoTracks()[0].muted) return;
        if (localIdentity?.timeframe && localIdentity.timeframe !== strategyConfig()?.candle_timeframe) {
            pause(`Detected ${localIdentity.timeframe} candles; this strategy requires ${strategyConfig()?.candle_timeframe}. No AI request sent.`, 'settings'); return;
        }
        if ($('sound').checked) prepareSound();
        running = true; pauseInfo = null; scanOutcome = 'collecting'; requestStarted = performance.now();
        wait('Collecting two fresh frames for your manual scan.');
        scanReference = { image: preview.toDataURL('image/jpeg', 0.82), at: performance.now(), capturedAt: Date.now(), frameAt };
        $('analysisState').textContent = 'PREPARING SCAN'; $('analysisState').dataset.state = 'reading';
        $('captureStatus').textContent = 'One scan requested. Local detection continues afterward; further uploads require another SCAN.';
        controls();
    }
    $('start').addEventListener('click', startAnalysis);
    setInterval(() => {
        updateTrades(); timing();
        const now = performance.now(), gap = now - lastTick; lastTick = now;
        if (cooldownReason && now >= retryNotBefore) { cooldownReason = ''; controls(); }
        if (!stream) return;
        if (gap > 3500) invalidate('Browser was paused. Local detection resumes with fresh frames; press SCAN for a new assessment.');
        if (!frameAt || now - frameAt > 2500 || stream.getVideoTracks()[0].muted) {
            invalidate('Waiting for fresh frames. Capture remains active; paid scans are manual.'); return;
        }
        if (!drawFrame()) return;
        if (assessment && (Date.now() >= assessment.expires_at || (candleReading.ready && assessment.captured_at < candleClock.open))) {
            wait('Assessment expired or its candle changed. Press SCAN for a fresh read.'); scanOutcome = 'expired';
        }
        controls();
        $('freshness').textContent = `Capture age: ${((now - frameAt) / 1000).toFixed(1)}s. ${current ? `Opinion age: ${((Date.now() - current.captured_at) / 1000).toFixed(1)}s.` : ''} Demo expiry: ${settings?.expiry_minutes ?? 'unavailable'} minutes; required candles: ${strategyConfig()?.candle_timeframe ?? 'unavailable'}.`;
        if (running) analyze();
    }, 1000);
    function uiState() {
        const now = performance.now();
        const captureAge = frameAt ? now - frameAt : Infinity;
        return { configured: !!settings?.configured, initialized: !!settings, capturing: !!stream, choosing,
            previewReady: !!stream && !!shape && captureAge < 2500 && !waitingForLayout && !stream.getVideoTracks()[0].muted, previewKey: `${generation}:${shape}`,
            waitingForFrames: !!stream && (captureAge >= 2500 || waitingForLayout || stream.getVideoTracks()[0].muted),
            running, pending: !!pending, collecting: running && !!scanReference, status: $('analysisState').dataset.state,
            hasApproval: $('consent').checked, hasAssessment: !!assessment, scanOutcome, localIdentity,
            readiness: assessment?.readiness || null, entryTiming: ScreenAnalysis.entryTiming(assessment, candleReading.ready ? candleClock.open : null, Date.now()),
            pauseKind: pauseInfo?.kind || null, pauseReason: pauseInfo?.reason || null,
            cooldownRemaining: Math.max(0, Math.ceil((retryNotBefore - now) / 1000)), cooldownReason,
            timeframe: strategyConfig()?.candle_timeframe || '30s', expiry: settings?.expiry_minutes || 2,
            nextIn: Math.max(0, Math.ceil((retryNotBefore - now) / 1000)), elapsed: Math.max(0, (now - requestStarted) / 1000),
            signalAge: current ? (Date.now() - current.captured_at) / 1000 : null, captureAge, calls, lastDuration, framingMode,
            candleAware: candleReading.ready };
    }
    window.ChartAssistant = {
        state: uiState, preview: share, stop, retry: checkSetup,
        approveAndStart(key) {
            const state = uiState();
            if (!state.previewReady || key !== state.previewKey || !state.configured || running || pending || performance.now() < retryNotBefore) return false;
            $('consent').checked = true; controls(); startAnalysis();
            return running;
        }
    };
    window.addEventListener('pagehide', stop);
    window.addEventListener('chart-capture-ended', stop);
    window.addEventListener('chart-backend-connected', checkSetup);
    checkSetup();
})();
