/**
 * Cross-module contract values — strings (and a couple of small frozen
 * objects) that appear in 2+ modules or cross the SW ↔ client boundary.
 * A silent rename in one place breaks coordination, so they live here
 * with one canonical declaration.
 *
 * Scope guard — NOT a home for:
 *   - storage keys (private to each store module)
 *   - magic numbers used in a single place
 *   - UI copy / feature flags
 * Add those where they're used, not here.
 */

// --- `/sw-api/*` endpoints ---

export const API_PREFIX = '/sw-api/';

export const API = {
    STATUS: API_PREFIX + 'status',
    SECURITY_WARNING: API_PREFIX + 'security-warning',
    SITE_UNBLOCK: API_PREFIX + 'site-unblock',
    CHECK_BLOCKS: API_PREFIX + 'check-blocks',
};

// --- postMessage type strings (SW ↔ client) ---

export const MSG = {
    SECURITY_BLOCK: 'DAPPFENCE_SECURITY_BLOCK',
    BLOCK_RESOLVED: 'DAPPFENCE_BLOCK_RESOLVED',
    CLIENT_READY: 'DAPPFENCE_CLIENT_READY',
    CLAIM_CONTROL: 'CLAIM_CONTROL',
};

export const MODE = {
    REPORTING: 'reporting', // log to console and indexeddb
    PROTECTED: 'protected', // stop requests that are invalid
};

/**
 * Verification Policy
 * Decides whether a request needs integrity verification
 * based on manifest metadata and file extensions.
 */
/**
 * Verification verdict for a single file or manifest.
 *
 * Each entry is a frozen object carrying both a human-readable `description`
 * (the wire/log/storage form, kept stable for telemetry) and `isViolation`
 * (the action signal — does the caller record + potentially block, or
 * pass through?). Co-locating the classification with the description keeps
 * a single source of truth: adding or reclassifying a status is a one-line
 * change here, no consumer needs to keep an exclusion list current.
 *
 * Comparisons use reference equality (`result.status === VERIFICATION_STATUS.MATCH`).
 * Stringification needs `.description` explicitly — `toString`/`toJSON` would
 * break `structuredClone` (used by IndexedDB), so persistence layers must
 * write `details.status.description`, not the object.
 */
const verdict = (description, isViolation, isTerminal) =>
    Object.freeze({ description, isViolation, isTerminal });

export const VERIFICATION_STATUS = Object.freeze({
    MATCH: verdict('MATCH', false, true),
    SKIPPED: verdict('SKIPPED', false, true),
    REWRITE: verdict('REWRITE', false, true),
    MISMATCH: verdict('MISMATCH', true, false),
    NOT_FOUND_IN_MANIFEST: verdict('NOT_FOUND_IN_MANIFEST', true, true),
    DENIED_BY_RULE: verdict('DENIED_BY_RULE', true, true),
    UNSUPPORTED_SIGNATURE: verdict('UNSUPPORTED_SIGNATURE', true, true),
    ERROR: verdict('ERROR', true, true),
    CONFIG_ERROR: verdict('CONFIG_ERROR', true, true),
});

export const ASSET_TYPE = {
    ASSET: 'asset',
    SERVICE_WORKER: 'service-worker',
    MANIFEST: 'manifest',
};
