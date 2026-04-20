import { API } from '../core/constants.js';

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
 * Creates an HTML response that redirects to the security warning page
 * using a meta-refresh tag for navigation requests
 */
function createNavigationSecurityPageResponse() {
    return createResponse(
        `<html lang="en"><head><meta http-equiv="refresh" content="0; url=${API.SECURITY_WARNING}"></head></html>`,
        200,
        {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy':
                "default-src 'unsafe-inline' 'self'; object-src 'none'; base-uri 'self';",
        }
    );
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
 * Creates an appropriate block response based on context
 *
 * Determines the correct type of security block response to return based on
 * whether the blocked asset is the service worker script itself, a navigation
 * request, or a regular subresource request.
 *
 * @param {boolean} isNavigation - Whether this is a navigation request
 * @param {string} requestUrl - The URL of the blocked request (absolute or relative)
 * @param {string} locationHref - The service worker's location.href
 */
export function createBlockResponse(isNavigation, requestUrl, locationHref) {
    if (isServiceWorkerPath(requestUrl, locationHref)) {
        return createJavascriptRedirectResponse();
    }
    if (isNavigation) {
        return createNavigationSecurityPageResponse();
    }
    return createSecurityWarningResponse();
}

/**
 * Creates a 302-redirect response to the security warning page for navigation requests.
 */
export function createNavigationWarningResponse() {
    return createRedirectResponse(API.SECURITY_WARNING);
}
