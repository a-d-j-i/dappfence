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

export function extractDynamicRoutes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter((r) => !r.isPrerendered)
        .map((r) => r.pattern)
        .filter(Boolean);
}

export async function buildIntegrityManifest({
    outDir,
    routes,
    manifestPath,
    extensions,
    exclude,
    secretKey,
    mode,
    filters,
    knownHashes,
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

    if (knownHashes) {
        for (const [url, hashes] of Object.entries(knownHashes)) {
            fileHashes[url] = hashes;
        }
        logger.info(`DappFence: added ${Object.keys(knownHashes).length} known-hash entries`);
    }

    const payload = {
        files: fileHashes,
        mode,
        ...(filters?.length && { filters }),
        metadata: {
            extensions: exts,
            buildTime: new Date().toISOString(),
            version: 'latest',
            ...(dynamicRoutes.length && { dynamicRoutes }),
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
