import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIntegrityManifest } from './manifest.js';

const _require = createRequire(import.meta.url);
const { deriveIdentity } = _require('@dappfence/signer');
const DAPPFENCE_JS_PATH = _require.resolve('@dappfence/core');

const DEFAULTS = {
    scriptSrc: '/dappfence.js',
    manifestUrl: '/integrity-manifest.json',
    manifestSignatureType: 'noble-secp256k1-recovered-eth',
    mode: 'protected',
    appSW: null,
    warningUrl: null,
    manifestPath: 'integrity-manifest.json',
    extensions: null,
    exclude: [],
    strips: null,
};

// Multiple signals: NETLIFY_SITE_ID and NETLIFY_BUILD_BASE are present even
// when building in third-party CI (e.g. GitHub Actions) deploying to Netlify.
function detectNetlify() {
    return (
        process.env.NETLIFY === 'true' ||
        !!process.env.NETLIFY_SITE_ID ||
        !!process.env.NETLIFY_BUILD_BASE
    );
}

export default function dappfence(options = {}) {
    const opts = { ...DEFAULTS, ...options };

    opts.secretKey = opts.secretKey || process.env.DAPPFENCE_SECRET_KEY || null;

    if (opts.secretKey && !opts.manifestSignatureIdentity) {
        opts.manifestSignatureIdentity = deriveIdentity(opts.secretKey);
    }

    // Astro 6 moved routes out of astro:build:done; capture them here instead.
    let resolvedRoutes = [];

    return {
        name: '@dappfence/astro',
        hooks: {
            // No-op in dev: DappFence needs a static signed manifest, which
            // can't exist when Astro renders pages at request time.
            // Test with `astro build && astro preview`.
            'astro:config:setup'({ logger }) {
                if (!opts.secretKey) {
                    logger.error(
                        'DappFence: secretKey is required. ' +
                            'Pass it via the integration option or set the DAPPFENCE_SECRET_KEY environment variable.'
                    );
                    throw new Error('[@dappfence/astro] secretKey is required');
                }
            },

            'astro:routes:resolved'({ routes }) {
                resolvedRoutes = routes;
            },

            async 'astro:build:done'({ dir, logger }) {
                const outDir = fileURLToPath(dir);

                const destRel = opts.scriptSrc.replace(/^\//, '');
                const destAbs = path.join(outDir, destRel);
                await fs.mkdir(path.dirname(destAbs), { recursive: true });
                await fs.copyFile(DAPPFENCE_JS_PATH, destAbs);
                logger.info(`DappFence: copied dappfence.js → ${destRel}`);

                const autoStrips = detectNetlify() ? ['netlify-cdp'] : [];
                const strips = [...new Set([...(opts.strips ?? []), ...autoStrips])];

                await buildIntegrityManifest({
                    ...opts,
                    strips,
                    outDir,
                    routes: resolvedRoutes,
                    scriptAttrs: opts,
                    logger,
                });
            },
        },
    };
}
