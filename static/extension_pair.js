(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const meta = name => document.querySelector(`meta[name="${name}"]`).content;
    const token = meta('vision-token'), extensionId = meta('extension-id'), requestHash = meta('connection-request');
    async function post(path, payload) {
        const response = await fetch(path, { method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'X-Vision-Token': token }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.reason || 'Connection unavailable. Reload this page and retry.');
        return result;
    }
    const valid = /^[a-p]{32}$/.test(extensionId) && /^[0-9a-f]{64}$/.test(requestHash);
    $('approveExtension').disabled = !valid;
    if (!valid) $('pairStatus').textContent = 'Open the extension and press Connect to start a connection request. You can still revoke existing access below.';
    $('approveExtension').addEventListener('click', async () => {
        $('approveExtension').disabled = true;
        try {
            await post('/api/extension/approve', { extension_id: extensionId, request_hash: requestHash });
            $('approveExtension').textContent = 'Approved';
            $('pairStatus').textContent = 'Approved. The extension connects automatically. Return to your Pocket Option tab if it does not switch back by itself.';
        } catch (error) { $('pairStatus').textContent = error.message; $('approveExtension').disabled = false; }
    });
    $('revokeExtension').addEventListener('click', async () => {
        try { await post('/api/extension/revoke', {}); $('pairStatus').textContent = 'Extension access revoked.'; }
        catch (error) { $('pairStatus').textContent = error.message; }
    });
})();
