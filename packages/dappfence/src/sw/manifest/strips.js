/**
 * Content normalization via named strip rules.
 * Removes known CDN injections from file content before hashing so the hash
 * matches the pre-injection content recorded in the manifest.
 *
 * Rules are a closed set defined here — the manifest only references them by
 * name. Arbitrary regex cannot be injected through the manifest.
 */
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEX = '[0-9a-f]+';

const RULES = {
    'netlify-cdp': {
        // Matches Netlify's CDP snippet injected at CDN serve time.
        // Only whitespace is allowed between the opening tag and the script tag, so
        // extra content cannot be hidden inside the stripped block.
        pattern: new RegExp(
            `<div data-netlify-deploy-id="${HEX}" data-netlify-site-id="${UUID}" data-vcs="github" style="position:fixed">\\s*<script async src="/.netlify/scripts/cdp"></script>\\s*</div>`,
            'g'
        ),
        appliesTo: ['.html', '.htm'],
    },
};

const getFileExtension = (fileKey, isNavigation = false) => {
    const filename = fileKey
        .slice(fileKey.lastIndexOf('/') + 1)
        .split('?')[0]
        .split('#')[0];
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx >= 0) return filename.slice(dotIdx).toLowerCase();
    // Navigation request with no extension (e.g. "/" or "/docs") → treat as HTML,
    // mirroring matchManifestPath's directory→index.html remapping.
    return isNavigation ? '.html' : '';
};

/**
 * Apply named strip rules from the manifest to normalize content before hashing.
 * Unknown rule names are silently skipped.
 * @param {ArrayBuffer} buffer - Raw file bytes
 * @param {string[]} ruleNames - Rule names from the manifest (e.g. ['netlify-cdp'])
 * @param {string} fileKey - Used to match appliesTo extensions
 * @param {boolean} [isNavigation] - When true, extensionless paths are treated as HTML
 * @returns {ArrayBuffer|Uint8Array}
 */
export const applyStrips = (buffer, ruleNames, fileKey, isNavigation = false) => {
    if (!ruleNames?.length) {
        return buffer;
    }
    const ext = getFileExtension(fileKey, isNavigation);
    const applicableRules = ruleNames
        .filter((name) => RULES[name]?.appliesTo.includes(ext))
        .map((name) => ({ name, ...RULES[name] }));
    if (!applicableRules.length) {
        return buffer;
    }
    let text = new TextDecoder().decode(buffer);
    for (const name in applicableRules) {
        logger.log(`Stripping ${name} from ${fileKey}`);
        text = text.replace(applicableRules[name].pattern, '');
    }
    return new TextEncoder().encode(text);
};
