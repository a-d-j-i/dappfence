import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const _require = createRequire(import.meta.url);
const {
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    generateManifest: _generateManifest,
    buildNetlifyContentRules,
    resolveNetlifyCdpHashes,
} = _require('@dappfence/manifest-tools/manifest');
const { extractInlineHashesFromHtml } = _require('@dappfence/manifest-tools/inline-scripts');

export { buildScriptAttrs, buildScriptTag, injectScriptTag };

/**
 * Generate a probe URL from a route pattern by substituting every parameter
 * segment with a sentinel value. The probe is fetched at build time to extract
 * stable inline script hashes without requiring concrete IDs.
 *
 * @param {string} pattern - e.g. '/partials/dynamic/[id]'
 * @returns {string} - e.g. '/partials/dynamic/__probe__'
 */
export function routePatternToProbeUrl(pattern) {
    return pattern
        .replace(/\[\.\.\.([^\]]+)\]/g, '__probe__')
        .replace(/\[([^\]]+)\]/g, '__probe__');
}

/**
 * Derive the prefix key used to store probe CSP hashes in the manifest.
 * Strips everything from the first parameter segment onward, keeping the
 * leading path up to and including the last '/' before that segment.
 *
 * @param {string} pattern - e.g. '/partials/dynamic/[id]'
 * @returns {string} - e.g. '/partials/dynamic/'
 */
export function routePatternToPrefixKey(pattern) {
    const firstBracket = pattern.indexOf('[');
    if (firstBracket === -1) return pattern;
    const prefix = pattern.slice(0, pattern.lastIndexOf('/', firstBracket) + 1);
    return prefix || '/';
}

/**
 * Extract probedRoute patterns — SSR routes with URL parameters.
 * These cannot be fetched for a body hash (IDs are not enumerable), but can
 * be probed with a sentinel value to extract stable inline script CSP hashes.
 * Includes routes that also have getStaticPaths (enumerableRoute); the probe provides
 * a prefix-based fallback for any IDs not covered by the enumeration.
 *
 * @param {object[]} routes - Astro resolved routes
 * @returns {string[]} route patterns
 */
export function extractProbedPatterns(routes) {
    if (!routes?.length) return [];
    return routes
        .filter(
            (r) =>
                !r.isPrerendered &&
                r.type !== 'redirect' &&
                r.params?.length > 0 &&
                !r.pattern?.startsWith('/_')
        )
        .map((r) => r.pattern)
        .filter(Boolean);
}

/**
 * Extract server-rendered route patterns from the Astro routes array.
 * Routes not marked isPrerendered are SSR (pages, server islands, API routes).
 */
export function extractDynamicRoutes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter((r) => !r.isPrerendered)
        .map((r) => r.pattern)
        .filter(Boolean);
}

/**
 * Extract fixedRoute SSR routes — SSR with no URL parameters.
 * These have a fixed URL and a deterministic response body, so they can be
 * fetched and hashed at build time without any param enumeration.
 */
export function extractFixedRoutes(routes) {
    if (!routes?.length) return [];
    return routes
        .filter(
            (r) =>
                !r.isPrerendered &&
                r.type !== 'redirect' &&
                (!r.params || r.params.length === 0) &&
                !r.pattern?.startsWith('/_')
        )
        .map((r) => r.pattern)
        .filter(Boolean);
}

/**
 * Find the Vite-compiled server chunk for a given source component.
 * Vite normalizes special characters ([ ]) to underscores in chunk filenames.
 */
async function findRouteChunk(serverDir, componentPath) {
    const basename = path.basename(componentPath, path.extname(componentPath));
    const normalized = basename.replace(/[[\]]/g, '_');
    const chunksDir = path.join(serverDir, 'chunks');
    let entries;
    try {
        entries = await fs.readdir(chunksDir);
    } catch {
        return null;
    }
    const match = entries.find(
        (e) => e.endsWith('.mjs') && (e.startsWith(normalized + '_') || e === normalized + '.mjs')
    );
    return match ? path.join(chunksDir, match) : null;
}

/**
 * Extract enumerableRoute SSR routes — parameterized SSR routes that export getStaticPaths().
 * Imports each route's compiled chunk, calls getStaticPaths(), and uses route.generate()
 * to build the concrete web paths to hash.
 *
 * @param {object[]} routes    - Astro resolved routes
 * @param {string}   serverDir - Absolute path to the compiled server directory
 * @param {object}   logger    - Astro integration logger
 * @returns {Promise<string[]>}
 */
export async function extractEnumerableRoutes(routes, serverDir, logger) {
    if (!routes?.length) return [];

    const candidates = routes.filter(
        (r) =>
            !r.isPrerendered &&
            r.type !== 'redirect' &&
            r.params?.length > 0 &&
            typeof r.entrypoint === 'string'
    );

    if (!candidates.length) return [];

    const results = [];
    for (const route of candidates) {
        const chunkPath = await findRouteChunk(serverDir, route.entrypoint);
        if (!chunkPath) {
            logger.warn(
                `DappFence: no compiled chunk found for ${route.entrypoint}; skipping enumerableRoute hashing`
            );
            continue;
        }

        let pageModule;
        try {
            const mod = await import(chunkPath);
            // Astro compiles pages to export a `page` factory; call it to get the module object.
            pageModule = typeof mod.page === 'function' ? mod.page() : mod;
        } catch (err) {
            logger.warn(
                `DappFence: could not import chunk for ${route.entrypoint} — ${err.message}; skipping`
            );
            continue;
        }

        if (typeof pageModule?.getStaticPaths !== 'function') continue;

        let staticPaths;
        try {
            staticPaths = await pageModule.getStaticPaths();
        } catch (err) {
            logger.warn(
                `DappFence: getStaticPaths() failed for ${route.entrypoint} — ${err.message}; skipping`
            );
            continue;
        }

        if (!Array.isArray(staticPaths)) continue;

        for (const { params } of staticPaths) {
            let webPath = route.pattern;
            for (const [key, value] of Object.entries(params)) {
                webPath = webPath.replace(`[...${key}]`, value).replace(`[${key}]`, value);
            }
            if (webPath && !webPath.includes('[')) results.push(webPath);
        }
    }

    return results;
}

export function sriHash(buf) {
    return `sha256-${createHash('sha256').update(buf).digest('base64')}`;
}

/**
 * Start the built Astro SSR server on a random port, fetch each fixedRoute,
 * and return a { webPath → sriHash } map. The server is closed after all routes
 * are fetched.
 *
 * @param {string}   entryMjsPath - Absolute path to the compiled entry.mjs
 * @param {string[]} routes       - Web paths to fetch and hash (e.g. ['/api/version.json'])
 * @param {object}   logger       - Astro integration logger
 * @returns {Promise<Record<string,string>>}
 */
export async function hashSSRRoutes(entryMjsPath, routes, logger, probedPatterns = []) {
    if (!routes.length && !probedPatterns.length) return { bodyHashes: {}, cspPages: {} };

    process.env.ASTRO_NODE_AUTOSTART = 'disabled';
    let handler;
    try {
        const mod = await import(entryMjsPath);
        handler = mod.handler;
    } catch (err) {
        logger.warn(`DappFence: could not import SSR entry — ${err.message}; skipping SSR hashing`);
        return { bodyHashes: {}, cspPages: {} };
    } finally {
        delete process.env.ASTRO_NODE_AUTOSTART;
    }

    if (typeof handler !== 'function') {
        logger.warn('DappFence: SSR entry did not export a handler function; skipping SSR hashing');
        return { bodyHashes: {}, cspPages: {} };
    }

    const server = createServer(handler);
    const port = await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        server.once('error', reject);
    });

    const bodyHashes = {};
    const cspPages = {};
    try {
        for (const webPath of routes) {
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

        // probedRoute: probe each unique prefix once with a sentinel URL.
        // Only CSP hashes are extracted — body hash is discarded (content is dynamic).
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
    }

    return { bodyHashes, cspPages };
}

export function buildPageSet(pages) {
    const set = new Set();
    for (const { pathname } of pages) {
        const base = pathname.replace(/\/$/, '');
        set.add(base ? `${base}/index.html` : '/index.html');
        if (base) set.add(`${base}.html`);
    }
    return set;
}

/**
 * Build pathRules based on Astro's output format.
 * 'directory' (default) → directory-index; 'file' → html-extension.
 */
export function buildPathRules(buildFormat, notFoundKey = null) {
    const rules = [];
    if (buildFormat === 'file') {
        rules.push({ type: 'html-extension' });
    } else {
        rules.push({ type: 'directory-index' });
    }
    if (notFoundKey) {
        rules.push({ type: 'not-found', fallback: notFoundKey });
    }
    return rules;
}

/**
 * Build contentRules for this deployment environment.
 * Netlify injects a CDP snippet into served HTML; strip it before hashing,
 * and verify (then rewrite) the CDP script itself.
 */
export function buildContentRules({ isNetlify = false } = {}) {
    return isNetlify ? buildNetlifyContentRules() : [];
}

export async function generateManifest({
    pages,
    routes,
    buildFormat,
    extraHashes,
    cspPages,
    base = '',
    netlify = false,
    logger,
    ...rest
}) {
    const prefixRoute = base ? (r) => base + r : (r) => r;
    const pageSet = pages?.length ? buildPageSet(pages) : null;
    const isNetlify = Boolean(process.env.NETLIFY) || Boolean(netlify);

    // Determine the not-found fallback key for the `not-found` pathRule.
    // Prefer the SSR-hashed 404 page; fall back to the prerendered static 404.
    // extraHashes keys are already prefixed with base (from hashSSRRoutes response URLs).
    const notFoundKey = extraHashes?.[base + '/404/']
        ? base + '/404/'
        : extraHashes?.[base + '/404']
          ? base + '/404'
          : pages?.some((p) => p.pathname === '404/' || p.pathname === '/404/')
            ? base + (buildFormat === 'file' ? '/404.html' : '/404/index.html')
            : null;

    const cdpHashes = isNetlify ? await resolveNetlifyCdpHashes(logger) : null;
    const mergedExtraHashes = {
        ...(cdpHashes && { '/.netlify/scripts/cdp': cdpHashes }),
        ...(extraHashes || {}),
    };

    // All dynamic (SSR) routes must appear in csp.pages so the SW knows to inject
    // CSP headers for them. Routes with inline scripts already have entries from
    // hashSSRRoutes; add empty entries for the rest. Parameterised routes use a
    // prefix key (e.g. '/partials/[id]' → '/partials/') for startsWith matching.
    //
    // Each dynamic-route prefix also becomes a contentRule with action `csp` so
    // the SW skips hash-verify for those routes (their content varies per request)
    // while still applying CSP. Static prerendered pages have no matching rule
    // and fall through to the SW's default `verify`.
    const completeCspPages = { ...(cspPages ?? {}) };
    const cspRules = [];
    const seenPrefixes = new Set();
    for (const route of extractDynamicRoutes(routes)) {
        const key = prefixRoute(routePatternToPrefixKey(route));
        if (!(key in completeCspPages)) {
            completeCspPages[key] = { scripts: [], attrs: [] };
        }
        if (!seenPrefixes.has(key)) {
            seenPrefixes.add(key);
            cspRules.push({
                condition: { resourceTypes: ['document'], urlFilter: key },
                action: { type: 'csp' },
            });
        }
    }

    return _generateManifest({
        ...rest,
        logger,
        pathRules: buildPathRules(buildFormat, notFoundKey),
        contentRules: [...cspRules, ...buildContentRules({ isNetlify })],
        // walk() generates keys as base + '/...' when pathPrefix is set; strip the
        // prefix before comparing against pageSet (which is built from page pathnames
        // without the base).
        pageFilter: pageSet
            ? (webPath) => pageSet.has(base ? webPath.slice(base.length) : webPath)
            : undefined,
        pathPrefix: base,
        ...(Object.keys(mergedExtraHashes).length > 0 && { extraHashes: mergedExtraHashes }),
        ...(Object.keys(completeCspPages).length > 0 && { csp: { pages: completeCspPages } }),
    });
}
