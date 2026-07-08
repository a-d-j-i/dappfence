// Import security warning templates using Vite's raw imports
import securityWarningHtml from '../templates/security-warning.html?raw';
import securityWarningCss from '../templates/security-warning.css?raw';
import { isFeatureEnabled } from '../core/utils.js';
import { API } from '../core/constants.js';

// CSS and the build-time feature flag are static across all renders — fold
// them into the template once at a module load instead of repeating the work
// on every block. `isFeatureEnabled` reads a Vite-defined compile-time
// constant, so it can never change at runtime.
const BASE_HTML = securityWarningHtml.replace(
    '/* CSS will be injected here during build */',
    securityWarningCss
);
const AUTO_CONFIRM_SITE_LOCK = isFeatureEnabled('auto_confirm_site_lock');

// Locate the template's placeholder config <script> once at a module load and
// pre-slice the surrounding HTML. Matching by id (not by exact string) means
// prettier / editors can reformat the tag freely without breaking the
// renderer. The presence of the placeholder is pinned by a unit test against the
// bundled template — no need for a runtime check here.
const CONFIG_SCRIPT_PATTERN = /<script id="dappfence-config">[\s\S]*?<\/script>/;
const { index: configIndex, 0: configMatch } = CONFIG_SCRIPT_PATTERN.exec(BASE_HTML);
const HTML_PREFIX = BASE_HTML.slice(0, configIndex);
const HTML_SUFFIX = BASE_HTML.slice(configIndex + configMatch.length);

/**
 * Emit the `<script>` tag that defines `DAPPFENCE_CONFIG`. The server swaps
 * the template's default `<script id="dappfence-config">…</script>` block for
 * this one. Uses `encodeURIComponent` + a double-quoted string literal.
 * Double quotes are load-bearing: `'` is in `encodeURIComponent`'s unreserved
 * set, so wrapping in single quotes would let an attacker-supplied apostrophe
 * close the literal.
 */
function renderConfigScript(config) {
    const encoded = encodeURIComponent(JSON.stringify(config));
    return `<script>const DAPPFENCE_CONFIG = JSON.parse(decodeURIComponent("${encoded}"));</script>`;
}

function enrichActiveBlocks(blocks) {
    return blocks.map((block) => ({
        ...block,
        expectedHashes: block.expectedHashes || [],
        actualHash: block.actualHash || 'N/A',
        occurrenceCount: block.occurrenceCount || 1,
        formattedTimestamp: new Date(block.timestamp).toLocaleString(),
    }));
}

/**
 * Creates a Response object with the specified parameters
 */
function createResponse(body, status, headers) {
    return new Response(body, {
        status,
        headers,
    });
}

/**
 * Create a security warning response for blocked content
 * Uses redirects for non-HTML requests, direct HTML for navigation
 */
function createSecurityWarningResponse() {
    return createResponse('Security violation detected. File blocked by DappFence.', 403, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
}

/**
 * Create security redirect response for blocked content
 * When the security violation is detected in dappfence.js, we need to use client-side JavaScript
 * redirect instead of standard message-based redirection since the client js won't be loaded.
 * This returns a minimal JavaScript snippet that safely redirects to the security warning page.
 */
function createJavascriptRedirectResponse() {
    const body = `window.location.replace("${API.SECURITY_WARNING}")`;
    return createResponse(body, 200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'self';",
    });
}

/**
 * True when the request targets the service worker's own script (same origin
 * and same pathname). Used to choose a JS-redirect response, since the
 * client-side dappfence.js isn't available to handle a postMessage redirect
 * when it is the blocked asset itself.
 */
const isServiceWorkerPath = (requestUrl, locationHref) => {
    try {
        const req = new URL(requestUrl, locationHref);
        const sw = new URL(locationHref);
        return req.origin === sw.origin && req.pathname === sw.pathname;
    } catch (_error) {
        console.error('[response] unexpected error parsing URLs:', requestUrl, locationHref);
    }
    return false;
};

/**
 * Creates an appropriate block response based on context.
 *
 * @param {Request} request - The blocked request
 * @param {string} locationHref - The service worker's location.href
 */
export function createBlockResponse(request, locationHref) {
    if (request.mode === 'navigate') {
        return createRedirectResponse(API.SECURITY_WARNING);
    }
    if (isServiceWorkerPath(request.url, locationHref)) {
        return createJavascriptRedirectResponse();
    }
    return createSecurityWarningResponse();
}

/**
 * Creates a safe empty stub response for rewritten CDN sub resources.
 * The body is a valid JS/CSS comment, so it parses without errors in any context.
 * @param response
 */
export function createRewriteResponse(response) {
    const contentType =
        response.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
    return new Response('/* replaced by dappfence */', {
        headers: { 'content-type': contentType, 'Cache-Control': 'no-store' },
    });
}

/**
 * Returns a new Response with additional headers merged in.
 * Used by the fetch handler to inject policy headers (e.g. CSP) onto a
 * pass-through response without coupling the injection logic to any specific
 * header name.
 *
 * @param {Response} response
 * @param {Record<string, string>} headers
 */
// Headers whose spec semantics are additive: multiple values are all enforced
// simultaneously, and the browser takes the intersection (the strictest result).
// Appending never weakens an existing server-provided value.
const ADDITIVE_HEADERS = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'permissions-policy',
    'reporting-endpoints',
    'report-to',
]);

/**
 * Returns a new Response with additional headers merged in.
 *
 * Headers in `ADDITIVE_HEADERS` (CSP, Permissions-Policy, etc.) are appended
 * so that multiple values are all enforced simultaneously — adding DappFence's
 * policy never weakens an existing server-provided value. All other headers use
 * a set (last write wins).
 *
 * @param {Response} response
 * @param {Record<string, string>} headers
 * @returns {Response}
 */
export function injectResponseHeaders(response, headers) {
    const merged = new Headers(response.headers);
    for (const [key, value] of Object.entries(headers)) {
        if (ADDITIVE_HEADERS.has(key.toLowerCase())) {
            merged.append(key, value);
        } else {
            merged.set(key, value);
        }
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
    });
}

/**
 * Creates a 302-redirect response with no-cache headers. Use this for every
 * SW-side redirect so behavior (body, cache policy) is consistent.
 * `Response.redirect` is not used because it requires an absolute URL and
 * doesn't let us set additional headers like `Cache-Control`.
 * @param {string} location - The Location header value (relative or absolute)
 */
export function createRedirectResponse(location) {
    return new Response(null, {
        status: 302,
        headers: {
            Location: location,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
    });
}

/**
 * Build the security warning page response: block details, API token, and the
 * build-time feature flag are baked into an inline `DAPPFENCE_CONFIG`. No
 * runtime fetches are needed to populate the page — everything travels in the
 * HTML itself.
 *
 * @param {string|null} apiToken
 * @param {Array} activeBlocks
 */
export function createSecurityPageResponse(apiToken, activeBlocks) {
    const configScript = renderConfigScript({
        apiToken,
        activeBlocks: enrichActiveBlocks(activeBlocks),
        autoConfirmSiteLock: AUTO_CONFIRM_SITE_LOCK,
    });
    const html = HTML_PREFIX + configScript + HTML_SUFFIX;
    return new Response(html, {
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

/**
 * Builds the Content-Security-Policy header value.
 *
 * External script sources are allowed via `*` in `script-src-elem` — DappFence already
 * verifies every external script by content hash at the SW level, so there is no security
 * benefit in restricting them by origin in the CSP. Inline scripts are restricted to the
 * hashes listed in `scripts`; unknown inline scripts are blocked by the browser.
 *
 * Note: `'strict-dynamic'` is intentionally omitted. It is incompatible with the `*`
 * wildcard (strict-dynamic ignores all origin allowlists), and the external-script trust
 * that strict-dynamic would otherwise propagate is already covered by DappFence's SW-level
 * verification.
 *
 * `worker-src 'self'` is required because DappFence registers its own service worker from
 * the page context (dappfence.js calls navigator.serviceWorker.register()). Without it,
 * `default-src 'none'` blocks the registration.
 *
 * @param {{ scripts: string[], attrs: string[] }} pageHashes
 * @param {string[]} connectOrigins
 * @param {string|null} [apiToken]
 * @returns {string}
 */
export function buildCspHeader({ scripts, attrs }, connectOrigins, apiToken) {
    const scriptElemParts = [...scripts.map((h) => `'${h}'`), '*'];
    const connectSrcParts = ["'self'", ...connectOrigins];
    const reportUri = apiToken
        ? `${API.CSP_VIOLATION}?token=${encodeURIComponent(apiToken)}`
        : API.CSP_VIOLATION;

    const directives = [
        "default-src 'none'",
        `script-src-elem ${scriptElemParts.join(' ')}`,
        // 'unsafe-inline' is safe for styles: all CSS JS-execution vectors (expression(),
        // behavior:, HTC) are IE-only and dead in modern browsers — see docs/js-execution-vectors.md §11.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src ${connectSrcParts.join(' ')}`,
        "worker-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        `report-uri ${reportUri}`,
    ];

    // script-src-attr is only emitted when on* attribute hashes are declared.
    // 'unsafe-hashes' is required by the CSP spec for hashes to apply to event handlers;
    // without it hashes in this directive are silently ignored.
    if (attrs.length > 0) {
        const attrParts = ["'unsafe-hashes'", ...attrs.map((h) => `'${h}'`)];
        directives.splice(2, 0, `script-src-attr ${attrParts.join(' ')}`);
    }

    return directives.join('; ');
}

/**
 * Injects the CSP hashes script tag into the HTML head and returns a response
 * with the Content-Security-Policy header set.
 *
 * @param {{ hashes, connectOrigins }} csp - CSP data from the verification result
 * @param {object} wrappedResponse - Response wrapper with `.injectAtHead` and `.asResponse`
 * @param {string|null} apiToken
 * @returns {Response}
 */
export function createCspPageResponse({ hashes, connectOrigins }, wrappedResponse, apiToken) {
    const hashesTag = `<script type="application/json" id="__df_csp_hashes">${JSON.stringify(hashes)}</script>`;
    wrappedResponse.injectAtHead(new TextEncoder().encode(hashesTag));
    return injectResponseHeaders(wrappedResponse.asResponse(), {
        'Content-Security-Policy': buildCspHeader(hashes, connectOrigins, apiToken),
    });
}
