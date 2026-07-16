import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const _require = createRequire(import.meta.url);
const { extractInlineScriptHashes, extractInlineAttrHashes, extractInlineHashesFromHtml } =
    _require('@dappfence/manifest-tools/inline-scripts');

export function routePatternToProbeUrl(pattern) {
    return pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, '__probe__')
        .replace(/\[([^\]]+)\]/g, '__probe__');
}

export function routePatternToPrefixKey(pattern) {
    const firstBracket = pattern.indexOf('[');
    if (firstBracket === -1) return pattern;
    const prefix = pattern.slice(0, pattern.lastIndexOf('/', firstBracket) + 1);
    return prefix || '/';
}

function sriHash(buf) {
    return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

function htmlFileToUrlPath(relPath) {
    const noExt = relPath.replace(/\.html$/, '');
    const urlPath = '/' + noExt.replace(/\\/g, '/');
    return urlPath === '/index' ? '/' : urlPath;
}

async function walkHtmlFiles(dir, baseDir, hashes, cspPages, logger) {
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkHtmlFiles(abs, baseDir, hashes, cspPages, logger);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            const rel = path.relative(baseDir, abs);
            const base = path.basename(rel);
            // Skip Next.js internal pages (_not-found, _error, _document, _app)
            if (base.startsWith('_')) continue;
            const urlPath = htmlFileToUrlPath(rel);
            const buf = await fs.readFile(abs);
            hashes[urlPath] = sriHash(buf);
            logger.info(`DappFence: hashed pre-rendered page ${urlPath}`);
            try {
                const [scriptResult, attrResult] = await Promise.all([
                    extractInlineScriptHashes(abs),
                    extractInlineAttrHashes(abs),
                ]);
                const scripts = scriptResult.hashes;
                const attrs = attrResult.attrs.map((a) => a.hash);
                if (scripts.length || attrs.length) {
                    cspPages[urlPath] = { scripts, attrs };
                }
            } catch (err) {
                logger.warn(`DappFence: CSP hash extraction failed for ${urlPath}: ${err.message}`);
            }
        }
    }
}

/**
 * Read pre-rendered HTML files written by `next build` and return a
 * { webPath → sriHash } map. Covers App Router (○ / ●) and Pages Router
 * pages. Requires no server — the files are already on disk after build.
 *
 * @param {string} projectRoot
 * @param {string} basePath  - Optional Next.js basePath prefix (e.g. '/app')
 * @param {object} logger
 * @returns {Promise<Record<string,string>>}
 */
export async function hashPrerenderedPages(projectRoot, basePath, logger) {
    const serverDir = path.join(projectRoot, '.next', 'server');
    const hashes = {};
    const cspPages = {};

    await walkHtmlFiles(
        path.join(serverDir, 'app'),
        path.join(serverDir, 'app'),
        hashes,
        cspPages,
        logger
    );
    await walkHtmlFiles(
        path.join(serverDir, 'pages'),
        path.join(serverDir, 'pages'),
        hashes,
        cspPages,
        logger
    );

    if (!basePath) return { bodyHashes: hashes, cspPages };

    const prefixedHashes = {};
    const prefixedCsp = {};
    for (const [urlPath, hash] of Object.entries(hashes)) {
        prefixedHashes[basePath + urlPath] = hash;
    }
    for (const [urlPath, entry] of Object.entries(cspPages)) {
        prefixedCsp[basePath + urlPath] = entry;
    }
    return { bodyHashes: prefixedHashes, cspPages: prefixedCsp };
}

/**
 * Start the built Next.js SSR server on a random port, fetch each fixedRoute,
 * probe each probedPattern with a sentinel value, and return body hashes and
 * inline-script CSP hashes. The server is closed after all routes are processed.
 *
 * fixedRoutes  — SSR pages with no URL params: fetched, body-hashed, CSP-hashed.
 * probedPatterns — parameterised routes: one sentinel fetch per unique prefix,
 *                  CSP hashes only (body is dynamic and not stored).
 *
 * @param {string}   projectRoot    - Absolute path to the Next.js project root.
 * @param {string[]} fixedRoutes    - Exact web paths to fetch (e.g. ['/dashboard'])
 * @param {string[]} probedPatterns - Route patterns with '[' params (e.g. ['/blog/[slug]'])
 * @param {object}   logger
 * @returns {Promise<{ bodyHashes: Record<string,string>, cspPages: Record<string,object> }>}
 */
export async function hashSSRRoutes(projectRoot, fixedRoutes, probedPatterns, logger) {
    if (!fixedRoutes.length && !probedPatterns.length) {
        return { bodyHashes: {}, cspPages: {} };
    }

    let app, nextHandler;
    try {
        // Resolve `next` relative to projectRoot so symlinked packages find the
        // user's installed copy rather than resolving from this file's real path.
        const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
        const nextPath = projectRequire.resolve('next');
        const { default: next } = await import(pathToFileURL(nextPath).href);
        app = next({ dev: false, dir: projectRoot });
        await app.prepare();
        nextHandler = app.getRequestHandler();
    } catch (err) {
        logger.warn(
            `DappFence: could not start Next.js programmatic server — ${err.message}; skipping SSR route hashing`
        );
        return { bodyHashes: {}, cspPages: {} };
    }

    const server = createServer((req, res) => nextHandler(req, res));
    const port = await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.once('error', reject);
    });

    const bodyHashes = {};
    const cspPages = {};

    try {
        for (const webPath of fixedRoutes) {
            try {
                const res = await fetch(`http://127.0.0.1:${port}${webPath}`);
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length === 0) {
                    logger.warn(
                        `DappFence: SSR route ${webPath} returned empty body (HTTP ${res.status}); skipping`
                    );
                    continue;
                }
                const finalPath = new URL(res.url).pathname;
                bodyHashes[finalPath] = sriHash(buf);
                const statusNote = res.ok ? '' : ` (HTTP ${res.status})`;
                logger.info(
                    `DappFence: hashed SSR route ${webPath}${finalPath !== webPath ? ` → ${finalPath}` : ''}${statusNote}`
                );
                const contentType = res.headers.get('content-type') ?? '';
                if (contentType.includes('text/html')) {
                    try {
                        const { scripts, attrs, warnings } = extractInlineHashesFromHtml(
                            buf.toString('utf8')
                        );
                        for (const w of warnings) {
                            logger.warn(`DappFence: ${finalPath}: ${w}`);
                        }
                        if (scripts.length || attrs.length) {
                            cspPages[finalPath] = { scripts, attrs };
                        }
                    } catch (err) {
                        logger.warn(
                            `DappFence: CSP hash extraction failed for ${finalPath}: ${err.message}`
                        );
                    }
                }
            } catch (err) {
                logger.warn(
                    `DappFence: failed to hash SSR route ${webPath} — ${err.message}; skipping`
                );
            }
        }

        // Probe each unique prefix once with a sentinel URL; extract CSP hashes only.
        const probedPrefixes = new Set();
        for (const pattern of probedPatterns) {
            const prefixKey = routePatternToPrefixKey(pattern);
            if (probedPrefixes.has(prefixKey)) {
                continue;
            }
            probedPrefixes.add(prefixKey);

            const probeUrl = routePatternToProbeUrl(pattern);
            try {
                const res = await fetch(`http://127.0.0.1:${port}${probeUrl}`);
                const buf = Buffer.from(await res.arrayBuffer());
                if (buf.length === 0) {
                    logger.warn(`DappFence: probe ${pattern} returned empty body; skipping`);
                    continue;
                }
                const contentType = res.headers.get('content-type') ?? '';
                if (!contentType.includes('text/html')) {
                    logger.warn(
                        `DappFence: probe ${pattern} returned non-HTML (${contentType}); skipping`
                    );
                    continue;
                }
                try {
                    const { scripts, attrs, warnings } = extractInlineHashesFromHtml(
                        buf.toString('utf8')
                    );
                    for (const w of warnings) {
                        logger.warn(`DappFence: ${pattern} (probe): ${w}`);
                    }
                    if (scripts.length || attrs.length) {
                        cspPages[prefixKey] = { scripts, attrs };
                        logger.info(
                            `DappFence: probed ${pattern} → CSP prefix ${prefixKey} (${scripts.length} script, ${attrs.length} attr hash(es))`
                        );
                    } else {
                        logger.info(`DappFence: probed ${pattern} — no inline scripts found`);
                    }
                } catch (err) {
                    logger.warn(
                        `DappFence: CSP hash extraction failed for probe ${pattern}: ${err.message}`
                    );
                }
            } catch (err) {
                logger.warn(`DappFence: probe failed for ${pattern} — ${err.message}; skipping`);
            }
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
        try {
            await app.close();
        } catch {
            // app.close() is not available in all Next.js versions
        }
    }

    return { bodyHashes, cspPages };
}

/**
 * Hash all files in public/ and return a { webPath → sriHash } map.
 * These are served at the root URL and must be in the manifest so the SW
 * can verify them (dappfence.js, favicons, robots.txt, etc.).
 * Excludes the manifest file itself.
 *
 * @param {string} projectRoot
 * @param {string} manifestFileName - filename of the manifest to exclude (e.g. 'integrity-manifest.json')
 * @param {string} basePath
 * @param {object} logger
 * @returns {Promise<Record<string,string>>}
 */
export async function hashPublicFiles(projectRoot, manifestFileName, basePath, logger) {
    const publicDir = path.join(projectRoot, 'public');
    const hashes = {};

    async function walk(dir) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(abs);
            } else if (entry.isFile()) {
                const rel = path.relative(publicDir, abs);
                // Skip the manifest file — it's bootstrapped separately
                if (rel === manifestFileName) continue;
                const urlPath = (basePath || '') + '/' + rel.replace(/\\/g, '/');
                const buf = await fs.readFile(abs);
                hashes[urlPath] = sriHash(buf);
                logger.info(`DappFence: hashed public file ${urlPath}`);
            }
        }
    }

    await walk(publicDir);
    return hashes;
}
