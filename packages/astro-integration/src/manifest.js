import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { calculateFileHash, signManifest } = require('@dappfence/signer');

export const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.css', '.html', '.htm', '.json', '.svg'];

export function buildScriptAttrs(scriptAttrs) {
    const attrs = { src: scriptAttrs.scriptSrc };
    if (scriptAttrs.manifestUrl) attrs['data-manifest'] = scriptAttrs.manifestUrl;
    if (scriptAttrs.manifestSignatureType)
        attrs['data-manifest-signature-type'] = scriptAttrs.manifestSignatureType;
    if (scriptAttrs.manifestSignatureIdentity)
        attrs['data-manifest-signature-identity'] = scriptAttrs.manifestSignatureIdentity;
    if (scriptAttrs.appSW) attrs['data-app-sw'] = scriptAttrs.appSW;
    if (scriptAttrs.warningUrl) attrs['data-warning-url'] = scriptAttrs.warningUrl;
    return attrs;
}

export function buildScriptTag(scriptAttrs) {
    const attrStr = Object.entries(buildScriptAttrs(scriptAttrs))
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
    return `<script ${attrStr}></script>`;
}

export function injectScriptTag(html, scriptAttrs) {
    const tag = buildScriptTag(scriptAttrs);
    // Guard against double-injection on incremental rebuilds.
    if (html.includes(tag)) return html;
    return html.replace(/(<head[^>]*>)/i, `$1\n    ${tag}`);
}

async function walk(base, dir, extensions, excludes) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
        entries.map(async (entry) => {
            const abs = path.join(dir, entry.name);
            const web = '/' + path.relative(base, abs).replace(/\\/g, '/');
            if (entry.isDirectory()) {
                if (excludes.some((e) => web.startsWith(e))) return [];
                return walk(base, abs, extensions, excludes);
            }
            if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (extensions.includes(ext) && !excludes.some((e) => web.startsWith(e))) {
                    return [{ webPath: web, absPath: abs, ext }];
                }
            }
            return [];
        })
    );
    return results.flat();
}

/**
 * Extract patterns for non-prerendered (SSR) routes.
 * @param {Array} routes
 * @returns {string[]}
 */
export function extractDynamicRoutes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter((r) => !r.isPrerendered)
        .map((r) => r.pattern)
        .filter(Boolean);
}

/**
 * Build contentRule allow entries for dynamic (SSR) routes.
 * Uses the longest non-parameterized prefix of each route pattern as urlFilter.
 * Routes whose first segment is already dynamic (prefix = '/') are skipped —
 * a single-character urlFilter would match everything.
 *
 * @param {string[]} dynamicRoutes - Route patterns e.g. ['/_server-islands/[name]']
 * @returns {Array} contentRule objects
 */
export function buildDynamicRouteAllowRules(dynamicRoutes) {
    return dynamicRoutes
        .map((pattern) => {
            const idx = pattern.search(/\[|\*/);
            const prefix = idx === -1 ? pattern : pattern.slice(0, idx);
            // Skip if the prefix is trivially short (just '/' matches everything).
            if (prefix.length <= 1) return null;
            return { condition: { urlFilter: prefix }, action: { type: 'allow' } };
        })
        .filter(Boolean);
}

/**
 * Derive pathRules from Astro's build.format setting.
 * @param {'directory'|'file'|'preserve'|undefined} buildFormat
 * @returns {Array}
 */
export function buildPathRules(buildFormat) {
    if (buildFormat === 'directory') return [{ type: 'directory-index' }];
    if (buildFormat === 'file') return [{ type: 'html-extension' }];
    return [];
}

export async function buildIntegrityManifest({
    outDir,
    routes,
    manifestPath,
    extensions,
    exclude,
    secretKey,
    mode,
    buildFormat,
    contentRules,
    additionalFiles,
    logger,
    scriptAttrs,
}) {
    const exts = extensions || DEFAULT_EXTENSIONS;
    // Always exclude the manifest file itself to avoid a circular reference.
    const excludes = [...(exclude || []), '/' + manifestPath];

    const dynamicRoutes = extractDynamicRoutes(routes);
    if (dynamicRoutes.length) {
        logger.info(`DappFence: ${dynamicRoutes.length} dynamic (SSR) routes captured`);
    }

    const files = await walk(outDir, outDir, exts, excludes);
    logger.info(`DappFence: hashing ${files.length} files`);

    const fileHashes = {};
    for (const { webPath, absPath, ext } of files) {
        let buf = await fs.readFile(absPath);

        // Partials without a <head> tag are naturally skipped by injectScriptTag.
        if (ext === '.html' || ext === '.htm') {
            const html = buf.toString('utf8');
            const injected = injectScriptTag(html, scriptAttrs);
            if (injected !== html) {
                await fs.writeFile(absPath, injected, 'utf8');
                buf = Buffer.from(injected, 'utf8');
                logger.info(`DappFence: injected script tag into ${webPath}`);
            }
        }

        fileHashes[webPath] = calculateFileHash(buf);
    }

    // Merge any additional file hash entries (e.g. known CDN script hashes).
    if (additionalFiles) {
        for (const [url, hashes] of Object.entries(additionalFiles)) {
            fileHashes[url] = hashes;
        }
        logger.info(
            `DappFence: added ${Object.keys(additionalFiles).length} additional file entries`
        );
    }

    const pathRules = buildPathRules(buildFormat);

    // Combine caller-provided contentRules with allow rules for SSR routes.
    const dynamicAllowRules = buildDynamicRouteAllowRules(dynamicRoutes);
    const allContentRules = [...(contentRules || []), ...dynamicAllowRules];

    const payload = {
        files: fileHashes,
        ...(pathRules.length && { pathRules }),
        ...(allContentRules.length && { contentRules: allContentRules }),
        mode,
        metadata: {
            extensions: exts,
            buildTime: new Date().toISOString(),
            version: 'latest',
        },
    };

    let manifest;
    if (secretKey) {
        try {
            manifest = signManifest(payload, { secretKey });
            logger.info('DappFence: manifest signed');
        } catch (err) {
            logger.error(`DappFence: signing failed — ${err.message}`);
            manifest = { pay: payload };
        }
    } else {
        manifest = { pay: payload };
        logger.warn('DappFence: no signing keys provided, manifest is unsigned');
    }

    const out = path.join(outDir, manifestPath);
    await fs.writeFile(out, JSON.stringify(manifest, null, 2), 'utf8');
    logger.info(`DappFence: manifest written → ${manifestPath}`);
}
