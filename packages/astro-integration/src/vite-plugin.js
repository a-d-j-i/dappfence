/**
 * Vite plugin that injects the dappfence.js script tag into every HTML page.
 * Runs in both dev server and production build modes.
 */
import { buildScriptAttrs } from './manifest.js';

export function createDappFenceVitePlugin(opts) {
    return {
        name: 'vite-plugin-dappfence',
        transformIndexHtml: {
            // 'pre' so we run before Astro's own transforms
            order: 'pre',
            handler() {
                return [
                    {
                        tag: 'script',
                        attrs: buildScriptAttrs(opts),
                        injectTo: 'head-prepend',
                    },
                ];
            },
        },
    };
}
