# @dappfence/astro

Astro integration for [DappFence](../../README.md) — automatically injects the security script and
generates a signed integrity manifest at build time.

## Installation

```bash
npm install @dappfence/astro
```

`@dappfence/core` (the browser runtime) and `@dappfence/signer` (the manifest signing library) are
listed as dependencies and are installed automatically.

## Setup

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import dappfence from '@dappfence/astro';

export default defineConfig({
    integrations: [dappfence()],
});
```

The integration reads the signing key from the `DAPPFENCE_SECRET_KEY` environment variable
automatically. If the variable is not set and no `secretKey` option is passed, the build fails with
a clear error.

Generate a key once and store it in your CI secrets / `.env` file:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → f0570667f495...
```

```bash
# .env (never commit this file)
DAPPFENCE_SECRET_KEY=f0570667f495...
```

The corresponding Ethereum address (used to verify the manifest signature at runtime) is derived
automatically — you only need to supply the secret key.

### Key resolution order

1. `secretKey` option passed to `dappfence({ secretKey: '…' })` — highest priority
2. `DAPPFENCE_SECRET_KEY` environment variable
3. Neither provided → **build error**

Prefer the environment variable in production, so the key is never committed to source control. The
explicit option is useful for local development fallbacks:

```js
// astro.config.mjs
const DEV_KEY = 'f0570667f495…'; // local dev only, not secret

export default defineConfig({
    integrations: [
        dappfence({
            secretKey: DEV_KEY, // overridden by DAPPFENCE_SECRET_KEY if set
        }),
    ],
});
```

## Options

| Option                      | Type       | Default                                               | Description                                                                                                                                                                         |
| --------------------------- | ---------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `secretKey`                 | `string`   | `DAPPFENCE_SECRET_KEY` env var                        | **Required.** Hex secret key (with or without `0x` prefix) used to sign the manifest. Falls back to the `DAPPFENCE_SECRET_KEY` environment variable; build fails if neither is set. |
| `scriptSrc`                 | `string`   | `'/dappfence.js'`                                     | URL path where `dappfence.js` will be served.                                                                                                                                       |
| `manifestUrl`               | `string`   | `'/integrity-manifest.json'`                          | URL path where the manifest will be served at runtime.                                                                                                                              |
| `manifestPath`              | `string`   | `'integrity-manifest.json'`                           | Output filename for the manifest relative to the build output directory.                                                                                                            |
| `manifestSignatureType`     | `string`   | `'noble-secp256k1-recovered-eth'`                     | Signature algorithm written into the manifest.                                                                                                                                      |
| `manifestSignatureIdentity` | `string`   | derived from `secretKey`                              | Expected signer Ethereum address. Auto-derived when `secretKey` is set.                                                                                                             |
| `mode`                      | `string`   | `'protected'`                                         | Enforcement mode: `'protected'` blocks requests that fail verification; `'reporting'` logs violations without blocking.                                                             |
| `appSW`                     | `string`   | `null`                                                | Path to your app's own service worker, loaded by DappFence via `importScripts()`.                                                                                                   |
| `warningUrl`                | `string`   | `null`                                                | URL shown on the security warning page for tamper alerts.                                                                                                                           |
| `extensions`                | `string[]` | `['.js','.mjs','.css','.html','.htm','.json','.svg']` | File extensions included in the manifest.                                                                                                                                           |
| `exclude`                   | `string[]` | `[]`                                                  | Web paths to exclude from the manifest (e.g. `['/admin']`).                                                                                                                         |
| `filters`                   | `string[]` | `null`                                                | Named filter rules applied before hashing (e.g. `['netlify-cdp']`). Merged with any rules auto-detected from the build environment.                                                 |

## What Happens at Build Time

Running `astro build` triggers four steps in order:

1. **`dappfence.js` is copied** from `@dappfence/core` into your output directory at `scriptSrc`
   (default `dist/dappfence.js`), so it is served as a first-party file and included in the manifest
   hash.

2. **Script tag is injected** into every HTML file that contains a `<head>` tag. Partial HTML
   fragments without a `<head>` are skipped automatically.

    ```html
    <script
        src="/dappfence.js"
        data-manifest="/integrity-manifest.json"
        data-manifest-signature-type="noble-secp256k1-recovered-eth"
        data-manifest-signature-identity="0x..."
    ></script>
    ```

3. **Every tracked file is hashed** (SHA-256) after any filter rules are applied.

4. **`integrity-manifest.json` is signed and written** to the output directory.

The integration is a **no-op in `astro dev`**. DappFence requires a static signed manifest to verify
file hashes, which cannot exist when Astro renders pages at request time. Test against the real
build output with `astro build && astro preview`.

For details on the manifest format, signature scheme, and verification internals see the
[DappFence README](../../README.md).

## Deploying to Netlify

See the [Netlify deployment guide](../netlify-integration/README.md) for the required `netlify.toml`
configuration, post-processing pitfalls, and a deployment checklist.

Netlify injects a CDP analytics snippet into HTML pages at CDN serve time and loads it from
`/.netlify/scripts/cdp` — a URL not present in your build output. The `netlify-cdp` filter rule
handles both problems:

-   The HTML snippet is stripped from page bytes before hashing, so the computed hash matches the
    pre-injection content in the manifest.
-   `/.netlify/scripts/cdp` is intercepted by the service worker and its response replaced with a
    safe empty stub, so CDN-injected JS never executes regardless of what Netlify serves there. If
    you want to allow the real script, add its SHA-256 hash(es) to `manifest.files` for that path.

The integration detects Netlify's build environment automatically and enables `netlify-cdp`. If you
build outside Netlify (e.g. locally or in GitHub Actions targeting Netlify), add it explicitly:

```js
dappfence({
    filters: ['netlify-cdp'],
});
```

## Current Limitations

-   **Static sites only (v1).** Only files written to disk at build time can be hashed and verified.
    Pages rendered on demand (SSR) are outside the verification boundary.

-   **Dev server is unprotected.** `astro dev` is intentionally skipped. Test with
    `astro build && astro preview`.

-   **Initial load is trusted.** The initial HTML and `dappfence.js` are fetched before the service
    worker is active and are not verified on the very first page load. All subsequent navigations
    and asset fetches are verified.
