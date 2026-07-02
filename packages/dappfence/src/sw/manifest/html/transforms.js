import { createUint8Tokenizer } from '../../../core/html-tokenizer.js';
import { calculateHash } from '../../../core/crypto.js';
import { createLogger } from '../../../core/logger.js';
import { TRANSFORM, VERIFICATION_STATUS } from '../../../core/constants.js';

const logger = createLogger();

const HEX_RE = /^[0-9a-fA-F]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Equivalent regex (attribute-order-dependent, replaced by tokenizer):
// /<div data-netlify-deploy-id="[0-9a-f]+" data-netlify-site-id="[0-9a-f]{8}-…" data-vcs="github" style="position:fixed">\s*<script async src="\/.netlify\/scripts\/cdp"><\/script>\s*<\/div>/g
function isNetlifyDiv(attrs) {
    return (
        HEX_RE.test(attrs['data-netlify-deploy-id'] ?? '') &&
        UUID_RE.test(attrs['data-netlify-site-id'] ?? '') &&
        attrs['data-vcs'] === 'github' &&
        attrs['style'] === 'position:fixed'
    );
}

// Build the stripped Uint8Array by concatenating the slices between each range.
function applyStripRanges(bytes, ranges) {
    const parts = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (cursor < start) parts.push(bytes.subarray(cursor, start));
        cursor = end;
    }
    if (cursor < bytes.length) parts.push(bytes.subarray(cursor));
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

export const TRANSFORMS = {
    [TRANSFORM.NETLIFY_CDP]: {
        // Scan rawBytes for Netlify CDP divs and return the byte ranges to strip.
        // A range is only added when the div contains exactly one <script> with
        // src="/.netlify/scripts/cdp" and async, no inline content, and no other
        // elements inside the div.
        findStripRanges(rawBytes) {
            const ranges = [];
            let tracking = null; // { startIndex, divDepth, scriptCount, valid }

            const tok = createUint8Tokenizer({
                onElementOpen({ tagName, startIndex, attrs }) {
                    if (tracking !== null) {
                        // Any element inside the tracked div invalidates it.
                        // Track nested div depth so we still find the correct </div>.
                        if (tagName === 'div') tracking.divDepth++;
                        tracking.valid = false;
                        return;
                    }
                    if (tagName !== 'div' || !isNetlifyDiv(attrs)) return;
                    tracking = { startIndex, divDepth: 1, scriptCount: 0, valid: true };
                },
                onScript({ content, attrs, truncated }) {
                    if (tracking === null) return;
                    tracking.scriptCount++;
                    if (
                        tracking.scriptCount > 1 ||
                        attrs.src !== '/.netlify/scripts/cdp' ||
                        !('async' in attrs) ||
                        content.length > 0 ||
                        truncated
                    ) {
                        tracking.valid = false;
                    }
                },
                onElementClose({ tagName, endIndex }) {
                    if (tracking === null || tagName !== 'div') return;
                    tracking.divDepth--;
                    if (tracking.divDepth > 0) return;
                    if (tracking.valid && tracking.scriptCount === 1) {
                        ranges.push([tracking.startIndex, endIndex]);
                    }
                    tracking = null;
                },
            });
            tok.push(rawBytes);
            tok.finish();
            return ranges;
        },
    },
};

export const handleTransform = async (fileKey, response, manifestInfo, action) => {
    const rule = TRANSFORMS[action.transform];
    if (!rule) {
        logger.warn(`Unknown transform: ${action.transform}`);
        return null;
    }

    const buf = await response.getBodyBytes();
    if (buf.status) {
        logger.warn(`[transform] body unreadable for ${action.transform} at ${fileKey}`);
        return buf;
    }

    const rawBytes = buf.value;
    const ranges = rule.findStripRanges(rawBytes);
    const bytesToHash = ranges.length > 0 ? applyStripRanges(rawBytes, ranges) : rawBytes;

    if (ranges.length === 0) {
        logger.log(
            `[transform] no strip ranges for ${action.transform} at ${fileKey}, verifying raw`
        );
    }

    const fileHash = await calculateHash(bytesToHash);
    const expectedHashes = manifestInfo.manifest.files[fileKey] ?? [];
    logger.log(
        `[transform] ${action.transform} at ${fileKey}: hash=${fileHash} expected=[${expectedHashes.join(', ')}]`
    );
    if (expectedHashes.length === 0) {
        return null;
    }
    if (expectedHashes.includes(fileHash)) {
        return { status: VERIFICATION_STATUS.MATCH, expectedHashes, actualHash: fileHash };
    }
    return null;
};
