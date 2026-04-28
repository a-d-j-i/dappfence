/**
 * Cross-module contract strings — values that appear in 2+ modules or cross
 * the SW ↔ client boundary. A silent rename in one place breaks coordination,
 * so they live here with one canonical declaration.
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
};

// --- postMessage type strings (SW ↔ client) ---

export const MSG = {
    SECURITY_BLOCK: 'DAPPFENCE_SECURITY_BLOCK',
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
export const DEFAULT_SECURITY_EXTENSIONS = ['.js', '.css', '.json', '.html', '.svg'];

export const VERIFICATION_STATUS = {
    MATCH: 'MATCH',
    MISMATCH: 'MISMATCH',
    NOT_FOUND_IN_MANIFEST: 'NOT_FOUND_IN_MANIFEST',
    UNSUPPORTED_SIGNATURE: 'UNSUPPORTED_SIGNATURE',
    ERROR: 'VERIFICATION_ERROR',
    CONFIG_ERROR: 'CONFIG_ERROR',
};

export const ASSET_TYPE = {
    ASSET: 'asset',
    SERVICE_WORKER: 'service-worker',
    MANIFEST: 'manifest',
};
