/**
 * Service Worker API Handler Module
 * Handles internal API endpoints for trusted manifest control
 */
// Import security warning templates using Vite's raw imports
import securityWarningHtml from '../templates/security-warning.html?raw';
import securityWarningCss from '../templates/security-warning.css?raw';
import { createLogger } from '../core/logger.js';
import { isFeatureEnabled } from '../core/utils.js';
import { createRedirectResponse } from './response.js';
import { API } from '../core/constants.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {function} deps.onSecurityViolation - called to broadcast the active block condition
 * @param {object} deps.appStore
 */
export function createApiHandler({ onSecurityViolation, appStore }) {
    const {
        apiTokenStore,
        activeBlocksStore,
        appVersionStore,
        trustedManifestStore,
        verificationResultsStore,
    } = appStore;

    async function validateApiToken(request) {
        const token = await apiTokenStore.getApiToken();
        const providedToken =
            request.headers.get('X-DappFence-Token') ||
            new URL(request.url).searchParams.get('token');
        return providedToken === token;
    }

    /**
     * Renders the security warning page by combining HTML template with CSS styles
     * and injecting dynamic values like API token and feature flags.
     * @returns {string} Complete HTML document with injected styles and configuration
     */
    function renderSecurityPage(tokenId) {
        return securityWarningHtml
            .replace('/* CSS will be injected here during build */', securityWarningCss)
            .replace(
                '<!-- API_TOKEN_PLACEHOLDER -->',
                `<meta name="dappfence-token" content="${tokenId}">`
            )
            .replace(
                '/* JavaScript values will be injected here during build */',
                `"auto_confirm_site_lock": ${isFeatureEnabled('auto_confirm_site_lock')},`
            );
    }

    async function handleStatus(_request) {
        logger.log('Serving status endpoint');
        const appVersion = await appVersionStore.get();
        const trustedManifest = await trustedManifestStore.get(appVersion);
        const verificationResults = await verificationResultsStore.get(appVersion);
        const blockHistory = await activeBlocksStore.getAllBlocks();
        const status = {
            appVersion,
            timestamp: new Date().toISOString(),
            trustedManifest,
            verificationResults,
            blockHistory,
            stats: {
                trustedFiles: Object.keys(trustedManifest.files).length,
                totalVerifications: verificationResults.length,
                totalBlocks: blockHistory.length,
                activeBlocks: blockHistory.filter((b) => b.active).length,
            },
        };
        logger.log('Status report:', JSON.stringify(status.stats));
        return new Response(JSON.stringify(status, null, 2), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    async function handleSecurityWarning(request) {
        // Only respond to real navigations (top-level redirects, meta-refresh, link
        // clicks, 302 follow-ups). JavaScript `fetch()` cannot forge Sec-Fetch-Mode
        // / request.mode === 'navigate', so probing via fetch falls through to the
        // network and gets a normal 404 — the endpoint appears not to exist.
        if (request.mode !== 'navigate') {
            logger.log('security-warning: non-navigation access, falling through');
            return;
        }
        if (!(await activeBlocksStore.isBlocked())) {
            logger.log('fetch api No active block - redirecting home');
            return createRedirectResponse('/');
        }
        logger.log(`fetch api Broadcasting active block condition`);
        await onSecurityViolation();
        const htmlWithStyles = renderSecurityPage(await apiTokenStore.getApiToken());
        return new Response(htmlWithStyles, {
            status: 200,
            statusText: 'Security Warning',
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'X-Frame-Options': 'DENY',
                'Content-Security-Policy':
                    "default-src 'unsafe-inline' 'self'; object-src 'none'; base-uri 'self';",
            },
        });
    }

    async function handleActiveBlocks(_request) {
        const blocks = await activeBlocksStore.getActiveBlocks();
        const responseData = blocks.map((block) => ({
            ...block,
            expectedHash: block.expectedHash || 'N/A',
            actualHash: block.actualHash || 'N/A',
            occurrenceCount: block.occurrenceCount || 1,
            formattedTimestamp: new Date(block.timestamp).toLocaleString(),
        }));
        return new Response(JSON.stringify(responseData, null, 2), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
            },
        });
    }

    async function handleSiteUnblock(_request) {
        // Errors bubble to the outer catch and become a plain-text 500, matching
        // how the rest of this handler reports unexpected failures.
        await activeBlocksStore.clearBlockCondition();
        logger.log('Site unblocked successfully');
        return new Response(
            JSON.stringify({
                success: true,
                message: 'Site has been unblocked',
                timestamp: Date.now(),
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        );
    }

    // Dispatch table: method → path → { handler, public? }.
    // Routes are private by default; public endpoints must opt in with `public: true`
    // so adding a new endpoint without thinking about access fails safe.
    const ROUTES = {
        GET: {
            [API.STATUS]: { public: true, handler: handleStatus },
            [API.SECURITY_WARNING]: { public: true, handler: handleSecurityWarning },
            [API.ACTIVE_BLOCKS]: { handler: handleActiveBlocks },
        },
        POST: {
            [API.SITE_UNBLOCK]: { handler: handleSiteUnblock },
        },
    };

    return async function handleApiEndpoint(pathname, request) {
        try {
            // Unknown endpoint or bad token → return undefined so the fetch handler
            // forwards to the network. The attacker sees a normal server 404,
            // indistinguishable from a site without DappFence.
            const route = ROUTES[request.method]?.[pathname];
            const allowed = route && (route.public || (await validateApiToken(request)));
            if (allowed) {
                return await route.handler(request);
            }
        } catch (error) {
            logger.error('API endpoint error:', error);
            return new Response('Internal server error', {
                status: 500,
                headers: { 'Content-Type': 'text/plain' },
            });
        }
    };
}
