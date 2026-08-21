import { API } from '../../core/constants.js';

/**
 * Builds the response headers for a CSP-protected navigation.
 *
 * manifest.csp shape:
 *   {
 *     connectOrigins: ["https://api.example.com"],  // trusted fetch/XHR hosts
 *     pages: { "/": { scripts: ["sha256-..."], attrs: [...] } }
 *   }
 *
 * External script sources are allowed via `*` in `script-src-elem` — DappFence already
 * verifies every external script by content hash at the SW level, so there is no security
 * benefit in restricting them by origin in the CSP. Inline scripts are gated by:
 *   - the SW-generated `nonce` (used to tag the trusted bootstrap and any script the SW
 *     verifies at runtime, e.g., RSC push chunks under the planned RSC parser); and
 *   - the build-time `'sha256-...'` hashes listed in `csp.pages[fileKey].scripts`.
 * Matching the nonce OR any listed hash lets an inline script run; the browser
 * blocks anything else.
 *
 * Origin CSP headers (both enforce and report-only) are stripped from the response before
 * the manifest-derived policy is set. The origin is untrusted per
 * docs/csp-injection-strategy.md — appending would leave attacker-controlled directives
 * (frame-ancestors, form-action, report-uri, etc.) binding whenever DappFence doesn't emit
 * them.
 *
 * `'strict-dynamic'` is intentionally omitted. It is incompatible with the `*` wildcard
 * (strict-dynamic ignores all origin allowlists), and the external-script trust that
 * strict-dynamic would otherwise propagate is already covered by SW-level verification.
 *
 * `worker-src 'self'` is required because DappFence registers its own service worker from
 * the page context. `'self'` cannot be tightened to a specific path portably; the browser
 * already enforces that service workers must be same-origin regardless of CSP.
 *
 * @param {string} fileKey - resolved manifest key for the requested page
 * @param {Response} response - origin response; its headers are copied, origin CSP
 *   headers are stripped, and the manifest-derived policy is set
 * @param {object|null|undefined} manifest
 * @param {string|null} [apiToken] - when provided, appended as ?token= on report-uri
 *   so the SW can validate reports and reject unauthenticated POSTs
 * @param {string} nonce - SW-generated per-response nonce, emitted in `script-src-elem`
 *   alongside the build-time-stable hashes and `*`
 * @returns {Headers} composed response headers, ready to apply
 */
export function buildCspHeader(fileKey, response, manifest, apiToken, nonce) {
    const csp = manifest?.csp ?? {};
    const connectOrigins = csp.connectOrigins ?? [];

    // pages[fileKey] can be an array (legacy: scripts only) or {scripts, attrs}
    const pageEntry = csp.pages?.[fileKey];
    const scriptHashes = Array.isArray(pageEntry) ? pageEntry : pageEntry?.scripts ?? [];
    const attrHashes = Array.isArray(pageEntry) ? [] : pageEntry?.attrs ?? [];

    // Nonce first so the trusted bootstrap (and future runtime-verified scripts)
    // match; hashes for build-time-stable inline; `*` for external scripts the SW
    // verifies by content hash at fetch time.
    const scriptElemParts = [`'nonce-${nonce}'`, ...scriptHashes.map((h) => `'${h}'`), '*'];

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
        "base-uri 'none'",
        "frame-ancestors 'none'",
        // CSP3 marks `report-uri` as deprecated in favor of `Reporting-Endpoints`
        // + `report-to`, but no browser has announced a removal timeline, and
        // Firefox/Safari still don't ship the Reporting API for CSP — so
        // `report-uri` is currently the only directive that works everywhere.
        // When we do adopt `Reporting-Endpoints`, emit both directives: Chromium
        // prefers `report-to` when both are present, so no double-reporting.
        `report-uri ${reportUri}`,
    ];

    // script-src-attr is only emitted when on* attribute hashes are declared.
    // the CSP spec requires 'unsafe-hashes' for hashes to apply to event handlers;
    // without it hashes in this directive are silently ignored.
    if (attrHashes.length > 0) {
        const attrParts = ["'unsafe-hashes'", ...attrHashes.map((h) => `'${h}'`)];
        directives.splice(2, 0, `script-src-attr ${attrParts.join(' ')}`);
    }

    // Origin CSP is untrusted — strip both enforce and report-only, then set ours.
    const headers = new Headers(response.headers);
    headers.delete('content-security-policy');
    headers.delete('content-security-policy-report-only');
    headers.set('Content-Security-Policy', directives.join('; '));
    return headers;
}
