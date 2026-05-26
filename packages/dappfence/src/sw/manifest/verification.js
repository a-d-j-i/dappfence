import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';
import { recoverEthereumAddress, recoverPersonalSign } from '../../core/crypto.js';
import { createLogger } from '../../core/logger.js';
import { isFeatureEnabled } from '../../core/utils.js';

const logger = createLogger();

const MANIFEST_SIGNATURE_TYPES = {
    'noble-secp256k1-recovered-eth': recoverEthereumAddress,
    'personal-sign-alt': recoverPersonalSign,
};

/**
 * Verify that `fileKey` is registered in the manifest and that its
 * expected hash matches `actualHash` (pure function, direct lookup only).
 * All URL resolution and pathRules expansion happen upstream in resolveManifestKey.
 *
 * @param {object} trustedManifest - Manifest with a .files map of fileKey → hash
 * @param {string} fileKey - The resolved manifest key
 * @param {string} actualHash - The hash of the file content
 * @returns {object} Verification result with status, fileKey, expectedHash, actualHash
 */
export const verifyFilePath = (trustedManifest, fileKey, actualHash) => {
    const expectedHash = trustedManifest.files[fileKey];
    if (expectedHash === undefined) {
        logger.log(`verifyFilePath: ${fileKey} → NOT_FOUND_IN_MANIFEST`);
        return { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST, fileKey, actualHash };
    }
    const matches = Array.isArray(expectedHash)
        ? expectedHash.includes(actualHash)
        : expectedHash === actualHash;
    if (!matches) {
        logger.log(`verifyFilePath: ${fileKey} → MISMATCH`);
        return { status: VERIFICATION_STATUS.MISMATCH, fileKey, expectedHash, actualHash };
    }
    logger.log(`verifyFilePath: ${fileKey} → MATCH`);
    return { status: VERIFICATION_STATUS.MATCH, fileKey, expectedHash, actualHash };
};

/**
 * Convert a URL to a pathname or full href (no pathRules applied).
 * Same-origin → pathname. Cross-origin → full URL.
 * Used for config URL comparisons (manifest URL self-check).
 *
 * @param {string} url
 * @param {string} baseUrl - The service worker's location href
 * @returns {string}
 */
export const toPathname = (url, baseUrl) => {
    try {
        const fileUrl = new URL(url, baseUrl);
        const originUrl = new URL(baseUrl);
        if (fileUrl.origin === originUrl.origin) {
            return fileUrl.pathname;
        }
        return fileUrl.href;
    } catch (_error) {
        return url.startsWith('http') ? url : url.startsWith('/') ? url : '/' + url;
    }
};

/**
 * Apply a single named pathRule type to a pathname and return the candidate key,
 * or null if the rule does not succeed (candidate not in files).
 *
 * @param {string} type - 'directory-index' | 'html-extension'
 * @param {string} pathname
 * @param {object} files - manifest files map
 * @returns {string|null}
 */
const applyPathRuleType = (type, pathname, files) => {
    const lastSegment = pathname.split('/').pop();
    const hasExtension = lastSegment.includes('.');

    if (type === 'directory-index') {
        if (hasExtension) return null;
        const base = pathname.endsWith('/') ? pathname : pathname + '/';
        const candidate = base + 'index.html';
        return files[candidate] !== undefined ? candidate : null;
    }

    if (type === 'html-extension') {
        if (hasExtension || pathname.endsWith('/')) return null;
        const candidate = pathname + '.html';
        return files[candidate] !== undefined ? candidate : null;
    }

    return null;
};

/**
 * Resolve a request URL to its canonical manifest key using pathRules.
 *
 * Same-origin requests → pathname, then pathRules applied in order.
 * Cross-origin requests → full URL (pathRules never apply).
 *
 * A named-type rule succeeds when the resolved candidate exists in `files`.
 * A match/resolveAs rule always succeeds (terminal).
 * Falls back to pathname if no rule matches.
 *
 * @param {string} url
 * @param {string} base - SW location href
 * @param {Array} pathRules - manifest pathRules array
 * @param {object} files - manifest files map (for existence checks)
 * @returns {string}
 */
export const resolveManifestKey = (url, base, pathRules = [], files = {}) => {
    let fileUrl, originUrl;
    try {
        fileUrl = new URL(url, base);
        originUrl = new URL(base);
    } catch (_error) {
        return url.startsWith('http') ? url : url.startsWith('/') ? url : '/' + url;
    }

    if (fileUrl.origin !== originUrl.origin) {
        return fileUrl.href;
    }

    const pathname = fileUrl.pathname;

    for (const rule of pathRules) {
        // Explicit one-to-one override — always terminal
        if (rule.match && rule.resolveAs) {
            if (pathname === rule.match) {
                return rule.resolveAs;
            }
            continue;
        }

        // Optional urlFilter condition
        if (rule.condition?.urlFilter && !pathname.startsWith(rule.condition.urlFilter)) {
            continue;
        }

        if (rule.type) {
            const candidate = applyPathRuleType(rule.type, pathname, files);
            if (candidate !== null) {
                return candidate;
            }
        }
    }

    return pathname;
};

/**
 * Validate manifest data signature using Ethereum-style secp256k1 signature recovery.
 * @param {string} manifestSignatureType
 * @param {string} manifestSignatureIdentity
 * @param {object} manifestData - Manifest with .pay (payload) and .sig (signature)
 * @returns {{ status, payload?, expectedHash?, actualHash? }}
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
            return { status: VERIFICATION_STATUS.MATCH, payload: manifestData.pay };
        } catch (error) {
            logger.error('error validating signature:', error);
            return { status: VERIFICATION_STATUS.ERROR };
        }
    } else {
        logger.error(`unsupported signature type ${manifestSignatureType}`);
        return { status: VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE };
    }
};

/**
 * Fetch a URL and verify its content against the trusted manifest.
 * Returns a verifyFile-compatible result so callers can decide what to do.
 * The synthetic destination 'script' is used since importScripts is the primary caller.
 *
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.manifestService
 * @param {string} url
 * @returns {Promise<object>}
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
