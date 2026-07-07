import { API } from '../../core/constants.js';

/**
 * Builds the Content-Security-Policy header value from the manifest's `csp` section.
 *
 * manifest.csp shape:
 *   {
 *     connectOrigins: ["https://api.example.com"],  // trusted fetch/XHR hosts
 *     pages: { "/": ["sha256-..."] }                // per-page inline script hashes
 *   }
 *
 * External script sources are allowed via `*` in `script-src-elem` — DappFence already
 * verifies every external script by content hash at the SW level, so there is no security
 * benefit in restricting them by origin in the CSP. Inline scripts are restricted to the
 * hashes listed in `csp.pages[pageKey]`; unknown inline scripts are blocked by the browser.
 *
 * Note: `'strict-dynamic'` is intentionally omitted. It is incompatible with the `*`
 * wildcard (strict-dynamic ignores all origin allowlists), and the external-script trust
 * that strict-dynamic would otherwise propagate is already covered by DappFence's SW-level
 * verification.
 *
 * `worker-src 'self'` is required because DappFence registers its own service worker from
 * the page context (dappfence.js calls navigator.serviceWorker.register()). Without it,
 * `default-src 'none'` blocks the registration. `'self'` cannot be tightened to a specific
 * path in a portable way — CSP has no "same-origin at /dappfence.js" syntax; a full origin
 * URL would need to be hardcoded per deployment. In practice this adds no new trust: the
 * browser already enforces that service workers must be same-origin regardless of CSP.
 *
 * @param {object|null|undefined} manifest
 * @param {string} pageKey - resolved manifest key for the requested page
 * @param {string|null} [apiToken] - when provided, appended as ?token= on report-uri
 *   so the SW can validate reports and reject unauthenticated POSTs
 * @returns {string}
 */
export function buildCspHeader(manifest, pageKey, apiToken) {
    const csp = manifest?.csp ?? {};
    const connectOrigins = csp.connectOrigins ?? [];

    // pages[pageKey] can be an array (legacy: scripts only) or {scripts, attrs}
    const pageEntry = csp.pages?.[pageKey];
    const scriptHashes = Array.isArray(pageEntry) ? pageEntry : pageEntry?.scripts ?? [];
    const attrHashes = Array.isArray(pageEntry) ? [] : pageEntry?.attrs ?? [];

    const scriptElemParts = [...scriptHashes.map((h) => `'${h}'`), '*'];

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
    if (attrHashes.length > 0) {
        const attrParts = ["'unsafe-hashes'", ...attrHashes.map((h) => `'${h}'`)];
        directives.splice(2, 0, `script-src-attr ${attrParts.join(' ')}`);
    }

    return directives.join('; ');
}
