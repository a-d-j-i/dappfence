import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * Verification status constants
 */
export const VERIFICATION_STATUS = {
    MATCH: 'MATCH',
    MISMATCH: 'MISMATCH',
    NOT_FOUND_IN_MANIFEST: 'NOT_FOUND_IN_MANIFEST',
    UNSUPPORTED_SIGNATURE: 'UNSUPPORTED_SIGNATURE',
    ERROR: 'VERIFICATION_ERROR',
};
/**
 * Asset type constants for violation reporting
 */
export const ASSET_TYPE = {
    ASSET: 'asset',
    SERVICE_WORKER: 'service-worker',
    MANIFEST: 'manifest',
};
/**
 * Create a synthetic app version from manifest data by hashing its content.
 * @param {object} manifestData - The normalized manifest data
 * @param {function} calculateHash - Hash function (content: Uint8Array) => string
 * @returns {Promise<string>} A version string like "manifest-<hash prefix>"
 */
export const createSyntheticAppVersion = async (manifestData, calculateHash) => {
    const manifestStr = JSON.stringify(manifestData);
    const manifestHash = await calculateHash(new TextEncoder().encode(manifestStr));
    return `manifest-${manifestHash.substring(0, 16)}`;
};

/**
 * Verification Policy
 * Decides whether a request needs integrity verification
 * based on manifest metadata and file extensions.
 */
const DEFAULT_SECURITY_EXTENSIONS = ['.js', '.css', '.json', '.html', '.svg'];

/**
 * Determines if a URL requires security verification based on manifest metadata.
 * Logs the decision reason at each branch; callers only read the boolean.
 * @param {string} url - The request URL
 * @param {boolean} isNavigation - Whether this is a navigation request
 * @param {object} [manifest] - The trusted manifest (with optional `metadata.extensions`)
 * @returns {boolean} true if the asset should be verified against the manifest
 */
export function shouldVerifyAsset(url, isNavigation, manifest) {
    if (isNavigation) {
        logger.log(`Asset check for ${url}: Navigation request`);
        return true;
    }
    const path = new URL(url).pathname.toLowerCase();
    const fromManifest = manifest?.metadata?.extensions;
    const extensions = fromManifest || DEFAULT_SECURITY_EXTENSIONS;

    const ret = extensions.some((ext) => path.endsWith(ext.toLowerCase()));
    logger.log(
        `Asset check for ${url}, ${ret ? 'found in' : 'not in'} ${fromManifest ? 'manifest' : 'default'}`
    );
    return ret;
}
