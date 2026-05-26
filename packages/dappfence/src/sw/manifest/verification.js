import {
    ASSET_TYPE,
    DEFAULT_SECURITY_CONTENT_TYPES,
    DEFAULT_SECURITY_EXTENSIONS,
    VERIFICATION_STATUS,
} from '../../core/constants.js';
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
 * Extensions that servers commonly strip from URLs (clean URLs, serverless
 * function endpoints, etc.). Distinct from DEFAULT_SECURITY_EXTENSIONS, which
 * controls what gets verified — these drive candidate-key generation for
 * extensionless paths like `/about` or `/.netlify/scripts/cdp`.
 *
 */
const EXTENSIONLESS_REWRITE_EXTENSIONS = ['.html', '.htm', '.js', '.mjs', '.json'];

/**
 * Generate candidate manifest keys to try when a direct lookup for `fileKey`
 * fails. Covers two common server-side rewrite patterns:
 *   1. Extensionless URL: try appending each of EXTENSIONLESS_REWRITE_EXTENSIONS
 *   2. Directory/extensionless path: try appending index.html / index.htm
 *
 * --- Security model ---
 * The hash is always computed over the *actual received content*, so a tampered
 * file is always caught regardless of which candidate key is selected. The
 * candidate list only determines which manifest entry we compare against; it
 * cannot bypass hash verification.
 *
 * Paths that already carry a file extension (e.g. `/app.js`, `/style.css`)
 * produce no candidates — only the direct lookup applies to them.
 *
 * @param {string} fileKey
 * @returns {string[]}
 */
const generateCandidates = (fileKey) => {
    const candidates = [];
    const lastSegment = fileKey.split('/').pop();
    const isDir = fileKey.endsWith('/');
    const isExtensionless = !isDir && !lastSegment.includes('.');

    if (isExtensionless) {
        for (const ext of EXTENSIONLESS_REWRITE_EXTENSIONS) {
            candidates.push(fileKey + ext);
        }
    }

    if (isDir || isExtensionless) {
        const base = isDir ? fileKey : fileKey + '/';
        candidates.push(base + 'index.html', base + 'index.htm');
    }

    return [fileKey, ...candidates];
};

/**
 * Verify that `fileKey` is registered in the manifest and that its
 * expected hash matches `actualHash` (pure function). Identification of
 * the manifest itself is done by `trustedManifestStore.findByHash` before
 * calling this — so this function only checks "is this URL allowed in
 * this manifest, and does the content match what's recorded for it?"
 *
 * Direct lookup is tried first. For extensionless and directory paths,
 * all rewrite candidates from `generateCandidates` are checked; the first
 * candidate whose hash matches is returned as MATCH. If candidates exist but
 * none match, the first found is used to report MISMATCH with a meaningful
 * expected hash. See `generateCandidates` for the security model.
 *
 * @param {object} trustedManifest - Manifest with a .files map of fileKey → hash
 * @param {string} fileKey - The request fileKey
 * @param {string} actualHash - The hash of the file content
 * @returns {object} Verification result with status, fileKey, expectedHash, actualHash
 */
export const verifyFilePath = (trustedManifest, fileKey, actualHash) => {
    const hashMatches = (expected) =>
        Array.isArray(expected) ? expected.includes(actualHash) : expected === actualHash;

    let found = false;
    for (const candidate of generateCandidates(fileKey)) {
        const expectedHash = trustedManifest.files[candidate];
        logger.log(
            `Checking candidate ${candidate} got hash ${expectedHash} expected ${actualHash}`
        );
        if (expectedHash !== undefined) {
            if (hashMatches(expectedHash)) {
                logger.log(`verifyFilePath, file: ${candidate}, status: MATCH`);
                return {
                    status: VERIFICATION_STATUS.MATCH,
                    fileKey: candidate,
                    expectedHash,
                    actualHash,
                };
            }
            found = true;
        }
    }
    const status = !found
        ? VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST
        : VERIFICATION_STATUS.MISMATCH;
    logger.log(`verifyFilePath, file: ${fileKey}, status: ${status.description}`);
    return { status, fileKey, actualHash };
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
 * @param {{extensions?: string[], contentTypes?: string[]}|undefined} meta - manifest metadata; merged with defaults to build the check sets
 * @returns {boolean} true if the asset should be verified against the manifest
 */
export const shouldVerifyAsset = (fileKey, isNavigation, response, meta) => {
    if (isNavigation) {
        logger.log(`Asset check for ${fileKey}: Navigation request`);
        return true;
    }
    const extensions = [...DEFAULT_SECURITY_EXTENSIONS, ...(meta?.extensions || [])].map((s) =>
        s.toLowerCase()
    );
    const lowerKey = fileKey.toLowerCase();
    for (const ext of extensions) {
        if (lowerKey.endsWith(ext)) {
            logger.log(`Asset check for ${fileKey}: extension match`);
            return true;
        }
    }
    const contentTypes = new Set(
        [...DEFAULT_SECURITY_CONTENT_TYPES, ...(meta?.contentTypes || [])].map((s) =>
            s.toLowerCase()
        )
    );
    // Strip parameters off the Content-Type (e.g. `; charset=utf-8`) before
    // matching — the manifest list stores bare MIME types.
    const rawType = response?.headers?.get?.('content-type') || '';
    const mime = rawType.split(';')[0].trim().toLowerCase();
    if (mime && contentTypes.has(mime)) {
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
