(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const bridge = window.ChartBridge, engine = window.ChartAssistant;
    let autoPreview = true, queued = false, action = 'none', shownPreviewKey = null;
    function schedule() {
        if (queued) return;
        queued = true;
        Promise.resolve().then(() => { queued = false; render(); });
    }
    function render() {
        const connection = bridge.state(), state = engine.state(), button = $('mainAction');
        const remaining = state.cooldownRemaining || 0;
        const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
        let phase = 'ready', headline = 'LOCAL DETECTION', label = 'Preview chart', hint = 'Local detection is free. Only SCAN sends images.';
        action = 'preview'; button.disabled = false;
        if (connection.connection === 'needs-approval') {
            phase = 'needs-approval'; headline = 'CONNECT ONCE'; label = 'Connect & detect'; action = 'connect';
            hint = 'One local approval. No API key or code to copy.'; $('reason').textContent = connection.message;
        } else if (connection.connection === 'offline') {
            phase = 'offline'; headline = 'SERVICE OFFLINE'; label = 'Retry connection'; action = 'retry';
            hint = 'Keep the local dashboard running.'; $('reason').textContent = connection.message;
        } else if (connection.connection === 'approving') {
            phase = 'approving'; headline = 'ONE-TIME APPROVAL'; label = 'Waiting for approval…'; action = 'none'; button.disabled = true;
            hint = 'Approve in the local tab. No chart analysis starts automatically.';
            $('reason').textContent = 'The chart preview opens after approval. Press SCAN only when you want an assessment.';
        } else if (state.pauseKind === 'setup' && !state.initialized && connection.connection !== 'checking') {
            phase = 'error'; headline = 'SETUP NEEDS ATTENTION'; label = 'Recheck setup'; action = 'retry';
            hint = 'Update/restart the local service before scanning.'; $('reason').textContent = state.pauseReason;
        } else if (connection.connection === 'checking' || !state.initialized) {
            phase = 'checking'; headline = 'CONNECTING'; label = 'Checking connection…'; action = 'none'; button.disabled = true;
            hint = 'Checking your saved approval.';
        } else if (!state.configured) {
            phase = 'error'; headline = 'API SETUP NEEDED'; label = 'Recheck setup'; action = 'retry';
            hint = 'The API key belongs on the local server.';
        } else if (!connection.hasTarget && !state.capturing) {
            phase = 'select'; headline = 'SELECT YOUR CHART'; label = 'Choose a chart tab'; action = 'none'; button.disabled = true;
            hint = 'Open Pocket Option, then click this extension’s icon.';
            $('reason').textContent = 'Only the selected chart tab is inspected.';
        } else if (state.running || state.pending) {
            phase = 'running'; headline = state.collecting ? 'CAPTURING TWO FRAMES' : 'READING THIS SCAN';
            label = 'Scanning…'; action = 'none'; button.disabled = true;
            hint = 'One assessment cycle. No automatic follow-up scans.';
        } else if (state.waitingForFrames || (state.capturing && !state.previewReady)) {
            phase = 'waiting'; headline = 'WAITING FOR CHART'; label = 'Waiting for fresh frames'; action = 'none'; button.disabled = true;
            hint = 'Local capture stays active. SCAN becomes available when the chart is readable.';
        } else if (state.previewReady) {
            phase = state.hasAssessment ? 'result' : state.hasApproval ? 'ready' : 'preview';
            headline = state.hasAssessment ? 'ASSESSMENT READY' : state.scanOutcome === 'expired' ? 'RESULT EXPIRED' : 'READY TO SCAN';
            label = 'SCAN'; action = 'start';
            hint = state.hasApproval ? 'One click, one AI request. Switching pairs never triggers a paid scan.' :
                'SCAN approves the preview and sends two fresh cropped frames for paid analysis.';
            if (remaining > 0) {
                label = `SCAN in ${countdown}`; action = 'none'; button.disabled = true;
                hint = 'Wait for the countdown, then press SCAN. It will not restart automatically.';
                if (!state.hasAssessment && state.cooldownReason) {
                    phase = 'cooldown'; headline = 'API COOLDOWN'; $('reason').textContent = state.cooldownReason;
                }
            } else if (!state.hasAssessment && state.pauseReason) $('reason').textContent = state.pauseReason;
        } else if (state.status === 'error') {
            phase = 'error'; headline = 'CAPTURE NEEDS ATTENTION'; label = 'Retry preview';
            hint = 'Keep the selected chart active to start capture.';
        }
        document.body.dataset.phase = phase;
        document.body.dataset.reading = String(state.running || state.pending);
        $('viewState').textContent = headline;
        $('connectionBadge').textContent = connection.connection === 'connected' ? 'MANUAL SCAN' : connection.connection === 'offline' ? 'OFFLINE' : 'SETUP';
        button.textContent = label; $('actionHint').textContent = hint;
        const showPreview = state.previewReady && !state.hasApproval && !state.running && !state.pending;
        $('previewCard').hidden = !showPreview;
        shownPreviewKey = state.previewReady ? state.previewKey : null;
        $('stopAction').hidden = !state.capturing && !state.choosing;
        $('disconnectBackend').disabled = connection.connection !== 'connected';
        $('candleMetric').textContent = state.localIdentity?.timeframe || state.timeframe;
        $('expiryMetric').textContent = `${state.expiry}m`;
        $('timeMetricLabel').textContent = state.running || state.pending ? 'READING' : state.signalAge !== null ? 'SIGNAL AGE' : remaining ? 'SCAN IN' : 'SCAN MODE';
        $('timeMetric').textContent = state.running || state.pending ? `${Math.floor(state.elapsed)}s` : state.signalAge !== null ? `${Math.floor(state.signalAge)}s` : remaining ? countdown : 'Manual';
        $('detectionStatus').textContent = state.localIdentity?.asset ? `Locally detected: ${state.localIdentity.asset}${state.localIdentity.timeframe ? ` · ${state.localIdentity.timeframe}` : ''}` :
            state.capturing ? 'Chart detected. Pair/timeframe will be read during SCAN where labels are not exposed locally.' : 'Select a chart to detect its layout.';
        const score = state.readiness;
        $('setupPercent').textContent = score?.percent === 0 || score?.percent ? `${score.percent}%` : '—';
        $('setupProgress').value = score?.percent ?? 0;
        $('setupCount').textContent = score && score.percent !== null ? `${score.passed} of ${score.total} setup conditions matched` : 'Rule match unavailable until a readable scan';
        $('directionBias').textContent = score?.bias && score.bias !== 'WAIT' ? `Directional bias: ${score.bias} (not an entry instruction)` : 'Directional bias: unclear';
        $('entryTiming').textContent = state.entryTiming || 'SCAN to assess the current setup.';
        $('miniStatus').textContent = state.capturing ? `${state.captureAge < 2500 ? 'Local frames live' : 'Waiting for frames'} · ${state.calls} scan attempts${state.lastDuration === null ? '' : ` · last ${state.lastDuration.toFixed(1)}s`}` : '';
        if (autoPreview && connection.connection === 'connected' && connection.hasTarget && state.configured && !state.capturing && !state.choosing) {
            autoPreview = false; engine.preview();
        }
    }
    $('mainAction').addEventListener('click', () => {
        if ($('mainAction').disabled) return;
        if (action === 'connect') { autoPreview = true; bridge.connect(); }
        else if (action === 'retry') { autoPreview = true; engine.retry(); }
        else if (action === 'preview') { autoPreview = false; engine.preview(); }
        else if (action === 'start' && shownPreviewKey) engine.approveAndStart(shownPreviewKey);
        schedule();
    });
    $('stopAction').addEventListener('click', () => { autoPreview = false; engine.stop(); schedule(); });
    $('disconnectBackend').addEventListener('click', () => { autoPreview = false; bridge.disconnect(); });
    window.addEventListener('chart-assistant-state', schedule);
    window.addEventListener('chart-bridge-state', schedule);
    window.addEventListener('chart-backend-connected', () => { autoPreview = true; schedule(); });
    window.addEventListener('chart-target-selected', () => { autoPreview = true; schedule(); });
    render();
})();
