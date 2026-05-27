# @dappfence/core

Security framework for web applications using service worker content verification and monkey
patching to protect against malicious code execution.

## Usage

```html
<script
    src="/dappfence.js"
    data-manifest="/integrity-manifest.json"
    data-manifest-signature-type="noble-secp256k1-recovered-eth"
    data-manifest-signature-identity="0xAbC123..."
    data-app-sw="sw_app.js"
></script>
```

The framework detects its execution context automatically: in a browser it registers and manages the
security service worker; in a service worker it intercepts fetch events and verifies file integrity.

## Scripts

```bash
npm run build          # Development build (dist/dappfence.js)
npm run build:prod     # Production build (minified, obfuscated)
npm run build:watch    # Rebuild on source changes
npm test               # Run unit tests
npm run test:coverage  # Unit tests with coverage report
npm run clean          # Remove dist/ and coverage/
```

## Source Structure

```
src/
├── main.js              # Entry point — context detection, routes to client or SW
├── core/                # Shared utilities
│   ├── crypto.js        # SHA-256 hashing, secp256k1 signature recovery
│   ├── logger.js        # Conditional logging
│   ├── monkey-patch.js  # Generic monkey-patching utility
│   └── utils.js         # Hash helpers, config checks
├── client/              # Browser context
│   ├── sw-registration.js  # Smart SW registration, Shift+Reload handling
│   └── security-handler.js # Client-side security event handling
├── sw/                  # Service worker context
│   ├── main.js          # SW entry, event registration
│   ├── services.js      # Factory wiring all dependencies
│   ├── context.js       # SW global scope wrapper (testable interface)
│   ├── fetch-handler.js # Main request interceptor
│   ├── api-handler.js   # /sw-api/* endpoints (status, warnings, unblock)
│   ├── lifecycle-handlers.js  # install/activate handlers
│   ├── appsw-hooks.js   # importScripts/addEventListener monkey-patches
│   ├── message-broker.js     # Security message queuing to clients
│   ├── response.js      # Block response and navigation redirect builders
│   ├── manifest/
│   │   ├── verification.js      # Pure verification: verifyFilePath, verifyManifestSignature, shouldVerifyAsset
│   │   ├── filters.js           # Named filter rules — normalizes CDN injections before hashing, rewrites CDN-only scripts
│   │   └── manifest-service.js  # Manifest lifecycle, loading, file verification with filter application
│   ├── storage/
│   │   ├── indexeddb.js       # Low-level IndexedDB wrapper
│   │   ├── index.js           # App store facade (recordSecurityViolation)
│   │   ├── manifest-store.js  # App version, trusted manifests, verification results
│   │   └── security-stores.js # Active blocks, security events, API tokens
│   └── __tests__/       # Unit tests (vitest)
└── templates/           # Security warning HTML/CSS
```

## Service Worker Architecture

### Module Dependency Graph

```
main.js
  └── services.js (creates and wires all dependencies)
        ├── context.js
        ├── storage/
        │     ├── indexeddb.js
        │     ├── index.js (appStore facade)
        │     ├── manifest-store.js
        │     └── security-stores.js
        ├── manifest/
        │     ├── verification.js (pure verification: verifyFilePath, signature checks, shouldVerifyAsset)
        │     ├── filters.js (named filter rules for CDN injection normalization and script rewriting)
        │     └── manifest-service.js (manifest lifecycle, filter application, file verification)
        ├── message-broker.js
        ├── appsw-hooks.js
        ├── fetch-handler.js
        │     └── api-handler.js (created internally by fetch-handler)
        └── lifecycle-handlers.js
```

### Entry Point inside

**`main.js`** initializes the service worker by calling `createServices(self)` and registering event
handlers on the hook service. Contains no dependency creation logic.

**`services.js`** is the factory that creates and wires all dependencies. Accepts `swGlobal` (the
raw `self`), making it testable with a mock global. Returns
`{ hookService, fetchHandler, installHandler, activateHandler, messageHandler }`.

### Core Infrastructure

**`context.js`** wraps the SW global scope behind a testable interface: `fetch`, `location`,
`clients`, `skipWaiting`, `navigator.userAgent`.

**`appsw-hooks.js`** monkey-patches `importScripts` and `addEventListener` to intercept app SW
operations. Receives an `onVerifyScript(scriptPath)` callback — no knowledge of manifest or storage.

**`response.js`** provides pure functions for creating block responses and navigation warning
redirects.

### Event Handlers

All handlers receive a shared `core` object:
`{ swContext, appStore, manifestService, onSecurityViolation }`.

-   **`fetch-handler.js`** — main request interceptor. Checks active blocks, routes `/sw-api/*` to
    the API handler, calls `manifestService.resolveManifest` to get the active `verifyFile`
    function, verifies assets, broadcasts violations.
-   **`lifecycle-handlers.js`** — `install` initializes the manifest, loads the app SW via
    `importScripts`, signals `onInstallDone`. `activate` claims clients and re-broadcasts
    violations.
-   **`api-handler.js`** — handles `/sw-api/*` endpoints (status, security-warning page, block
    details, site unblock).
-   **`message-broker.js`** — queues and delivers security messages to clients. Handles
    `CLAIM_CONTROL` and `DAPPFENCE_CLIENT_READY` messages.

### Manifest System

`VERIFICATION_STATUS` and `ASSET_TYPE` constants live in `core/constants.js` alongside the other
cross-module contract strings.

**`manifest/verification.js`** contains pure verification functions: `verifyFilePath` (manifest
lookup and hash compare), `verifyManifestSignature` (secp256k1 recovery), `getFileKey` (URL to
manifest key), `shouldVerifyAsset` (extension/navigation predicate), `verifyLocation` (fetch +
verify), `verifyImportedScript` (delegates to `verifyLocation`, records violations).
`normalizeManifestData` was moved to `storage/manifest-store.js` where it is used.

**`manifest/filters.js`** is a closed set of named rules that handle CDN content injected at serve
time. Each rule solves two related problems:

-   **HTML mutation** (`pattern` + `appliesTo`): the CDN injects a snippet into HTML pages. The
    pattern is stripped from the raw bytes before hashing so the computed hash matches the
    pre-injection content recorded in the manifest.
-   **External script loading** (`rewriteUrls`): the injected snippet loads a script from a URL
    outside the build output. Simply skipping verification would let an attacker serve arbitrary JS
    there. Instead the SW applies a tiered policy: if the URL appears in `manifest.files` with
    known-good hashes and the served content matches one, it is allowed through (`MATCH`). If the
    content does not match — or the URL has no manifest entry at all — the response body is replaced
    with a safe empty stub (`REWRITE`), neutralizing the script while keeping the page functional.

Rules are referenced by name only — the manifest carries `filters: ['netlify-cdp']`, never raw
patterns. Each rule declares which file extensions it applies to, so an HTML rule never touches JS
or CSS.

**`manifest/manifest-service.js`** is the stateful manifest lifecycle manager. Contains
`loadManifestFromUrl` (fetch + signature verification + normalization + storage) as a private
function with single-flight deduplication. Exposes `resolveManifest(clientId)` which returns
`{ mode, verifyFile }`. `verifyFile(request, response)` applies content rules, computes the hash,
and verifies against the stored manifest. Results carry a `status` field (`MATCH`, `MISMATCH`,
`NOT_FOUND_IN_MANIFEST`, `SKIPPED`, `REWRITE`, `ERROR`).

### Storage

-   **`storage/indexeddb.js`** — low-level IndexedDB wrapper: `{ get, set, delete, withTx }`.
-   **`storage/index.js`** — app store facade. Composes all stores, exposes
    `recordSecurityViolation(details)`.
-   **`storage/manifest-store.js`** — trusted manifests (priority queue, hash index) and
    verification results.
-   **`storage/security-stores.js`** — active blocks (deterministic IDs), security events, API
    tokens.

## Integrity Manifest

The manifest structure follows the [Coze specification](https://github.com/Cyphrme/Coze). It
consists of a signed JSON document with a `pay` (payload) and `sig` (signature) field. The payload
contains a `files` map of file paths to their SHA-256 hashes, optional `filters` naming
CDN-injection rules, `mode`, and `metadata`. Signature verification uses Ethereum-style secp256k1
key recovery.

Each entry in `files` may be a single hash string or an array of hash strings. Arrays are used for
CDN-served assets (such as analytics scripts) whose content is not a build artifact and may vary
across CDN regions or provider releases. Listing all known-good hashes lets any current version pass
verification while still blocking unexpected content.

### Why a Centralized Manifest

-   **vs. SRI**: SRI is designed for external resources and scripts. We need to validate all
    resource types (HTML, CSS, JS, images) consistently.
-   **vs. per-file signatures**: A centralized manifest is easier to integrate across environments.
    Per-file signatures would require modifying every file and implementing validation for each
    type.
-   **vs. hashes alone**: A manifest includes metadata and provides a clear overview of all
    validated resources in one place.

### Manifest Lifecycle

1. At build time, `@dappfence/signer` hashes all files and signs the manifest payload. The payload
   may include a `filters` array naming CDN-injection rules to apply at verification time.
2. At runtime, `manifest-service.js` fetches the manifest, verifies the signature, normalizes it,
   and stores it in IndexedDB.
3. On each file request, `verifyFile` applies any declared filter rules to the raw bytes before
   hashing, then compares the resulting hash against the stored manifest entry. For URLs listed in a
   filter rule's `rewriteUrls`: a matching known-good hash allows the response through (`MATCH`);
   any verification failure (mismatch or no manifest entry) replaces the body with a safe empty stub
   (`REWRITE`) rather than blocking, keeping the page functional.

## Design Patterns

-   **Callbacks over objects** — modules receive focused callbacks (`onSecurityViolation`,
    `onInstallDone`, `onVerifyScript`) instead of full service objects.
-   **Shared `core` deps** — `{ swContext, appStore, manifestService, onSecurityViolation }` bundled
    and spread into handlers.
-   **`swContext` wraps all globals** — no module touches `self` directly except `appsw-hooks.js`
    (monkey-patching) and `main.js` (passes `self` to `createServices`).
-   **`appStore` as facade** — all storage access goes through `appStore`, which provides
    `recordSecurityViolation` as the single entry point.
-   **Consistent result shape** — all verification functions return `{ status, ... }` using
    `VERIFICATION_STATUS` constants. Error paths return result objects (never `undefined`).
