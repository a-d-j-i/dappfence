import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';
import { recoverEthereumAddress, recoverPersonalSign } from '../../core/crypto.js';
import { createLogger } from '../../core/logger.js';
import { isFeatureEnabled } from '../../core/utils.js';

const logger = createLogger();

/**
 * @param {object|undefined} condition
 * @param {string} fileKey
 * @param {string|undefined} destination
 * @returns {boolean}
 */
export const matchesCondition = (condition, fileKey, destination) => {
    if (!condition) {
        return true;
    }
    const { urlFilter, resourceTypes } = condition;
    if (urlFilter && !fileKey.startsWith(urlFilter)) {
        return false;
    }
    return !(resourceTypes && !resourceTypes.includes(destination));
};

/**
 * @param {string} fileKey
 * @param {string|undefined} destination
 * @param {Array} contentRules
 * @returns {Array}
 */
export const collectContentRuleActions = (fileKey, destination, contentRules = []) =>
    contentRules
        .filter(({ condition }) => matchesCondition(condition, fileKey, destination))
        .map(({ action }) => action);

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
 * @param {object} rule
 * @param {string} pathname
 * @param {object} files - manifest files map
 * @returns {string|null}
 */
const applyPathRule = (rule, pathname, files) => {
    if (rule.match && rule.resolveAs) {
        return pathname === rule.match ? rule.resolveAs : null;
    }

    const lastSegment = pathname.split('/').pop();
    const hasExtension = lastSegment.includes('.');

    if (rule.type === 'directory-index') {
        if (hasExtension) {
            return null;
        }
        const base = pathname.endsWith('/') ? pathname : pathname + '/';
        const candidate = base + 'index.html';
        return files[candidate] !== undefined ? candidate : null;
    }

    if (rule.type === 'html-extension') {
        if (hasExtension || pathname.endsWith('/')) {
            return null;
        }
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
 * A not-found rule applies only when response is non-OK and the pathname is
 * not in files — it maps to a fallback key for hash verification.
 * Falls back to pathname if no rule matches.
 *
 * @param {{ url: string, destination: string }} req
 * @param {{ ok: boolean }|null} response
 * @param {string} base - SW location href
 * @param {object} manifest - manifest object with pathRules and files
 * @returns {string}
 */
export const resolveManifestKey = (req, response, base, manifest = {}) => {
    const { pathRules = [], files = {} } = manifest;
    const { url } = req;

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

    const { pathname } = fileUrl;

    const isApplicableRule = (r) =>
        r.type !== 'not-found' &&
        (!r.condition?.urlFilter || pathname.startsWith(r.condition.urlFilter));

    const applyRule = (r) => applyPathRule(r, pathname, files);

    const fileKey = pathRules.filter(isApplicableRule).map(applyRule).find(Boolean);
    if (fileKey) {
        return fileKey;
    }

    // not-found is last resort regardless of its position in pathRules
    if (response && !response.ok && files[pathname] === undefined) {
        const rule = pathRules.find(
            (r) =>
                r.type === 'not-found' &&
                r.fallback &&
                files[r.fallback] !== undefined &&
                matchesCondition(r.condition, pathname, req.destination)
        );
        if (rule) {
            return rule.fallback;
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
            return await ctx.verifyFile(
                { url, destination: 'script', method: 'GET', mode: '' },
                response
            );
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
