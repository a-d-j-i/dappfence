import { API } from '../../core/constants.js';

/**
 * Builds the Content-Security-Policy header value from the manifest's `csp` section.
 *
 * manifest.csp shape:
 *   {
 *     scriptOrigins: ["https://cdn.example.com"],   // trusted external script hosts
 *     connectOrigins: ["https://api.example.com"],  // trusted fetch/XHR hosts
 *     pages: { "/": ["sha256-..."] }                // per-page inline script hashes
 *   }
 *
 * @param {object|null|undefined} manifest
 * @param {string} pageKey - resolved manifest key for the requested page
 * @param {string|null} [apiToken] - when provided, appended as ?token= on report-uri
 *   so the SW can validate reports and reject unauthenticated POSTs
 * @returns {string}
 */
export function buildCspHeader(manifest, pageKey, apiToken) {
    const csp = manifest?.csp ?? {};
    const inlineHashes = csp.pages?.[pageKey] ?? [];
    const scriptOrigins = csp.scriptOrigins ?? [];
    const connectOrigins = csp.connectOrigins ?? [];

    const scriptSrcParts = ["'self'", ...scriptOrigins];
    if (inlineHashes.length) {
        for (const h of inlineHashes) {
            scriptSrcParts.push(`'${h}'`);
        }
        scriptSrcParts.push("'strict-dynamic'");
    }

    const connectSrcParts = ["'self'", ...connectOrigins];
    const reportUri = apiToken
        ? `${API.CSP_VIOLATION}?token=${encodeURIComponent(apiToken)}`
        : API.CSP_VIOLATION;

    return [
        "default-src 'none'",
        `script-src ${scriptSrcParts.join(' ')}`,
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        `connect-src ${connectSrcParts.join(' ')}`,
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        `report-uri ${reportUri}`,
    ].join('; ');
}
