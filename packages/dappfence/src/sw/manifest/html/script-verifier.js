import { createUtf8Tokenizer } from '../../../core/html-tokenizer.js';
import { claimsScript as claimsNextjsRsc, validateNextjsRsc } from './validators/nextjs-rsc.js';
import { calculateHash } from '../../../core/crypto.js';
import { createLogger } from '../../../core/logger.js';
import { VERIFICATION_STATUS, VALIDATOR } from '../../../core/constants.js';

const logger = createLogger();

// Registry of named validators for verify-scripts rules.
// claims(content): returns true if this validator handles the script.
// validate(content): returns true (safe) or false (violation).
// Scripts not claimed by the validator fall through to the #scripts hash check (opt-in per manifest entry).
export const VALIDATORS = {
    [VALIDATOR.NEXTJS_RSC]: { claims: claimsNextjsRsc, validate: validateNextjsRsc },
};

// Scripts with these type attributes are data or meta — not executable JS.
const NON_EXECUTABLE_TYPES = new Set(['application/json', 'importmap', 'text/template']);

/**
 * Tokenize an HTML document and validate every executable inline script
 * using the named validator. Also checks for forbidden on* event handler attributes.
 *
 * on* handlers are blocked by default. Specific handlers can be allowed by listing
 * their "attrname:value" strings in manifest.files[fileKey + '#handlers']. This is a
 * plaintext allowlist (not hashed) because handler values are short and already visible
 * in HTML.
 *
 * Skips scripts with a src attribute (external — handled by SW fetch intercept)
 * and scripts with non-executable type attributes (application/json, importmap).
 *
 * Returns null if all checks pass, or { violation: true, scriptContent } on the
 * first failure.
 *
 * @param {string} html                        — HTML document text (caller guarantees UTF-8 source encoding)
 * @param {{ claims: Function, validate: Function }} validator — resolved validator from VALIDATORS
 * @param {string} fileKey                     — manifest file key for this document (e.g. '/index.html')
 * @param {object} [manifest]                  — manifest object for #handlers and #scripts lookup
 * @returns {Promise<{ violation: true, scriptContent: string } | null>}
 */
export async function verifyScripts(html, validator, fileKey, manifest) {
    let violation = null;

    const allowedHandlers = new Set(manifest?.files?.[fileKey + '#handlers'] ?? []);
    // #scripts are opt-in: if absent from the manifest, unclaimed scripts are silently skipped
    // (the known gap). If present (even as []), every unclaimed script must match a listed hash.
    const scriptHashes = manifest?.files?.[fileKey + '#scripts'];
    const allowedScriptHashes = scriptHashes ? new Set(scriptHashes) : null;
    const unclaimedScripts = [];

    const reject = (reason, scriptContent, ctl) => {
        logger.warn(`[inline-scripts] violation: ${reason}`);
        violation = { violation: true, scriptContent };
        ctl.cancel();
    };

    try {
        const tok = createUtf8Tokenizer({
            onScript({ content, attrs, truncated }, ctl) {
                // content is a string — no TextDecoder needed
                if (attrs.src) return;

                const type = (attrs.type || '').toLowerCase().trim();
                if (NON_EXECUTABLE_TYPES.has(type)) return;

                if (!validator.claims(content)) {
                    if (allowedScriptHashes !== null) {
                        unclaimedScripts.push(content);
                    }
                    return;
                }

                if (truncated) {
                    reject(`truncated script claimed by validator`, content, ctl);
                    return;
                }

                const safe = validator.validate(content);
                logger.log(`[inline-scripts] ${safe ? 'safe' : 'VIOLATION'}`);
                if (!safe) {
                    reject(`validator rejected script`, content, ctl);
                }
            },
            onElementOpen({ tagName, attrs }, ctl) {
                for (const attrName of Object.keys(attrs)) {
                    if (!attrName.startsWith('on')) continue;
                    const key = `${attrName}:${attrs[attrName]}`;
                    if (allowedHandlers.has(key)) {
                        logger.log(`[inline-scripts] allowed handler: ${key}`);
                        continue;
                    }
                    reject(`forbidden event handler <${tagName} ${attrName}>`, key, ctl);
                    return;
                }
            },
            onHazard({ type, tagName, pos }, ctl) {
                logger.warn(`[inline-scripts] HTML parse hazard: ${type} at pos ${pos ?? '?'}`);
                reject(`parse hazard: ${type}${tagName ? ` on <${tagName}>` : ''}`, '', ctl);
            },
        });
        tok.push(html);
        tok.finish();
    } catch (err) {
        logger.error('[inline-scripts] unexpected error during HTML parsing', err);
        return { violation: true, scriptContent: '' };
    }

    if (!violation && allowedScriptHashes !== null && unclaimedScripts.length > 0) {
        for (const text of unclaimedScripts) {
            // Encode once per script (not per document) to compute the hash
            const hash = await calculateHash(new TextEncoder().encode(text));
            if (!allowedScriptHashes.has(hash)) {
                logger.warn(`[inline-scripts] unclaimed script hash not in #scripts: ${hash}`);
                violation = { violation: true, scriptContent: text };
                break;
            }
            logger.log(`[inline-scripts] unclaimed script matched #scripts hash: ${hash}`);
        }
    }

    return violation;
}

export async function handleVerifyScripts(fileKey, response, manifestInfo, action) {
    const validator = VALIDATORS[action.validator];
    if (!validator) {
        logger.warn(`[inline-scripts] unknown validator "${action.validator}"`);
        return { status: VERIFICATION_STATUS.MISMATCH };
    }
    const validEncodings = manifestInfo.manifest?.encodings;
    const decoded = await response.getBodyUtf8(validEncodings);
    if (decoded.status) {
        logger.warn(`[inline-scripts] decoding error at ${fileKey}`);
        return decoded;
    }
    logger.log(`[inline-scripts] verifying scripts at ${fileKey} validator=${action.validator}`);
    const violation = await verifyScripts(decoded.text, validator, fileKey, manifestInfo.manifest);
    if (violation) {
        logger.log(`❌ inline script violation at ${fileKey}`);
        return { status: VERIFICATION_STATUS.MISMATCH };
    }
    logger.log(`✅ inline scripts passed at ${fileKey}`);
    return { status: VERIFICATION_STATUS.MATCH };
}
