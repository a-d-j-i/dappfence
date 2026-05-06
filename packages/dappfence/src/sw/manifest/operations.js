import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';
import { recoverEthereumAddress, recoverPersonalSign } from '../../core/crypto.js';
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
 * Resolve a fileKey against a manifest's `.files` map, applying navigation
 * heuristics for common server-side remappings (e.g. directory request `/`
 * served as `/index.html`).
 *
 * Placeholder for richer remapping rules; today it only handles the
 * trailing-slash → `index.html` case, which covers `/` and `/some/dir/`.
 * Extend here as new server behaviors come up (e.g. extensionless URLs,
 * locale prefixes).
 *
 * @returns {{matchedKey: string, expectedHash: string} | null}
 */
const matchManifestPath = (manifest, fileKey, isNavigation) => {
    const direct = manifest.files[fileKey];
    if (direct !== undefined) {
        logger.log(`matchManifestPath, file: ${fileKey}, hash: ${direct}`);
        return { matchedKey: fileKey, expectedHash: direct };
    }
    if (isNavigation) {
        const indexKey = (fileKey.endsWith('/') ? fileKey : fileKey + '/') + 'index.html';
        const remapped = manifest.files[indexKey];
        if (remapped !== undefined) {
            logger.log(`matchManifestPath, file: ${indexKey}, hash: ${remapped}`);
            return { matchedKey: indexKey, expectedHash: remapped };
        }
    }
    logger.log(`matchManifestPath, file: ${fileKey}, hash: NOT_FOUND_IN_MANIFEST`);
    return null;
};

/**
 * Verify that `fileKey` is registered in the manifest and that its
 * expected hash matches `actualHash` (pure function). Identification of
 * the manifest itself is done by `trustedManifestStore.findByHash` before
 * calling this — so this function only checks "is this URL allowed in
 * this manifest, and does the content match what's recorded for it?".
 *
 * @param {object} trustedManifest - Manifest with a .files map of fileKey → hash
 * @param {string} fileKey - The request fileKey
 * @param {string} actualHash - The hash of the file content
 * @param {boolean} isNavigation - Whether this is a navigation request (enables remap heuristics)
 * @returns {object} Verification result with status, fileKey, expectedHash, actualHash
 */
export const verifyFilePath = (trustedManifest, fileKey, actualHash, isNavigation) => {
    const matched = matchManifestPath(trustedManifest, fileKey, isNavigation);
    if (!matched) {
        logger.log(
            `verifyFilePath, file: ${fileKey}, hash: ${actualHash}, status: NOT_FOUND_IN_MANIFEST`
        );
        return {
            status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST,
            fileKey,
            actualHash,
        };
    }
    const { matchedKey, expectedHash } = matched;
    const status =
        expectedHash === actualHash ? VERIFICATION_STATUS.MATCH : VERIFICATION_STATUS.MISMATCH;
    logger.log(
        `verifyFilePath, file: ${matchedKey}, hash: ${actualHash}, expectedHash: ${expectedHash}, status: ${status.description}`
    );
    return {
        status,
        fileKey: matchedKey,
        expectedHash,
        actualHash,
    };
};

/**
 * Normalize manifest data from external sources (pure function).
 * Handles both enhanced format ({ files: {...}, metadata, mode, ... }) and
 * legacy flat format. Hashes are stored as-is in SRI form (the same format
 * the signer emits and HTML's Subresource Integrity uses), so no encoding
 * conversion happens here. Top-level fields other than `files` (mode,
 * metadata, and any future fields) are preserved as-is so consumers can
 * read them.
 * @param {object} manifestData - Raw manifest data
 * @returns {object} Normalized manifest with `files` map of fileKey -> SRI hash
 */
export const normalizeManifestData = (manifestData) => {
    const normalizedFiles = {};

    if (typeof manifestData === 'object') {
        // Enhanced format: { "files": { "/path/file.js": "sha256-..." }, "metadata": {...} }
        if (manifestData.files && typeof manifestData.files === 'object') {
            for (const [filePath, entry] of Object.entries(manifestData.files)) {
                const hashValue = typeof entry === 'string' ? entry : entry?.hash;
                if (hashValue) {
                    normalizedFiles[filePath] = hashValue;
                }
            }
            return { ...manifestData, files: normalizedFiles };
        }
        // Legacy flat format: { "/path/file.js": "sha256-..." | { hash: "sha256-..." } }
        for (const [filePath, entry] of Object.entries(manifestData)) {
            const hashValue = typeof entry === 'string' ? entry : entry?.hash;
            if (hashValue) {
                normalizedFiles[filePath] = hashValue;
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
 * Determines if a fetched asset requires verification against the manifest.
 * Logs the decision reason at each branch; callers only read the boolean.
 *
 * Takes `fileKey` (the manifest-key form: pathname for same-origin or full
 * URL for cross-origin, as returned by `getFileKey`) rather than a raw URL —
 * callers reach this function with already-resolved keys (importScripts may
 * pass relative URLs that `new URL(url)` couldn't parse standalone).
 *
 * Verification triggers if EITHER the file extension matches the manifest's
 * extension allowlist OR the response Content-Type matches the manifest's
 * MIME allowlist. The OR catches extensionless URLs that still serve
 * security-critical content (e.g. `/api/config` returning JSON).
 *
 * @param {string} fileKey - Resolved manifest key (pathname or absolute URL)
 * @param {boolean} isNavigation - Whether this is a navigation request
 * @param {Response} response - The fetched response (Content-Type read from headers)
 * @param {string[]} extensions - the manifest metadata extensions or default extensions
 * @param {string[]} contentTypes - the manifest metadata content types or default content types
 * @returns {boolean} true if the asset should be verified against the manifest
 */
export const shouldVerifyAsset = (fileKey, isNavigation, response, extensions, contentTypes) => {
    if (isNavigation) {
        logger.log(`Asset check for ${fileKey}: Navigation request`);
        return true;
    }
    const lowerKey = fileKey.toLowerCase();
    if (extensions.some((ext) => lowerKey.endsWith(ext.toLowerCase()))) {
        logger.log(`Asset check for ${fileKey}: extension match`);
        return true;
    }
    // Strip parameters off the Content-Type (e.g. `; charset=utf-8`) before
    // matching — the manifest list stores bare MIME types.
    const rawType = response?.headers?.get?.('content-type') || '';
    const mime = rawType.split(';')[0].trim().toLowerCase();
    if (mime && contentTypes.some((ct) => ct.toLowerCase() === mime)) {
        logger.log(`Asset check for ${fileKey}: content-type match (${mime})`);
        return true;
    }
    logger.log(
        `Asset check for ${fileKey}: no extension or content-type match (mime=${mime || 'none'})`
    );
    return false;
};

/**
 * Validate manifest data signature using Ethereum-style secp256k1 signature recovery.
 * @param {string} manifestSignatureType - Signature algorithm identifier
 * @param {string} manifestSignatureIdentity - Expected signer address
 * @param {object} manifestData - Manifest with .pay (payload) and .sig (signature)
 * @returns {{ status: Readonly<{description: string, isViolation: boolean}>, payload?: object, expectedHash?: string, actualHash?: string }}
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
 * @returns {Promise<object>} Verification result with at least { status }; verifyFile populates fileKey/expectedHash/actualHash on success.
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
            return await ctx.verifyFile(url, response);
        }
        logger.error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    } catch (error) {
        logger.error(`Error verifying ${url}:`, error);
    }
    return { status: VERIFICATION_STATUS.ERROR };
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
    if (verificationResult.status.isViolation) {
        await deps.appStore.recordSecurityViolation({
            ...verificationResult,
            assetType: ASSET_TYPE.SERVICE_WORKER,
            url: scriptPath,
        });
        logger.log(
            `Security violation detected for ${scriptPath}: ${verificationResult.status.description}`
        );
        return;
    }
    logger.log(`Script verified: ${scriptPath}`);
}
