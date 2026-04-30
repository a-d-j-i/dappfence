import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.js';

const require = createRequire(import.meta.url);
const { calculateFileHash, signManifest } = require('@dappfence/signer');
const { getPublicKey, hexToBytes, ethereumAddress } = require('@dappfence/signer/crypto');
const { startServer } = require('@dappfence/test-app/server');
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'app');
const extSrcDir = join(here, '..', 'src');
const distTest = join(here, '..', 'dist-test');
const appOut = join(here, '..', 'html-root', 'app_latest');

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.slice('--port='.length)) : (process.env.TEST_PORT ? parseInt(process.env.TEST_PORT) : 7777);

const prodBuild = process.argv.includes('--prod') || process.env.DAPPFENCE_PROD === '1';
let dappfenceDist = null;
if (!prodBuild) {
    try {
        dappfenceDist = require.resolve('@dappfence/core/dev');
    } catch {
        console.warn('[server] @dappfence/core/dev not found, falling back to prod build');
    }
}
dappfenceDist ??= require.resolve('@dappfence/core');

// Example key — replace with your own for production use.
const secretKey = hexToBytes('46c88fcabce00eced90f15ceb9325fd879e44b43c623b174416a219a6103e05d');
const publicKey = getPublicKey(secretKey);

function rebuildExtension() {
    build({
        dist: distTest,
        sites: [{
            pattern: `http://localhost:${port}/*`,
            manifest: '/integrity-manifest.json',
            signatureType: 'noble-secp256k1-recovered-eth',
            signatureIdentity: ethereumAddress(publicKey),
        }],
    });
}

function rebuildApp() {
    rmSync(appOut, { recursive: true, force: true });
    mkdirSync(appOut, { recursive: true });

    // dappfence.js must be served from the origin: the extension injects it as a
    // client-side script, but SW registration is same-origin so the browser fetches
    // it from the page's origin to install the service worker.
    copyFileSync(dappfenceDist, join(appOut, 'dappfence.js'));

    const files = { '/dappfence.js': calculateFileHash(dappfenceDist) };
    for (const name of readdirSync(srcDir)) {
        const src = join(srcDir, name);
        copyFileSync(src, join(appOut, name));
        files[`/${name}`] = calculateFileHash(src);
    }

    const manifest = signManifest({ files, mode: 'protected' }, { publicKey, secretKey });
    writeFileSync(join(appOut, 'integrity-manifest.json'), JSON.stringify(manifest, null, 4));
    console.log(`[sign] manifest signed, signer: ${manifest.identity}`);
}

// Initial build.
rebuildExtension();
rebuildApp();

// Watch test/app/ — re-sign on source changes.
let appDebounce;
watch(srcDir, () => {
    clearTimeout(appDebounce);
    appDebounce = setTimeout(() => {
        console.log('[watch] test/app changed, re-signing...');
        rebuildApp();
    }, 50);
});

// Watch src/ — rebuild extension variant on source changes.
let extDebounce;
watch(extSrcDir, () => {
    clearTimeout(extDebounce);
    extDebounce = setTimeout(() => {
        console.log('[watch] src/ changed, rebuilding extension...');
        rebuildExtension();
    }, 50);
});

startServer({
    port,
    root: join(here, '..', 'html-root'),
    defaultApp: 'app_latest',
}).catch((err) => console.error(err));
