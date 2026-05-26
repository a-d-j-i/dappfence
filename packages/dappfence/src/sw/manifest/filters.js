/**
 * Named content transforms for CDN content normalization.
 *
 * CDN platforms inject HTML snippets at serve time, after the build output has
 * been hashed and signed. Without normalization, the injected bytes cause a hash
 * mismatch on every page load.
 *
 * Transforms are a closed set defined here — the manifest only references them
 * by name via contentRules. Arbitrary patterns cannot be injected through the
 * manifest.
 *
 * Current transforms: netlify-cdp
 */
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEX = '[0-9a-f]+';

const RULES = {
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
    const rule = RULES[transformName];
    if (!rule) {
        logger.warn(`Unknown transform: ${transformName}`);
        return null;
    }
    let text = new TextDecoder().decode(buffer);
    logger.log(`Applying transform ${transformName}`);
    text = text.replace(rule.pattern, '');
    return new TextEncoder().encode(text);
};
