/**
 * Content script — injected at document_start into every site in sites.json.
 *
 * Runs in the isolated world but prepends a <script> tag to the document,
 * which executes in the main world early in the page lifecycle.
 *
 * async=false makes the injected script block further HTML parsing until it
 * finishes, so dappfence.js loads as early as possible.
 *
 * SITE_CONFIG is prepended at build time by build.js — a map of origin →
 * { manifest?, signatureType?, signatureIdentity? }.
 */

const config = SITE_CONFIG[location.origin];

const s = document.createElement('script');
// Load dappfence.js from the site's own origin so the service worker can verify it
// against the manifest. Using the extension's chrome-extension:// URL would bypass
// manifest verification and cause NOT_FOUND_IN_MANIFEST violations once the SW is active.
s.src = (config && config.dappfence) || '/dappfence.js';
s.async = false;
if (config) {
    if (config.manifest) s.setAttribute('data-manifest', config.manifest);
    if (config.signatureType) s.setAttribute('data-manifest-signature-type', config.signatureType);
    if (config.signatureIdentity)
        s.setAttribute('data-manifest-signature-identity', config.signatureIdentity);
}
document.documentElement.prepend(s);
