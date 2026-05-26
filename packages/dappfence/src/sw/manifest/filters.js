/**
 * Filter rules for CDN content normalization.
 *
 * CDN platforms inject HTML snippets and load external scripts at serve time,
 * after the build output has been hashed and signed. Without normalization,
 * every injected byte would cause a hash mismatch and trigger a security alert
 * on every page load — making the framework unusable on CDN-hosted sites.
 *
 * A filter rule handles two distinct problems caused by CDN injection:
 *
 * 1. HTML mutation (`pattern` + `appliesTo`): the CDN injects a snippet into
 *    HTML files. The pattern is stripped before hashing so the computed hash
 *    matches the pre-injection content recorded in the manifest.
 *
 * 2. External script loading (`rewriteUrls`): the injected snippet loads a
 *    script from a URL that is not part of the build output and therefore has
 *    no entry in the manifest. Simply skipping verification for that URL would
 *    be a security hole — an attacker who can influence CDN infrastructure
 *    could serve malicious JS there. Instead the SW intercepts the response
 *    and replaces its body with a safe empty stub (REWRITE verdict), so the
 *    script is neutralized regardless of what the CDN actually serves.
 *    If the CDN script content is stable and known, its hash(es) can be added
 *    to `manifest.files` for that URL; the normal MATCH/MISMATCH verification
 *    path then applies and the real script is allowed through only when it
 *    matches a known-good hash.
 *
 * Rules are a closed set defined here — the manifest only references them by
 * name. Arbitrary patterns cannot be injected through the manifest.
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
        appliesTo: ['.html', '.htm'],
        // The injected script is served by Netlify infrastructure and not in the build
        // output. Rather than skipping verification entirely, the SW rewrites it with an
        // empty stub, so CDN-injected JS never executes even if the file is tampered with.
        rewriteUrls: ['/.netlify/scripts/cdp'],
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
 * Return true if the given fileKey should be rewritten by an active filter rule.
 * @param {string[]} ruleNames
 * @param {string} fileKey
 * @returns {boolean}
 */
export const isFilterRewrite = (ruleNames, fileKey) => {
    if (!ruleNames?.length) return false;
    return ruleNames.some((name) => RULES[name]?.rewriteUrls?.includes(fileKey));
};

/**
 * Apply named filter rules from the manifest to normalize content before hashing.
 * Unknown rule names are silently skipped.
 * @param {ArrayBuffer} buffer - Raw file bytes
 * @param {string[]} ruleNames - Rule names from the manifest (e.g. ['netlify-cdp'])
 * @param {string} fileKey - Used to match appliesTo extensions
 * @param {boolean} [isNavigation] - When true, extensionless paths are treated as HTML
 * @returns {ArrayBuffer|Uint8Array}
 */
export const applyFilters = (buffer, ruleNames, fileKey, isNavigation = false) => {
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
    for (const rule of applicableRules) {
        logger.log(`Applying filter ${rule.name} to ${fileKey}`);
        text = text.replace(rule.pattern, '');
    }
    return new TextEncoder().encode(text);
};
