/**
 * Manifest rules evaluation: pathRules resolution, contentRules matching,
 * content transforms, and file hash verification.
 */

import { VERIFICATION_STATUS } from '../../core/constants.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

// ── contentRules ─────────────────────────────────────────────────────────────

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

// ── pathRules ─────────────────────────────────────────────────────────────────

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

// ── hash verification ─────────────────────────────────────────────────────────

/**
 * Verify that `fileKey` is registered in the manifest and that its
 * expected hash matches `actualHash` (pure function, direct lookup only).
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

// ── content transforms ────────────────────────────────────────────────────────

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEX = '[0-9a-f]+';

const TRANSFORMS = {
    'netlify-cdp': {
        // Matches Netlify's CDP snippet injected at CDN serve time.
        // Only whitespace is allowed between the opening tag and the script tag, so
        // extra content cannot be hidden inside the filtered block.
        pattern: new RegExp(
            `<div data-netlify-deploy-id="${HEX}" data-netlify-site-id="${UUID}" data-vcs="github" style="position:fixed">\\s*<script async src="/.netlify/scripts/cdp"></script>\\s*</div>`,
            'g'
        ),
    },
};

/**
 * Apply a named transform to a buffer and return the transformed result.
 * Returns null for unknown transform names so callers can fall through to the
 * next contentRule action.
 *
 * @param {ArrayBuffer|Uint8Array} buffer - Raw file bytes
 * @param {string} transformName - Named transform (e.g. 'netlify-cdp')
 * @returns {Uint8Array|null} Transformed bytes, or null if transformName is unknown
 */
export const applyTransform = (buffer, transformName) => {
    const rule = TRANSFORMS[transformName];
    if (!rule) {
        logger.warn(`Unknown transform: ${transformName}`);
        return null;
    }
    let text = new TextDecoder().decode(buffer);
    logger.log(`Applying transform ${transformName}`);
    text = text.replace(rule.pattern, '');
    return new TextEncoder().encode(text);
};
