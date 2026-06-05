import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const {
    DEFAULT_EXTENSIONS,
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    generateManifest: _generateManifest,
} = _require('@dappfence/manifest-tools/manifest');

export { DEFAULT_EXTENSIONS, buildScriptAttrs, buildScriptTag, injectScriptTag };

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
export function buildPathRules(buildFormat) {
    if (buildFormat === 'file') {
        return [{ type: 'html-extension' }];
    }
    return [{ type: 'directory-index' }];
}

/**
 * Build contentRules for this deployment environment.
 * Netlify injects a CDP snippet into served HTML; strip it before hashing.
 */
export function buildContentRules({ isNetlify = false } = {}) {
    if (isNetlify) {
        return [
            {
                condition: { resourceTypes: ['document'] },
                action: { type: 'transform', transform: 'netlify-cdp' },
            },
        ];
    }
    return [];
}

export async function generateManifest({ pages, routes, buildFormat, ...rest }) {
    const dynamicRoutes = extractDynamicRoutes(routes);
    const pageSet = pages?.length ? buildPageSet(pages) : null;
    const isNetlify = Boolean(process.env.NETLIFY);
    return _generateManifest({
        ...rest,
        dynamicRoutes,
        pathRules: buildPathRules(buildFormat),
        contentRules: buildContentRules({ isNetlify }),
        pageFilter: pageSet ? (webPath) => pageSet.has(webPath) : undefined,
    });
}
