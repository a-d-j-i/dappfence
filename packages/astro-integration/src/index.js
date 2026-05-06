/**
 * @dappfence/astro — Astro integration
 *
 * Usage in astro.config.mjs:
 *
 *   import dappfence from '@dappfence/astro';
 *
 *   export default defineConfig({
 *     integrations: [
 *       dappfence({
 *         secretKey: process.env.DAPPFENCE_SECRET_KEY,
 *       }),
 *     ],
 *   });
 *
 */
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDappFenceVitePlugin } from './vite-plugin.js';
import { generateManifest } from './manifest.js';

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
};

export default function dappfence(options = {}) {
    const opts = { ...DEFAULTS, ...options };

    // Resolve secretKey: explicit option takes precedence over env var.
    opts.secretKey = opts.secretKey || process.env.DAPPFENCE_SECRET_KEY || null;

    // Derive the signer identity from secretKey so users don't have to supply it.
    if (opts.secretKey && !opts.manifestSignatureIdentity) {
        opts.manifestSignatureIdentity = deriveIdentity(opts.secretKey);
    }

    // Captured in astro:routes:resolved (Astro 6 moved routes out of build:done).
    let resolvedRoutes = [];

    return {
        name: '@dappfence/astro',
        hooks: {
            // Runs once at startup (dev and build).
            // Registers the Vite plugin so that Vite's transformIndexHtml pipeline
            // can inject the script tag during Vite-controlled builds. In practice
            // Astro bypasses this for its own SSG output, so the real injection
            // happens in astro:build:done (prod). DappFence is intentionally a
            // no-op in dev — Vite transforms files at request time, so hash
            // verification cannot work against a static manifest.
            'astro:config:setup'({ updateConfig, logger }) {
                if (!opts.secretKey) {
                    logger.error(
                        'DappFence: secretKey is required. ' +
                            'Pass it via the integration option or set the DAPPFENCE_SECRET_KEY environment variable.'
                    );
                    throw new Error('[@dappfence/astro] secretKey is required');
                }
                updateConfig({
                    vite: {
                        plugins: [createDappFenceVitePlugin(opts)],
                    },
                });
            },

            // Fires after Astro resolves all routes (dev and build).
            // Captures the route list so astro:build:done can record dynamic
            // (non-pre-rendered) routes in the manifest metadata.
            'astro:routes:resolved'({ routes }) {
                resolvedRoutes = routes;
            },

            // Production build only. After Astro has written all HTML files to
            // disk, this hook:
            //   1. Copies dappfence.js from @dappfence/core to outDir so it is
            //      served at the path declared in scriptSrc (default /dappfence.js).
            //   2. Injects the script tag into every HTML file (Astro's SSG
            //      pipeline writes files directly, bypassing Vite's HTML pipeline).
            //   3. Hashes every tracked file (JS, CSS, HTML, …).
            //   4. Signs and writes integrity-manifest.json to the output dir.
            async 'astro:build:done'({ dir, pages, logger }) {
                const outDir = fileURLToPath(dir);

                const destRel = opts.scriptSrc.replace(/^\//, '');
                const destAbs = path.join(outDir, destRel);
                await fs.mkdir(path.dirname(destAbs), { recursive: true });
                await fs.copyFile(DAPPFENCE_JS_PATH, destAbs);
                logger.info(`DappFence: copied dappfence.js → ${destRel}`);

                await generateManifest({
                    ...opts,
                    outDir,
                    pages,
                    routes: resolvedRoutes,
                    scriptAttrs: opts,
                    logger,
                });
            },
        },
    };
}
