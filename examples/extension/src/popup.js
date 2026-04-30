/**
 * DappFence popup. On open, fetches `/sw-api/status` from the active
 * tab via `chrome.scripting.executeScript` so the request goes through
 * the page's service worker (the extension's own context wouldn't —
 * SW interception is scoped to the page's own clients).
 */

const elements = {
    badge: document.getElementById('state-badge'),
    details: document.getElementById('details'),
    appVersion: document.getElementById('app-version'),
    trustedFiles: document.getElementById('trusted-files'),
    verifications: document.getElementById('verifications'),
    activeBlocks: document.getElementById('active-blocks'),
    message: document.getElementById('message'),
};

const setBadge = (label, variant) => {
    elements.badge.textContent = label;
    elements.badge.className = `badge badge-${variant}`;
};

const setMessage = (text) => {
    if (text) {
        elements.message.textContent = text;
        elements.message.hidden = false;
    } else {
        elements.message.hidden = true;
    }
};

// Runs in the page's MAIN world. Defined at the top level so it can be
// serialized by `chrome.scripting.executeScript`.
function fetchSwStatus() {
    return fetch('/sw-api/status', { cache: 'no-store' })
        .then((res) =>
            res.ok
                ? res
                      .json()
                      .catch((err) => console.error('Failed to parse SW status response:', err))
                : null
        )
        .catch((err) => console.error('Failed to fetch SW status:', err));
}

const probeActiveTab = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
        return { reason: 'No active tab.' };
    }
    let url;
    try {
        url = new URL(tab.url);
    } catch {
        return { reason: 'Tab URL is not parseable.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { reason: 'DappFence only runs on http(s) pages.' };
    }
    try {
        const [injection] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            world: 'MAIN',
            func: fetchSwStatus,
        });
        return { status: injection?.result ?? null };
    } catch (error) {
        return { reason: error.message };
    }
};

const render = ({ reason, status }) => {
    if (reason) {
        setBadge('Inactive', 'inactive');
        setMessage(reason);
        return;
    }
    if (!status) {
        setBadge('Inactive', 'inactive');
        setMessage('No DappFence service worker on this page.');
        return;
    }
    const blocked = (status.stats?.activeBlocks ?? 0) > 0;
    setBadge(blocked ? 'Blocked' : 'Active', blocked ? 'blocked' : 'active');
    setMessage('');
    elements.appVersion.textContent = String(status.appVersion ?? '—').slice(0, 14);
    elements.trustedFiles.textContent = status.stats?.trustedFiles ?? '—';
    elements.verifications.textContent = status.stats?.totalVerifications ?? '—';
    elements.activeBlocks.textContent = status.stats?.activeBlocks ?? '—';
    elements.details.hidden = false;
};

(async () => {
    setBadge('Checking…', 'loading');
    render(await probeActiveTab());
})();
