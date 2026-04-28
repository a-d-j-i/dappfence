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
    CONFIG_ERROR: 'CONFIG_ERROR',
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
 * Strips the `sha256-` encoding prefix before truncating so the 16-char
 * tail is pure entropy (~96 bits of base64) rather than 9 payload chars
 * after a fixed prefix.
 * @param {object} manifestData - The normalized manifest data
 * @param {function} calculateHash - Hash function returning an SRI string
 * @returns {Promise<string>} A version string like "manifest-<base64 prefix>"
 */
export const createSyntheticAppVersion = async (manifestData, calculateHash) => {
    const manifestStr = JSON.stringify(manifestData);
    const manifestHash = await calculateHash(new TextEncoder().encode(manifestStr));
    const rawHash = manifestHash.replace(/^sha256-/, '');
    return `manifest-${rawHash.substring(0, 16)}`;
};

/**
 * Determines if a URL requires security verification based on manifest metadata.
 * Logs the decision reason at each branch; callers only read the boolean.
 * @param {string} url - The request URL
 * @param {boolean} isNavigation - Whether this is a navigation request
 * @param {object} [extensions] - the manifest metadata extensions or default extensions
 * @returns {boolean} true if the asset should be verified against the manifest
 */
export function shouldVerifyAsset(url, isNavigation, extensions) {
    if (isNavigation) {
        logger.log(`Asset check for ${url}: Navigation request`);
        return true;
    }
    const path = new URL(url).pathname.toLowerCase();
    const ret = extensions.some((ext) => path.endsWith(ext.toLowerCase()));
    logger.log(
        `Asset check for ${url}, ${ret ? 'found' : 'not found'} in extensions ${extensions}`
    );
    return ret;
}
