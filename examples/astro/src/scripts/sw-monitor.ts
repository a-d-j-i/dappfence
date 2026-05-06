interface VerificationResult {
    fileKey: string;
    fullUrl: string;
    isExternal: boolean;
    actualHash: string;
    expectedHash: string;
    status: string;
    timestamp: string;
}

interface Block {
    active: boolean;
    fileKey?: string;
    url?: string;
}

interface SwStatus {
    appVersion: string;
    timestamp: string;
    trustedManifest: { files: Record<string, unknown> };
    verificationResults: VerificationResult[];
    blockHistory: Block[];
    stats: {
        trustedFiles: number;
        totalVerifications: number;
        totalBlocks: number;
        activeBlocks: number;
    };
}

const STATUS_ICON: Record<string, string> = {
    MATCH: '✓',
    MISMATCH: '✗',
    NOT_FOUND_IN_MANIFEST: '?',
    UNSUPPORTED_SIGNATURE: '⚠',
    VERIFICATION_ERROR: '!',
};

const STATUS_COLOR: Record<string, string> = {
    MATCH: '#065f46',
    MISMATCH: '#991b1b',
    NOT_FOUND_IN_MANIFEST: '#92400e',
    UNSUPPORTED_SIGNATURE: '#1e40af',
    VERIFICATION_ERROR: '#991b1b',
};

function relativeTime(iso: string): string {
    const ms = new Date(iso).getTime();
    if (!iso || isNaN(ms)) return 'unknown';
    const diff = Math.round((Date.now() - ms) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
}

function renderStats(stats: SwStatus['stats'], updatedAt: string): string {
    const items = [
        { label: 'Trusted files', value: stats.trustedFiles },
        { label: 'Verifications', value: stats.totalVerifications },
        { label: 'Active blocks', value: stats.activeBlocks },
        { label: 'Total blocks', value: stats.totalBlocks },
    ];
    return `
        <div class="df-stats">
            ${items
                .map(
                    ({ label, value }) => `
                <div class="df-stat ${value > 0 && label.includes('block') ? 'df-stat--warn' : ''}">
                    <span class="df-stat-value">${value}</span>
                    <span class="df-stat-label">${label}</span>
                </div>
            `
                )
                .join('')}
        </div>
        <p class="df-updated">Updated ${relativeTime(updatedAt)}</p>
    `;
}

function renderResults(results: VerificationResult[]): string {
    if (!results.length) {
        return '<p class="df-empty">No verifications yet — interact with the page to trigger fetches.</p>';
    }
    const sorted = [...results].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return `
        <ul class="df-results">
            ${sorted
                .map((r) => {
                    const icon = STATUS_ICON[r.status] ?? '?';
                    const color = STATUS_COLOR[r.status] ?? '#555';
                    const label = r.fileKey || r.fullUrl;
                    const mismatch =
                        r.status === 'MISMATCH'
                            ? `<div class="df-hash-diff">
                           <span>expected: <code>${r.expectedHash?.slice(0, 28)}…</code></span>
                           <span>actual:   <code>${r.actualHash?.slice(0, 28)}…</code></span>
                       </div>`
                            : '';
                    return `
                    <li class="df-result">
                        <span class="df-result-icon" style="color:${color}">${icon}</span>
                        <span class="df-result-body">
                            <span class="df-result-key" title="${r.fullUrl}">${label}</span>
                            <span class="df-result-status" style="color:${color}">${r.status}</span>
                            <span class="df-result-time">${relativeTime(r.timestamp)}</span>
                            ${mismatch}
                        </span>
                    </li>`;
                })
                .join('')}
        </ul>`;
}

function renderBlocks(blocks: Block[]): string {
    const active = blocks.filter((b) => b.active);
    if (!active.length) return '';
    return `
        <div class="df-blocks">
            <strong>Active blocks (${active.length})</strong>
            <ul>${active.map((b) => `<li>${b.fileKey ?? b.url ?? 'unknown'}</li>`).join('')}</ul>
        </div>`;
}

export async function fetchStatus(): Promise<SwStatus | null> {
    try {
        const res = await fetch('/sw-api/status');
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}

export function renderMonitor(containerId: string, status: SwStatus): void {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML =
        renderStats(status.stats, status.timestamp) +
        renderBlocks(status.blockHistory) +
        renderResults(status.verificationResults);
}

export function startAutoRefresh(containerId: string, intervalMs = 3000): () => void {
    async function tick() {
        const status = await fetchStatus();
        if (status) renderMonitor(containerId, status);
    }
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
}
