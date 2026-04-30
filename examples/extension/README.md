# @dappfence/extension

Browser extension (Chrome and Firefox) that injects DappFence into a curated list of sites.

## Protected sites

Edit `src/sites.json` to add or remove URL patterns, then rebuild:

```json
[
  "https://app.uniswap.org/*",
  "https://app.aave.com/*"
]
```

Plain strings are enough to inject DappFence on a site. If the site publishes a signed integrity
manifest, add the full object form so the extension can configure DappFence with the manifest
location and the signer's public key:

```json
[
  {
    "pattern": "https://app.example.com/*",
    "manifest": "/integrity-manifest.json",
    "signatureType": "noble-secp256k1-recovered-eth",
    "signatureIdentity": "0x<eth-address-of-signer>"
  }
]
```

- **`manifest`** — path to the signed integrity manifest on the origin (default convention:
  `/integrity-manifest.json`)
- **`signatureType`** — signature scheme used when the manifest was signed; must match what
  `@dappfence/signer` produces (`noble-secp256k1-recovered-eth`)
- **`signatureIdentity`** — Ethereum address derived from the signer's public key; printed by
  `test/server.js` as `[sign] manifest signed, signer: 0x...`

Without these fields DappFence is injected, but manifest verification will fail with a
`CONFIG_ERROR` — correct behavior for sites that do not yet publish a manifest.

## Build

From the repo root (builds `@dappfence/core` first, then the extension):

```sh
npm run build
```

Or just the extension after `core` has been built at least once:

```sh
# Chrome (default)
npm run build -w @dappfence/extension

# Firefox
npm run build:firefox -w @dappfence/extension
```

Output goes to `examples/extension/dist/`.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `examples/extension/dist`.

## Load in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select any file inside `examples/extension/dist` (e.g. `manifest.json`).

> Build with `--target=firefox` first — the Firefox manifest includes `browser_specific_settings`
> required by Firefox's extension validator.

## Publishing to stores

Create store-ready zip files with:

```sh
# Chrome Web Store
npm run pack -w @dappfence/extension

# Firefox Add-ons (AMO)
npm run pack:firefox -w @dappfence/extension
```

Zips are written to `examples/extension/release/`.

### Chrome Web Store

1. Go to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time
   $5 developer fee).
2. Click **Add new item** and upload `release/dappfence-chrome.zip`.
3. Fill in the store listing: description, screenshots, and a privacy policy URL.
4. The `scripting` permission requires a written justification — explain that it is used only when
   the user opens the popup, to call `/sw-api/status` through the page's service worker context.
5. Submit for review. Automated review typically takes minutes; manual review can take days.

### Firefox Add-ons (AMO)

Firefox requires all extensions to be signed. Two options:

**Listed on AMO** (public, discoverable):

1. Go to [addons.mozilla.org/developers](https://addons.mozilla.org/developers).
2. Click **Submit a New Add-on** and upload `release/dappfence-firefox.zip`.
3. AMO signs the extension automatically during review.

**Self-distributed** (signed but not listed):

Use Mozilla's [`web-ext`](https://github.com/mozilla/web-ext) CLI to sign via the AMO API without a
public listing. Requires AMO API credentials.

```sh
npx web-ext sign \
  --source-dir examples/extension/dist \
  --api-key $AMO_API_KEY \
  --api-secret $AMO_API_SECRET
```

The signed `.xpi` is saved to `web-ext-artifacts/`.

> Note: adding a new site to `src/sites.json` requires rebuilding and submitting a new version to
> the store. Review cycles apply each time.

## Testing

Tests run against a local plain-HTML site with no DappFence pre-included — the extension injects it,
which is exactly what it does in production.

### Prerequisites

Install Playwright's Chromium browser at once:

```sh
npx playwright install chromium -w @dappfence/extension
```

### Run the tests

```sh
npm test -w @dappfence/extension
```

Playwright starts `test/server.js` automatically before running the suite and shuts it down
afterward.

### Development server

To run the server standalone with file watching (useful when writing tests or iterating on the test
app):

```sh
npm run dev -w @dappfence/extension
```

The server signs a fresh `integrity-manifest.json` and builds the test extension variant
(`dist-test/`) on startup, then watches for changes:

- **`test/app/`** — re-signs the manifest whenever a source file changes. The dev server reads
  files from the disk on every request, so the browser picks up the change immediately.
- **`src/`** — rebuilds the extension variant (`dist-test/`) when extension source files change.
  Reload the extension in `chrome://extensions` to pick up the new build.

The server listens on port **7777** by default (to avoid clashing with the test-app dev server on
3333). Override with `TEST_PORT`:

```sh
TEST_PORT=9000 npm run dev -w @dappfence/extension
```

### Test app

`test/app/` contains the source files for the local test site — a minimal HTML page and a JS file
with no DappFence included. The extension injects `dappfence.js` via `inject.js`.

`test/server.js` signs the test app at startup using `@dappfence/signer` with an example key. The
signing key in `test/server.js` is for development only — replace it with your own key pair for any
non-test use.

## How it works

`src/sites.json` is the list of URL patterns. At build time, `build.js` reads it and stamps a
`content_scripts` entry into `dist/manifest.json` so the browser injects `inject.js` at
`document_start` on every matching page.

`inject.js` runs in the isolated world and prepends a `<script src="/dappfence.js" async=false>` to
`document.documentElement`. The script tag executes in the main world early in the page lifecycle.
`dappfence.js` is loaded from the site's own origin so the service worker can verify it against the
integrity manifest. Once DappFence's service worker is installed, all later requests are verified at
the network level regardless of script execution order.

The popup (toolbar icon) calls `/sw-api/status` against the active tab via
`chrome.scripting.executeScript` so the request is intercepted by the page's service worker. It
shows the app version, trusted file count, verification count, and active block count.

## Appendix: CSP compatibility

The `<script>` tag injected by `inject.js` uses `src="/dappfence.js"` — a same-origin path. A
standard `script-src 'self'` CSP already allows it, so most sites work without any header
modification.

Sites that block all inline or dynamic script injection (e.g., a strict `default-src 'none'` with no
`script-src 'self'`) will still block the tag. For those, use the per-site CSP override:

### Per-site CSP override (optional)

```json
{
  "pattern": "https://app.example.com/*",
  "csp": "script-src 'self'; object-src 'none'; base-uri 'self'"
}
```

At build time this generates a `declarativeNetRequest` rule that replaces the site's
`Content-Security-Policy` response header with the provided value before the browser processes it.

The replacement CSP is a manual snapshot — if the site changes its own CSP, you need to update this
entry to stay in sync.

Sites listed as plain strings get no header modification. The security model still holds for origins
where DappFence's service worker is already installed from a previous visit — the SW verifies
requests at the network level independently of whether the initial injection succeeded.

## Appendix: Why the server must host dappfence.js

One of the early design goals was a "zero server cooperation" mode where the extension could deliver
`dappfence.js` entirely from its own bundle — no file needed on the origin server. Three approaches
were attempted; all failed for fundamental browser security reasons.

### Attempt 1 — load from the extension bundle directly

`inject.js` originally set `<script src="chrome-extension://ID/dappfence.js">`. The script loaded
fine (web-accessible resources allow it), but the service worker then intercepted every subsequent
fetch from the page. Requests to `chrome-extension://` URLs are cross-origin from the page's origin,
so they were not found in the integrity manifest and triggered violations.

Fixing that in the verification layer would have been correct in isolation, but a deeper
incompatibility remained: `navigator.serviceWorker.register()` requires the script URL to be
same-origin with the page. `chrome-extension://` is a different origin, so the browser
rejected SW registration outright regardless of any other fix.

### Attempt 2 — blob: URLs

`blob:` URLs were explored as a middle ground: the content script fetches the extension's
`dappfence.js`, wraps it in a `Blob`, and creates a local object URL to use as the script `src` or
the SW registration URL.

**Script injection via blob: src** — the blob URL is same-origin in the sense that it carries the
page's origin prefix (`blob:http://localhost:7777/...`), so it looked like it might satisfy
`script-src 'self'`. In practice, `script-src 'self'` does not implicitly allow `blob:` URLs; the
browser blocks the load with a CSP violation.

Sites would need to add `blob:` to their `script-src`, which is a meaningful CSP weakening and
requires the same server cooperation we were trying to avoid.

**SW registration via blob: URL** — even setting the CSP issue aside, passing a blob URL to
`navigator.serviceWorker.register()` is rejected by a hard browser spec restriction:

> Failed to register a ServiceWorker: The URL protocol of the script ('blob:...') is not supported.

The Service Worker spec explicitly prohibits `blob:` scheme URLs for SW registration; no
configuration or permission can override this.

### Attempt 3 — DNR redirect (`extensionPath`)

`declarativeNetRequest` has a redirect action with an `extensionPath` option, which looked like a
transparent server-side substitution. A rule was added to intercept `GET /dappfence.js` and redirect
it to the extension bundle.

In practice Chrome does not substitute the response transparently — it issues an actual HTTP
redirect whose destination is a `chrome-extension://` URL. The browser disallows cross-origin
redirects for script resources and produces:

> The script resource is behind a redirect, which is disallowed.

### Attempt 4 — non-SW protection model

If the SW cannot be bootstrapped without server cooperation, could the extension protect the page
through a content script alone? A MAIN-world content script injected at `document_start` can
monkey-patch `fetch`, `XMLHttpRequest`, and `navigator.serviceWorker.register`, intercepting all
JS-level API calls and verifying responses against the integrity manifest.

The threat model this must defeat is tampered `<script src="app.js">` tags in the HTML — resources
fetched by the browser's own resource loader, not by JavaScript APIs. Those requests are completely
invisible to monkey-patched `fetch`/XHR. A compromised initial bundle runs before any JS-level
intercept matters, making this approach useless against the primary attack vector.

### Conclusion

All four paths are blocked by browser security invariants that cannot be worked around in MV3:

- Extension-origin URLs cannot act as same-origin service worker scripts.
- DNR `extensionPath` redirects are real cross-origin redirects, not transparent substitutions.
- JS-level intercept cannot observe browser-initiated resource loads.

**The origin server must serve `/dappfence.js` (or a custom path configured via the `dappfence`
field).** The file can be a plain copy of `@dappfence/core`; no server-side logic is required.
Without it the extension can inject the script tag, but the service worker cannot be installed and
no network-level verification takes place.
