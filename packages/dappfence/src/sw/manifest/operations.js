import { ASSET_TYPE, VERIFICATION_STATUS } from './verification-helpers.js';
import { recoverEthereumAddress, recoverPersonalSign, sriToHex } from '../../core/crypto.js';
import { createLogger } from '../../core/logger.js';
import { isFeatureEnabled } from '../../core/utils.js';

const logger = createLogger();

/**
 * Valid manifest signature types (we only support this one right now)
 */
const MANIFEST_SIGNATURE_TYPES = {
    'noble-secp256k1-recovered-eth': recoverEthereumAddress,
    'personal-sign-alt': recoverPersonalSign,
};

/**
 * Verify a file hash against a trusted manifest (pure function).
 * @param {object} trustedManifest - Manifest with a .files map of fileKey → hash
 * @param {string} fileKey - The file key to look up
 * @param {string} actualHash - The hash of the file content
 * @returns {object} Verification result with status, fileKey, expectedHash, actualHash
 */
export const verifyFileHash = (trustedManifest, fileKey, actualHash) => {
    logger.log(`verifyFileHash, file: ${fileKey}, hash: ${actualHash}`);
    // TODO: Build the right structure in trustedManifest to avoid iterating over all files
    for (const hash of Object.values(trustedManifest.files)) {
        if (hash === actualHash) {
            return {
                status: VERIFICATION_STATUS.MATCH,
                fileKey,
                expectedHash: hash,
                actualHash,
                timestamp: new Date().toISOString(),
            };
        }
    }
    // No content match anywhere in the manifest. Discriminate "known URL,
    // hash diverged" (MISMATCH) from "URL we've never seen" (NOT_FOUND) so
    // telemetry can tell tampering apart from unknown content.
    const expectedHash = trustedManifest.files[fileKey];
    const status = expectedHash
        ? VERIFICATION_STATUS.MISMATCH
        : VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST;
    logger.log(
        `verifyFileHash, file: ${fileKey}, hash: ${actualHash}, expectedHash: ${expectedHash ?? 'N/A'}, status: ${status}`
    );
    return {
        status,
        fileKey,
        expectedHash: expectedHash ?? null,
        actualHash,
        timestamp: new Date().toISOString(),
    };
};

/**
 * Normalize manifest data from external sources (pure function).
 * Handles both enhanced format ({ files: {...} }) and legacy flat format.
 * Converts SRI hashes to hex for consistent internal storage.
 * @param {object} manifestData - Raw manifest data
 * @returns {{ files: Object<string, string> }} Normalized manifest with hex hashes
 */
export const normalizeManifestData = (manifestData) => {
    const normalizedFiles = {};

    if (typeof manifestData === 'object') {
        // Handle new enhanced format with files and metadata sections
        if (manifestData.files && typeof manifestData.files === 'object') {
            // Enhanced format: { "files": { "/path/file.js": "sha256-hash..." }, "metadata": {...} }
            for (const [filePath, entry] of Object.entries(manifestData.files)) {
                let hashValue;
                if (typeof entry === 'string') {
                    hashValue = entry;
                } else if (entry && entry.hash) {
                    hashValue = entry.hash;
                }

                // Convert SRI format to hex for consistent internal storage
                if (hashValue) {
                    normalizedFiles[filePath] = sriToHex(hashValue);
                }
            }
        } else {
            // Legacy flat format: { "/path/file.js": "sha256-hash..." }
            for (const [filePath, entry] of Object.entries(manifestData)) {
                let hashValue;
                if (typeof entry === 'string') {
                    // Simple format: { "/path/file.js": "sha256-hash..." }
                    hashValue = entry;
                } else if (entry && entry.hash) {
                    // Legacy format: { "/path/file.js": { "hash": "sha256-...", ... } }
                    hashValue = entry.hash;
                }

                // Convert SRI format to hex for consistent internal storage
                if (hashValue) {
                    normalizedFiles[filePath] = sriToHex(hashValue);
                }
            }
        }
    }

    return { files: normalizedFiles };
};

/**
 * Determine a file key from URL (pure function).
 * Same-origin URLs return the pathname; external URLs return the full href.
 * @param {string} url - The asset URL
 * @param {string} baseUrl - The service worker's location href
 * @returns {string} The file key for manifest lookups
 */
export const getFileKey = (url, baseUrl) => {
    try {
        const fileUrl = new URL(url, baseUrl);
        const originUrl = new URL(baseUrl);

        // Same origin - use pathname
        if (fileUrl.origin === originUrl.origin) {
            return fileUrl.pathname;
        }

        // External - use full URL
        return fileUrl.href;
    } catch (_error) {
        // Fallback to using the URL as-is if it's already absolute, or prepend '/' if relative
        return url.startsWith('http') ? url : url.startsWith('/') ? url : '/' + url;
    }
};

/**
 * Identify an app version from the first file request by searching stored manifests
 * @param {object} trustedManifestStore - Injected storage for trusted manifests
 * @param {string} fileKey
 * @param {string} fileHash
 */
export const identifyAppFromFile = async (trustedManifestStore, fileKey, fileHash) => {
    try {
        logger.log(
            `Attempting to identify app from file: ${fileKey} (${fileHash.substring(0, 12)}...)`
        );

        const allManifests = await trustedManifestStore.getAll();
        const versions = Object.keys(allManifests);

        if (versions.length === 0) {
            logger.log('No stored manifests found for identification');
            return null;
        }

        logger.log(`Searching through ${versions.length} stored manifests for match`);

        for (const version of versions) {
            const manifest = allManifests[version];
            const storedHash = manifest.files[fileKey];

            if (storedHash === fileHash) {
                logger.log(`✅ Identified app version: ${version} (file match: ${fileKey})`);
                return version;
            }
        }

        logger.log(
            `No manifest contains file ${fileKey} with hash ${fileHash.substring(0, 12)}...`
        );
        return null;
    } catch (error) {
        logger.error('Error during app identification:', error);
        return null;
    }
};

/**
 * Validate manifest data signature using Ethereum-style secp256k1 signature recovery.
 * @param {string} manifestSignatureType - Signature algorithm identifier
 * @param {string} manifestSignatureIdentity - Expected signer address
 * @param {object} manifestData - Manifest with .pay (payload) and .sig (signature)
 * @returns {{ status: string, payload?: object, expectedHash?: string, actualHash?: string }}
 */
export const verifyManifestSignature = (
    manifestSignatureType,
    manifestSignatureIdentity,
    manifestData
) => {
    if (manifestSignatureType in MANIFEST_SIGNATURE_TYPES) {
        try {
            logger.log('checking signature', manifestSignatureType, manifestData.sig);
            const msg = new TextEncoder('utf-8').encode(JSON.stringify(manifestData.pay, null, 2));
            const recovered = MANIFEST_SIGNATURE_TYPES[manifestSignatureType](
                msg,
                manifestData.sig
            );
            if (manifestSignatureIdentity !== recovered) {
                logger.error(
                    `Invalid signature, expected address: ${manifestSignatureIdentity} got ${recovered}`
                );
                return {
                    status: VERIFICATION_STATUS.MISMATCH,
                    expectedHash: manifestSignatureIdentity,
                    actualHash: recovered,
                };
            }
            logger.log('recovered address', recovered);
            return {
                status: VERIFICATION_STATUS.MATCH,
                payload: manifestData.pay,
            };
        } catch (error) {
            logger.error('error validating signature:', error);
            return {
                status: VERIFICATION_STATUS.ERROR,
            };
        }
    } else {
        logger.error(`unsupported signature type ${manifestSignatureType}`);
        return {
            status: VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE,
        };
    }
};

/**
 * Fetch a URL and verify its content against the trusted manifest.
 * Returns a verifyFile-compatible result so callers can decide what to do.
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.manifestService
 * @param {string} url
 * @returns {Promise<object>} Result with status, fileKey, expectedHash, actualHash, timestamp
 */
export async function verifyLocation({ swContext, manifestService }, url) {
    try {
        const response = await swContext.fetch(
            url,
            isFeatureEnabled('mark_request')
                ? { headers: { 'x-dappfence': 'sw-verification' } }
                : {}
        );
        if (response && response.ok) {
            const ctx = await manifestService.resolveManifest();
            return await ctx.verifyFile(url, await response.text());
        }
        logger.error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    } catch (error) {
        logger.error(`Error verifying ${url}:`, error);
    }
    return {
        status: VERIFICATION_STATUS.ERROR,
        url,
        expectedHash: null,
        actualHash: null,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Verify an imported script against the trusted manifest.
 * @param {object} deps
 * @param {object} deps.manifestService
 * @param {object} deps.appStore
 * @param {object} deps.swContext
 * @param {string} scriptPath
 */
export async function verifyImportedScript(deps, scriptPath) {
    const verificationResult = await verifyLocation(deps, scriptPath);
    if (verificationResult.status !== VERIFICATION_STATUS.MATCH) {
        await deps.appStore.recordSecurityViolation({
            ...verificationResult,
            assetType: ASSET_TYPE.SERVICE_WORKER,
            url: scriptPath,
        });
        logger.log(`Security violation detected for ${scriptPath}: ${verificationResult.status}`);
        return;
    }
    logger.log(`Script verified: ${scriptPath}`);
}
