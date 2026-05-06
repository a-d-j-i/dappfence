/**
 * Post-build manifest generation.
 *
 * 1. Walks the output directory and collects security-critical files.
 * 2. Injects the dappfence.js script tag into every HTML file.
 * 3. Computes SRI hashes and optionally signs the manifest.
 * 4. Writes integrity-manifest.json to the output directory.
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { calculateFileHash, signManifest } = require('@dappfence/signer');

export const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.css', '.html', '.htm', '.json', '.svg'];

export function buildScriptAttrs(opts) {
    const attrs = { src: opts.scriptSrc };
    if (opts.manifestUrl) attrs['data-manifest'] = opts.manifestUrl;
    if (opts.manifestSignatureType)
        attrs['data-manifest-signature-type'] = opts.manifestSignatureType;
    if (opts.manifestSignatureIdentity)
        attrs['data-manifest-signature-identity'] = opts.manifestSignatureIdentity;
    if (opts.appSW) attrs['data-app-sw'] = opts.appSW;
    if (opts.warningUrl) attrs['data-warning-url'] = opts.warningUrl;
    return attrs;
}

export function buildScriptTag(opts) {
    const attrStr = Object.entries(buildScriptAttrs(opts))
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
    return `<script ${attrStr}></script>`;
}

export function injectScriptTag(html, scriptTag) {
    // Guard against double-injection on incremental rebuilds.
    if (html.includes(scriptTag)) return html;
    return html.replace(/(<head[^>]*>)/i, `$1\n    ${scriptTag}`);
}

async function walk(base, dir, extensions, excludes, results) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const web = '/' + path.relative(base, abs).replace(/\\/g, '/');
        if (entry.isDirectory()) {
            if (!excludes.some((e) => web.startsWith(e))) {
                await walk(base, abs, extensions, excludes, results);
            }
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (extensions.includes(ext) && !excludes.some((e) => web.startsWith(e))) {
                results.push({ webPath: web, absPath: abs });
            }
        }
    }
}

/**
 * Extract server-rendered route patterns from the Astro routes array.
 * Returns route strings like '/blog/[slug]' and '/_server-islands/[name]'.
 *
 * Astro marks every route with `isPrerendered`. Routes that are not
 * prerendered are rendered on demand (SSR pages, server islands, API routes).
 * The SW can use these patterns in the future to skip full hash verification
 * for requests that match them.
 */
function extractDynamicRoutes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter((r) => !r.isPrerendered)
        .map((r) => r.pattern)
        .filter(Boolean);
}

export async function generateManifest({
    outDir,
    routes,
    manifestPath,
    extensions,
    exclude,
    secretKey,
    scriptOpts,
    logger,
}) {
    const exts = extensions || DEFAULT_EXTENSIONS;
    // Always exclude the manifest file itself to avoid a circular reference.
    const excludes = [...(exclude || []), '/' + manifestPath];

    const dynamicRoutes = extractDynamicRoutes(routes);
    if (dynamicRoutes.length) {
        logger.info(`DappFence: ${dynamicRoutes.length} dynamic (SSR) routes captured`);
    }

    const files = [];
    await walk(outDir, outDir, exts, excludes, files);
    logger.info(`DappFence: hashing ${files.length} files`);

    const scriptTag = scriptOpts ? buildScriptTag(scriptOpts) : null;

    const fileHashes = {};
    for (const { webPath, absPath } of files) {
        let buf = await fs.readFile(absPath);

        const isHtml = absPath.endsWith('.html') || absPath.endsWith('.htm');
        if (isHtml && scriptTag) {
            const html = buf.toString('utf8');
            const injected = injectScriptTag(html, scriptTag);
            if (injected !== html) {
                await fs.writeFile(absPath, injected, 'utf8');
                buf = Buffer.from(injected, 'utf8');
                logger.info(`DappFence: injected script tag into ${webPath}`);
            }
        }

        fileHashes[webPath] = calculateFileHash(buf);
    }

    const payload = {
        files: fileHashes,
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
