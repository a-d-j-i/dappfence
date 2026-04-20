function log(...args) {
    // window.pageId is injected by playwright fixtures
    if (args.length > 0 && typeof args[0] === 'string' && args[0].startsWith('%c')) {
        const [format, color, ...rest] = args;
        console.log('%c[SimpleApp]', color, `(${window.pageId})`, format.slice(2), ...rest);
        return;
    }
    console.log('[SimpleApp]', `(${window.pageId})`, ...args);
}
log.error = (...args) => console.error('[SimpleApp]', `(${window.pageId})`, ...args);
//Simple app demonstration of DappFence protection!
log('%c App JavaScript loaded', 'color:green');

// Import utilities
import { formatTimestamp } from './utils.js';

// Simple greeting module functionality (replacing the old greet.js)
function greet(name) {
    log(` Hello, ${name}!`);
    return `Hello, ${name}!`;
}

let registrationAttempt = 0;
// Wait for a service worker to be ready and controlling the page
async function waitForServiceWorkerReady(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Service worker ready timeout'));
        }, timeoutMs);

        const checkReady = () => {
            // Check if we have an active service worker controlling this page
            if (navigator.serviceWorker.controller) {
                log(
                    'Found controller:',
                    navigator.serviceWorker.controller.scriptURL,
                    navigator.serviceWorker.controller.state
                );

                // Double-check by testing the /sw-api/status endpoint
                fetch('/sw-api/status')
                    .then((response) => response.ok)
                    .then((isOk) => {
                        if (isOk) {
                            clearTimeout(timeout);
                            log('Service worker is ready and responding');
                            resolve();
                        } else {
                            // Endpoint doesn't ready yet, try again
                            log('Service worker controller is not responding yet');
                            setTimeout(checkReady, 200);
                        }
                    })
                    .catch((err) => {
                        // Endpoint doesn't ready yet, try again
                        log.error('Service worker controller error', err);
                        setTimeout(checkReady, 200);
                    });
                return;
            }

            // TODO: This can end up adding a lot of background jobs
            log('Trying to get the registration, attempt:', registrationAttempt++, '...');
            // Check for active registration
            navigator.serviceWorker.getRegistrations().then((registrations) => {
                for (let j = 0; j < registrations.length; j++) {
                    const r = registrations[j];
                    log(
                        'Checking registration:',
                        j,
                        r.waiting && [r.waiting.scriptURL, r.waiting.state],
                        r.installing && [r.installing.scriptURL, r.installing.state],
                        r.active && [r.active.scriptURL, r.active.state]
                    );
                }
                const activeReg = registrations.find(
                    (reg) => reg.active && reg.active.scriptURL.includes('dappfence.js')
                );

                if (activeReg) {
                    log(
                        'DappFence service worker is active:',
                        activeReg.active && activeReg.active.scriptURL,
                        'testing endpoint, attempt:',
                        registrationAttempt
                    );
                    // Test if the endpoint is actually working
                    fetch('/sw-api/status')
                        .then((response) => response.ok)
                        .then((isOk) => {
                            try {
                                if (isOk) {
                                    clearTimeout(timeout);
                                    log('Service worker registration is responding');
                                    resolve();
                                } else {
                                    log('Service worker registration is not responding yet');
                                    setTimeout(checkReady, 1000);
                                }
                            } catch (e) {
                                log.error('Error checking service worker status:', e);
                            }
                        })
                        .catch((err) => {
                            log(
                                'Service worker status fetch error, attempt:',
                                registrationAttempt,
                                err
                            );
                            setTimeout(checkReady, 1000);
                        });
                    return;
                }

                // If not ready, check again in a bit
                log('Service worker not ready yet, retry');
                setTimeout(checkReady, 200);
            });
        };

        // Start checking
        checkReady();

        // Also listen for controllerchange events
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (navigator.serviceWorker.controller) {
                clearTimeout(timeout);
                log('Service worker took control');
                resolve();
            }
        });
    });
}

// Wait for DOM to be ready
document.addEventListener('DOMContentLoaded', () => {
    log('DOM loaded, initializing app');

    // Update app content with demo-focused messaging
    const appContent = document.getElementById('app-content');
    if (appContent) {
        appContent.innerHTML = `
            <div style="background: #e8f5e8; padding: 15px; border-radius: 8px; margin: 10px 0;">
                <h3>🛡️ DappFence Security Demo</h3>
                <p><strong>What you're seeing:</strong></p>
                <ul style="margin: 8px 0;">
                    <li>📄 Local files: <code>app.js</code>, <code>utils.js</code></li>
                    <li>🌐 External files: jQuery from CDN</li>
                    <li>⚡ Real-time integrity monitoring</li>
                </ul>
                <p style="margin-top: 10px;"><em>The status below updates automatically.</em></p>
            </div>
        `;
    }

    // Automatically show status when page loads (key for demo)
    // Add loading indicator
    const output = document.getElementById('output');
    if (output) {
        output.innerHTML = `
            <div style="background: #f0f8ff; padding: 15px; border-radius: 4px; margin: 10px 0; text-align: center;">
                <h4>🔄 Initializing DappFence Security Status...</h4>
                <p style="color: #666;">Waiting for service worker to become ready...</p>
                <div style="margin: 10px 0;">
                    <div style="display: inline-block; width: 20px; height: 20px; border: 2px solid #007acc; border-radius: 50%; border-top: 2px solid transparent; animation: spin 1s linear infinite;"></div>
                </div>
            </div>
            <style>
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            </style>
        `;
    }

    // Wait for a service worker to be ready before trying to fetch status
    waitForServiceWorkerReady()
        .then(() => {
            log('Service worker ready, loading manifest status for demo');
            window.checkManifestStatus();
        })
        .catch((error) => {
            log.error('Service worker failed to become ready:', error);
            const output = document.getElementById('output');
            if (output) {
                output.innerHTML = `
                <div style="background: #fff3cd; padding: 15px; border-radius: 4px; margin: 10px 0;">
                    <h4>⚠️ Service Worker Not Ready</h4>
                    <p>DappFence service worker is not active yet. Try refreshing the page or check the browser console for errors.</p>
                    <button onclick="window.checkManifestStatus()" style="margin-top: 10px;">Retry</button>
                </div>
            `;
            }
        });

    // Add an event listener to the test button (less prominent now)
    const testBtn = document.getElementById('test-btn');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            const greeting = greet('DappFence User');
            log('Demo button clicked:', greeting);

            // Just show a small notification instead of taking over the output area
            const notification = document.createElement('div');
            notification.style.cssText = `
                position: fixed; top: 20px; right: 20px; 
                background: #4CAF50; color: white; padding: 10px 15px; 
                border-radius: 4px; z-index: 1000;
                animation: slideIn 0.3s ease-out;
            `;
            notification.innerHTML = `✅ ${greeting}`;
            document.body.appendChild(notification);

            setTimeout(() => {
                document.body.removeChild(notification);
            }, 3000);
        });
    }
});

// Global functions for button clicks
window.showAlert = function () {
    alert('🔒 This alert is shown from a DappFence-protected application!');
};

window.loadContent = function () {
    const output = document.getElementById('output');
    output.innerHTML = `
        <div style="background: #e8f5e8; padding: 15px; border-radius: 4px; margin: 10px 0;">
            <h4>📊 Security Monitoring Active</h4>
            <p>DappFence is monitoring all network requests and content changes.</p>
            <p>Check the browser console to see security logs.</p>
            <p><small>Timestamp: ${new Date().toISOString()}</small></p>
        </div>
    `;
};

// Trusted Manifest testing functions
window.checkManifestStatus = async function () {
    try {
        log('Checking manifest status...');

        // Check if a service worker is ready
        const registrations = await navigator.serviceWorker.getRegistrations();
        const activeReg = registrations.find(
            (reg) => reg.active && reg.active.scriptURL.includes('dappfence.js')
        );

        if (!activeReg && !navigator.serviceWorker.controller) {
            throw new Error('Service worker not ready - please wait or refresh the page');
        }

        const response = await fetch('/sw-api/status');
        if (!response.ok) {
            throw new Error(
                `Service worker status endpoint returned ${response.status}: ${response.statusText}`
            );
        }

        const status = await response.json();
        log('Manifest Status:', status);

        // Create a nice file list visualization
        const createFileList = (manifest, isVerificationResults = false) => {
            if (isVerificationResults) {
                if (!manifest || manifest.length === 0) {
                    return `<p><em>No verification results yet</em></p>`;
                }

                // Sort by timestamp (latest first) and check for recent verifications
                const now = new Date();
                const sortedManifest = [...manifest].sort(
                    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
                );

                let html = '<div style="margin: 10px 0;">';
                sortedManifest.forEach((result) => {
                    const statusIcon =
                        result.status === 'MATCH'
                            ? '✅'
                            : result.status === 'MISMATCH'
                              ? '❌'
                              : '⚠️';
                    const typeIcon = result.isExternal ? '🌐' : '📄';
                    let fileName;
                    if (result.isExternal) {
                        try {
                            const urlStr = result.fullUrl || result.fileKey;
                            const urlObj = new URL(urlStr);
                            fileName = urlObj.hostname + urlObj.pathname;
                        } catch (e) {
                            // Fallback for invalid URLs
                            fileName = result.fileKey;
                        }
                    } else {
                        fileName = result.fileKey;
                    }

                    // Check if this verification is recent (last 30 seconds)
                    const verificationTime = new Date(result.timestamp);
                    const timeDiff = now - verificationTime;
                    const isRecent = timeDiff < 30000; // 30 seconds

                    const backgroundColor =
                        result.status === 'MATCH'
                            ? isRecent
                                ? '#e8f5e8'
                                : '#f0fff0'
                            : result.status === 'MISMATCH'
                              ? isRecent
                                  ? '#ffe6e6'
                                  : '#fff0f0'
                              : isRecent
                                ? '#fff8e1'
                                : '#fffaf0';

                    html += `
                        <div style="display: flex; align-items: center; padding: 6px; border: 1px solid ${isRecent ? '#007acc' : '#ddd'}; margin: 2px 0; border-radius: 4px; background: ${backgroundColor}; ${isRecent ? 'border-width: 2px;' : ''}">
                            <span style="margin-right: 8px; font-size: 16px;">${statusIcon}${typeIcon}${isRecent ? '🆕' : ''}</span>
                            <div style="flex: 1;">
                                <strong>${fileName}</strong>${isRecent ? ' <span style="color: #007acc; font-size: 0.8em; font-weight: normal;">(just verified)</span>' : ''}<br>
                                <small style="color: #666; font-family: monospace;">
                                    ${result.actualHash ? result.actualHash : 'No hash'}
                                    ${result.status === 'MISMATCH' ? ` (expected: ${result.expectedHash})` : ''}
                                </small><br>
                                <small style="color: #888; font-size: 0.75em;">
                                    🕒 ${formatTimestamp(verificationTime)}
                                </small>
                            </div>
                        </div>
                    `;
                });
                html += '</div>';
                return html;
            }

            // Handle both direct and wrapped formats
            const manifestFiles = manifest.files || manifest;
            if (!manifestFiles || Object.keys(manifestFiles).length === 0) {
                return `<p><em>No files yet</em></p>`;
            }

            let html = '<div style="margin: 10px 0;">';
            // Handle both direct manifest format and wrapped .files format
            const fileEntries = manifest.files || manifest;

            Object.entries(fileEntries).forEach(([fileKey, fileData]) => {
                const isExternal = !fileKey.startsWith('/');
                const typeIcon = isExternal ? '🌐' : '📄';
                let fileName;
                if (isExternal) {
                    try {
                        const urlObj = new URL(fileKey);
                        fileName = urlObj.hostname + urlObj.pathname;
                    } catch (e) {
                        // Fallback for invalid URLs
                        fileName = fileKey;
                    }
                } else {
                    fileName = fileKey;
                }
                const hash = typeof fileData === 'string' ? fileData : fileData.hash || 'unknown'; // Handle both formats for compatibility
                const domain = ''; // No domain metadata in simplified format

                html += `
                    <div style="display: flex; align-items: center; padding: 8px; border: 1px solid #ddd; margin: 3px 0; border-radius: 4px; background: #fafafa;">
                        <span style="margin-right: 10px; font-size: 18px;">${typeIcon}</span>
                        <div style="flex: 1;">
                            <strong>${fileName}</strong>${domain}<br>
                            <small style="color: #666; font-family: monospace;">
                                Hash: ${typeof hash === 'string' && hash ? hash : 'unknown'}...
                            </small>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            return html;
        };

        // Calculate failed verification count
        const failedVerifications = status.verificationResults.filter(
            (r) => r.status === 'MISMATCH' || r.status === 'NOT_IN_MANIFEST'
        ).length;

        const output = document.getElementById('output');
        output.innerHTML = `
            <div style="background: #f0f8ff; padding: 15px; border-radius: 4px; margin: 10px 0;">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;">
                    <h4 style="margin: 0;">📋 Trusted Manifest Status</h4>
                    <button onclick="checkManifestStatus()">Refresh Status</button>
                </div>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 15px 0;">
                    <div><strong>App Version:</strong> <code style="font-size: 0.85em;">${status.appVersion ? status.appVersion : 'Not set'}</code></div>
                    <div><strong>Trusted Files:</strong> <span style="color: #28a745;">${status.stats.trustedFiles}</span></div>
                    <div><strong>Total Verifications:</strong> <span style="color: #007acc;">${status.stats.totalVerifications}</span></div>
                    <div><strong>Failed Verifications:</strong> <span style="color: ${failedVerifications > 0 ? '#dc3545' : '#28a745'};">${failedVerifications}</span></div>
                </div>
                ${
                    status.stats.trustedFiles > 0
                        ? `
                    <details style="margin-top: 15px;">
                        <summary style="cursor: pointer; font-weight: bold;">🔒 Trusted Files (${status.stats.trustedFiles})</summary>
                        ${createFileList(status.trustedManifest)}
                    </details>
                `
                        : ''
                }
                
                ${
                    status.verificationResults && status.verificationResults.length > 0
                        ? `
                    <details style="margin-top: 15px;">
                        <summary style="cursor: pointer; font-weight: bold;">
                            🔍 All Verifications (${status.verificationResults.length})
                            <span style="font-weight: normal; color: #666; margin-left: 8px;">
                                | ✅ ${status.verificationResults.filter((r) => r.status === 'MATCH').length} 
                                | ❌ ${status.verificationResults.filter((r) => r.status === 'MISMATCH').length}
                                | ⚠️ ${status.verificationResults.filter((r) => r.status === 'NOT_IN_MANIFEST').length}
                            </span>
                        </summary>
                        ${
                            status.verificationResults.length > 20
                                ? '<p style="color: #666; font-size: 0.9em; margin: 10px 0;"><em>💡 Showing latest first. Recent verifications (last 30s) are highlighted with blue borders.</em></p>'
                                : ''
                        }
                        ${createFileList(status.verificationResults, true)}
                    </details>
                `
                        : ''
                }
                
                <details style="margin-top: 15px;">
                    <summary style="cursor: pointer; color: #666;">🔧 Raw JSON Data</summary>
                    <pre style="background: #f5f5f5; padding: 10px; overflow: auto; max-height: 300px; font-size: 11px;">${JSON.stringify(status, null, 2)}</pre>
                </details>
            </div>
        `;
    } catch (error) {
        log.error('Error fetching manifest status:', error);

        const output = document.getElementById('output');
        if (output) {
            output.innerHTML = `
                <div style="background: #f8d7da; padding: 15px; border-radius: 4px; margin: 10px 0;">
                    <h4>❌ Error Loading Status</h4>
                    <p><strong>Error:</strong> ${error.message}</p>
                    <p>This usually means the DappFence service worker is not ready yet.</p>
                    <div style="margin-top: 10px;">
                        <button onclick="window.checkManifestStatus()" style="margin-right: 10px;">Retry</button>
                        <button onclick="location.reload()">Refresh Page</button>
                    </div>
                </div>
            `;
        }
    }
};

// Export for potential module usage
export { greet };
