# CSP Injection Strategy

## Approach

The service worker intercepts navigation responses and applies two transformations:

**1. CSP header injection** — a `Content-Security-Policy` header is added, derived entirely from the
signed manifest. The browser enforces the policy with its own parser.

**2. HTML head injection (Tier 2 only)** — for SSR pages without a full-body hash, the SW also
rewrites the response body stream. It locates the `<head>` opening tag and injects two elements
immediately after it, before any page-authored content reaches the browser:

```html
<script type="application/json" id="__df_csp_hashes">
    [hash1, hash2, ...]
</script>
<script
    src="/dappfence.js"
    data-manifest="..."
    data-manifest-signature-identity="..."
    data-manifest-signature-type="..."
></script>
```

`__df_csp_hashes` comes first because `<script src="...">` is parser-blocking: the HTML parser stops
when it reaches `dappfence.js` and does not process any subsequent elements until the script has
executed. Placing the JSON element before it ensures the data is already in the DOM when
`dappfence.js` runs. An attacker who controls the server response cannot remove or preempt either
element — they arrive in the SW-controlled stream before any server-authored content.

The injection uses a streaming byte-level HTML tokenizer (`html-tokenizer.js`) operating on
`Uint8Array` chunks. Only the preamble is buffered; everything after `<head>` streams through
untouched.

### Preamble scanner

The preamble scanner operates at the byte level on `Uint8Array` chunks. It finds the `<head>`
opening tag, validates everything before it, and returns the byte offset immediately after `>` — the
injection point. Everything from that offset onwards is forwarded verbatim without further
inspection.

The scanner enforces a strict allowlist: anything not listed below is a violation and blocks the
response. This keeps parsing rules simple; edge cases become violations rather than special
handling.

**Byte limit:** 8 KB. Exceeding it is a violation.

#### Accepted token sequence

1. **BOM** (optional, first bytes only)

    - UTF-8 BOM `EF BB BF` — skip, continue
    - UTF-16 LE `FF FE`, UTF-16 BE `FE FF`, UTF-32 variants — **violation**
    - Rationale: all injected content is pure ASCII. ASCII bytes are not ASCII in UTF-16/UTF-32, so
      injection would corrupt the document.

2. **Whitespace** (any amount, anywhere between tokens)

    - Bytes: `0x20` (space), `0x09` (tab), `0x0A` (LF), `0x0D` (CR)

3. **`<!DOCTYPE ...>`** (required, case-insensitive)

    - Must appear before `<html>` and `<head>`. Absence is a violation (quirks-mode pages are
      unsupported).
    - The DOCTYPE string after `DOCTYPE` is not validated — legacy doctypes are accepted.
    - Ends at the first `>` outside a quoted string.

4. **Comments** `<!-- ... -->` (zero or more, anywhere between tokens)

    - Start: bytes `3C 21 2D 2D` (`<!--`)
    - End: first occurrence of `-->` (bytes `2D 2D 3E`)
    - Unclosed comment (EOF before `-->`) is a violation.
    - An attacker could place `<!-- <head> -->` before the real `<head>`; the scanner must consume
      the entire comment before resuming token search.

5. **Processing instructions** `<?...?>` (zero or more)

    - HTML5 parsers treat `<?` as a bogus comment, ending at `>`. We follow suit: skip from `<?` to
      the next `>`.
    - Handles `<?xml version="1.0"?>` on legacy XHTML pages.

6. **Bogus comments** `<!...>` not matching `<!--` or `<!DOCTYPE`

    - Includes SGML conditional sections `<![CDATA[...]]>`.
    - HTML5 treats them as comments ending at `>`. Scanner skips from `<!` to the next `>`.

7. **`<html ...>`** (optional, case-insensitive)

    - Forwarded verbatim — all attributes must be preserved (`lang`, `dir`, `class`, etc.).
    - Attribute parsing rules (also apply to `<head>`):
        - **Whitespace** between attributes: ignored
        - **Quoted values** `"..."` or `'...'`: consume until matching close quote; `>` and `<`
          inside quotes are not tag boundaries
        - **Unquoted values**: consume until whitespace or `>`; no other terminators
        - **Boolean attributes** (no `=`): name only, e.g. `itemscope`
        - **Self-closing slash** `<html/>`: the `/` before `>` is silently ignored (non-void
          element)
        - **Case**: attribute names are case-insensitive; values are forwarded as-is
    - Only one `<html>` tag is accepted. A second `<html>` after the first closes is a violation.

8. **`<head ...>`** (required, case-insensitive)
    - Forwarded verbatim including any attributes (e.g. `<head prefix="og: ...">`).
    - Same attribute parsing rules as `<html>`.
    - The byte offset immediately after this tag's closing `>` is the injection point.

#### Null bytes

`0x00` anywhere in the preamble is a violation. HTML5 replaces null bytes with U+FFFD, which could
cause the parser to see different content than the scanner did.

#### What is not accepted

Any tag other than those listed above is a violation. This includes `<body>`, `<script>`, `<style>`,
`<div>`, `<meta>`, `<link>`, and any other element appearing before `<head>`. The scanner does not
attempt recovery.

#### What the scanner does NOT need to handle

The full `<head>` and `<body>` content is forwarded byte-for-byte without inspection. Inline
scripts, stylesheets, and other head elements are not touched.

### Tier 1 — no body rewriting

For static pages with a full-body hash, head injection is skipped. The hash verification already
guarantees the page is byte-for-byte identical to the build output, so `dappfence.js` was placed
there by the build and any attacker modification is caught before the response is served.

The base policy blocks everything. Individual directives are relaxed only where the manifest
provides explicit authorization.

```
default-src     'none';
script-src-elem 'sha256-A' 'sha256-B' *;
script-src-attr 'unsafe-hashes' 'sha256-C';
style-src       'self' 'unsafe-inline';
img-src         'self' data:;
font-src        'self';
connect-src     'self' https://api.example.com;
worker-src      'self';
object-src      'none';
base-uri        'self';
frame-ancestors 'none';
report-uri      /sw-api/csp-violation?token=...;
```

Key policy decisions:

-   `script-src-elem` uses `*` for external scripts — DappFence already verifies every external
    script by content hash at the SW level, so restricting by origin adds no security benefit.
-   `'strict-dynamic'` is intentionally absent — it is incompatible with the `*` wildcard.
-   `script-src-attr` is only emitted when `on*` attribute hashes are declared in the manifest.
    `'unsafe-hashes'` is required by the CSP spec for hashes to apply to event handlers; without it
    hashes in this directive are silently ignored.
-   `style-src 'unsafe-inline'` is safe: all CSS JS-execution vectors (`expression()`, `behavior:`,
    HTC) are IE-only and dead in modern browsers.
-   `worker-src 'self'` is required because DappFence registers its own service worker from the page
    context (`navigator.serviceWorker.register()`). Without it, `default-src 'none'` blocks the
    registration.

---

## Verification tiers

CSP injection combines with the existing full-body hash check to produce two distinct verification
tiers depending on whether the page body is static or dynamic.

### staticPages — Static pages (SSG, static export)

Both mechanisms are active:

-   **Full body hash check** — the SW hashes the entire response and compares against the manifest.
    Any modification to any byte in the response is detected and blocked.
-   **CSP** — second independent layer. If the SW is somehow bypassed, the browser still enforces
    the policy against script execution.

### stableInlineScripts — SSR pages with static inline scripts

Full body hash is not possible (the body changes per request). CSP is the primary protection:

-   The SW injects CSP with hashes for the page's static inline bootstrapper scripts (from
    `manifest.csp.pages[pageKey]`).
-   An attacker who controls the server can modify HTML structure, text content, and data values —
    but cannot inject a new executing script, because CSP blocks any inline script whose hash is not
    in the manifest.
-   External script fetches are still SW-verified (unchanged).

**The residual gap is honest:** non-script HTML is unverified under stableInlineScripts. Structural
tampering, link manipulation, and data value changes are not caught. The guarantee is specifically
about script execution integrity, not full page integrity.

**`csp.pages` entries are mandatory for stableInlineScripts.** Without them the CSP `script-src`
contains no hashes, and every inline script on the page is blocked — including legitimate
bootstrappers. The integration layer must extract and record the static inline scripts at build time
before a route can operate under stableInlineScripts.

Hashes are extracted at build time by `extractInlineScriptHashes(htmlPath)` from
`@dappfence/manifest-tools`. The function returns `sha256-<base64>` values; the SW wraps each in
single quotes when building the `script-src-elem` directive.

### dynamicRSC — `force-dynamic` RSC routes (opt-in, with residual)

No full body hash. CSP blocks all inline scripts including RSC payload scripts. Rather than failing
the page, `dappfence.js` re-executes RSC push scripts after pattern-validating them client-side.

**Mechanism:**

When CSP blocks a `<script>` element the browser fires a `securitypolicyviolation` event.
`dappfence.js` listens for this event and scans all inline `<script>` elements currently in the DOM:

1. For each inline `<script>` not in the known-good hash set: apply a strict regex that accepts only
   `self.__next_f.push([...])` and the companion init expression — nothing else.
2. If the script matches: extract the array argument, `JSON.parse` it (cannot execute code), call
   `self.__next_f.push(parsedArray)` directly.
3. If the script does not match: leave it blocked. The violation is logged and the SW warning page
   pipeline fires.

React's bootstrapper has already overridden `self.__next_f.push` by the time the scan runs, so
re-pushed data is processed immediately by React.

**Security residual:**

An attacker who controls the server can inject additional `self.__next_f.push([{...}])` scripts that
pass pattern validation. This is **data injection into the React component tree** — not code
injection. No JavaScript executes that was not pre-approved. The residual threat is equivalent to
HTML injection on a stableInlineScripts SSR page: displayed values and component props can be
tampered with, but no new script runs.

dynamicRSC RSC is an opt-in mode. `@dappfence/next` emits a build warning (not an error) for
`force-dynamic` routes and explains the residual. The developer must explicitly enable dynamicRSC
RSC support in their config.

---

## What this closes (without any HTML parsing)

| Vector                                             | CSP mechanism                                                                           | Source                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| `on*` event handler attributes                     | Blocked by default (`default-src 'none'`); opt-in via `script-src-attr 'unsafe-hashes'` | Manifest `attrs` entries   |
| `eval()` / `new Function()` / `setTimeout(string)` | `'unsafe-eval'` absent                                                                  | No manifest data needed    |
| Static inline `<script>` blocks                    | Hashes from `manifest.csp.pages[pageKey].scripts` in `script-src-elem`                  | Manifest `scripts` entries |
| External scripts                                   | Origins from allow rules + `files` keys in `script-src-elem`                            | Manifest allow rules       |
| `<object>` / `<embed>`                             | `object-src 'none'`                                                                     | No manifest data needed    |
| WebAssembly                                        | `'wasm-unsafe-eval'` absent                                                             | No manifest data needed    |
| `data:` / `blob:` script src                       | Not listed in `script-src-elem`                                                         | No manifest data needed    |

---

## `on*` event handler attributes

By default `default-src 'none'` blocks all inline event handlers. Apps that cannot refactor away
from `on*` attributes can declare their handler values in the manifest; the SW then emits
`script-src-attr 'unsafe-hashes' <hashes>` for that page.

### Manifest shape

`csp.pages[pageKey]` accepts either a legacy array (scripts only) or an object with separate
`scripts` and `attrs` arrays:

```json
"csp": {
  "pages": {
    "/dashboard": {
      "scripts": ["sha256-<inline-script-hash>"],
      "attrs":   ["sha256-<onclick-handler-hash>"]
    }
  }
}
```

Each hash in `attrs` is the SHA-256 of the **raw attribute value text** exactly as it appears in the
HTML source (between the quotes, before any HTML entity decoding). The `@dappfence/manifest-tools`
`extractInlineAttrHashes(htmlPath)` function returns `{ attrs: [{name, value, hash}], warnings }`
and can be used at build time to discover all `on*` attribute values in a built HTML file.

When `extractFrom` is used in the build config, both script and attribute hashes are extracted
automatically. The build step logs each found handler so the developer can review what was included.

### `'unsafe-hashes'` is required

Unlike `<script>` elements where hash-based CSP works natively, event handler hashes **only apply
when `'unsafe-hashes'` is present** in `script-src-attr`. Without it the browser silently ignores
the hashes and blocks all handlers regardless. DappFence automatically includes `'unsafe-hashes'`
whenever `attrs` is non-empty; it is never emitted without accompanying hashes.

### Security caveat — prefer `addEventListener` where possible

`'unsafe-hashes'` weakens the isolation guarantee in one specific way: the browser allows any
element — including one injected by an attacker — to execute a handler if its attribute value
byte-for-byte matches a declared hash. In contrast, code attached via `addEventListener` inside a
hash-authorized `<script>` block is bound to a specific element and cannot be hijacked by
HTML-injection.

Concretely: if an attacker can inject arbitrary HTML into a stableInlineScripts SSR page and trick a
user into clicking an injected element, the handler runs. For staticPages static pages this is not a
concern (the full body hash check already blocks any HTML injection before the browser parses the
page).

**Recommendation:** for any new code, attach handlers via `addEventListener` inside a
hash-allowlisted `<script>` block. Use the `attrs` escape hatch only for legacy code where
refactoring is not feasible.

---

## The dynamic inline script gap

Hash-based CSP requires the inline script content to be **identical on every request**. A hash must
be computed at build time and embedded in both the manifest and the CSP header; per-request dynamic
content produces a different hash every time and cannot be pre-committed.

This is not a fixable gap within the hash-based approach. The alternatives are:

-   **Nonce injection** — requires HTML body rewriting (the complexity we are avoiding).
-   **Accept as a forcing function** — dynamic `<script>` content must be moved to
    `<script type="application/json">` data islands (not executable, not subject to CSP script-src).

The forcing-function outcome is the correct security posture: executing per-request dynamic data as
JavaScript is inherently riskier than using a data island that a verified static script reads. The
integration layer should emit a build-time warning for any route that would produce a dynamic
executable inline script.

---

## Framework analysis

### Astro — static routes (Cases 1, 2)

Full coverage. HTML is fixed at build time; inline scripts are static. All hashes are available at
manifest generation time. Nothing changes per request.

### Astro — SSR routes (Cases 3, 9, 10)

Coverage if — and only if — the route emits no dynamic executable `<script>` blocks. Astro SSR
routes typically emit one or more hydration bootstraps as inline scripts; these are static (same
bytes every request) and can be hashed. Per-request data should be placed in
`<script type="application/json">` islands (Case 8).

**Integration requirement (`@dappfence/astro`):** at build time, render each SSR route and assert
that every `<script>` without `type="application/json"` has identical content across multiple
renders. Fail the build if any inline script content varies.

### Next.js — Pages Router

Full coverage. Pages Router delivers initial props as a non-executable JSON island:

```html
<script id="__NEXT_DATA__" type="application/json">
    {"props":{...}}
</script>
```

`type="application/json"` is not subject to `script-src`. DappFence's extractor already skips these
as data islands. Any other inline scripts (hydration bootstraps) are static at build time and can be
hashed normally.

### Next.js — App Router, SSG / ISR routes

Full coverage. For statically generated pages, the RSC payload is served as a separate `.rsc` file
fetched on client-side navigation. The inline scripts embedded in the initial HTML are static
bootstrappers — their bytes are identical for every request to the same build. These can be hashed
into the manifest and listed in `script-src`.

### Next.js — App Router, `force-dynamic` routes (Case 6a)

Covered under dynamicRSC (opt-in). Next.js unconditionally embeds RSC payloads inline for
`force-dynamic` hard navigations:

```html
<script>
    self.__next_f.push([0, { timestamp: '2026-06-23T14:32:17.000Z' }]);
</script>
```

These blocks contain per-request dynamic data. No stable hash exists. Hash-based CSP blocks them.
`dappfence.js` re-pushes validated RSC payloads via the `securitypolicyviolation` event handler.
`@dappfence/next` emits a build warning when dynamicRSC is enabled and explains the data-injection
residual.

**What happens without dynamicRSC:**

Blocking RSC push scripts does not merely prevent the explicit Pattern A script from running — it
causes the entire page to disappear. The cascade: blocked push scripts → `self.__next_f` stays empty
→ `React.createFromReadableStream` throws `Connection closed` → React unmounts the root tree → the
server-rendered HTML is removed from the DOM. The violation report shows `lineNumber: 1` (Next.js
renders HTML as one long line) and `sample: ""` (no `'report-sample'` in the CSP), making it
visually indistinguishable from Pattern A violations. See **Case 20 — Next.js App Router: the RSC
cascade** in `docs/verification-cases.md` for the step-by-step sequence.

**Why server-side nonces do not help under DappFence's threat model:**

A CDN-level attacker (the primary threat DappFence addresses) sits between the origin server and the
browser and can read the full HTTP response — headers included. The server emits:

```
Content-Security-Policy: script-src 'nonce-abc123'
<script nonce="abc123">self.__next_f.push([...])</script>
```

The attacker reads `abc123` from the response header and injects
`<script nonce="abc123">steal()</script>`. The browser sees the nonce matches and executes it.
Server-side nonces are transparent to any MITM that can observe the response.

**Why hash-based CSP is MITM-resistant:** hashes are pre-committed into the signed manifest at build
time. A CDN attacker who injects `<script>steal()</script>` would need to produce content whose
SHA-256 matches a listed hash — a preimage attack on SHA-256. The attacker can only inject content
that passes CSP if it is byte-for-byte identical to one of the developer's own known-good scripts,
which provides no attack value.

**The only secure nonce option is SW-generated nonce + HTML body rewriting:** the SW generates a
nonce after receiving the response, rewrites `<script>` attributes to inject `nonce="..."`, and sets
the CSP header. The nonce is created inside the browser's trusted execution environment and is never
visible to a CDN MITM. This is secure but requires HTML body parsing — the complexity the hash-based
approach is designed to avoid.

**The `force-dynamic` trade-off:**

Removing `force-dynamic` (switching to SSG or ISR) restores full CSP coverage. What you give up:

-   **Per-request data freshness.** The page is rendered once at build time (SSG) or periodically
    (ISR). Data visible in the initial HTML is as stale as the last build or revalidation.
    Client-side fetches via verified API endpoints can supply real-time data after the page loads —
    the initial shell is static, the data is dynamic.
-   **Per-request server context.** `cookies()`, `headers()`, and `searchParams` cannot be read at
    render time without making the route dynamic. Auth-gated content, personalisation, and
    locale-from-header patterns all require either a client-side fetch after load or a middleware
    redirect to a static variant.
-   **SEO for truly dynamic content.** If the page content that must be in the initial HTML for SEO
    changes per request (e.g. user-specific metadata), SSG is not a substitute. In practice, most
    SEO-critical content is not user-specific.

For financial and security-sensitive applications — DappFence's primary target — the preferred
architecture is a static authenticated shell with client-side data fetching. `force-dynamic` is
often used for convenience rather than necessity; auditing each `force-dynamic` route for whether
SSG + client fetch is a viable substitute is a prerequisite for deploying DappFence with strict CSP.

`@dappfence/next` should emit a build-time error for each `force-dynamic` page and list the
alternatives, rather than silently downgrading to dynamicRSC.

### Next.js — static export

Full coverage. Behaves identically to Astro static routes.

### Case 13 — server-emitted nonces

Server-emitted nonces are insecure against CDN-level MITM (see above). DappFence should not
propagate or merge server-emitted nonce tokens. If the upstream response has a
`Content-Security-Policy` header, DappFence replaces it entirely with the manifest-derived policy
rather than merging.

---

## CSP violation reporting

### What the browser does when CSP blocks a script

Execution is blocked synchronously. The browser then sends an async POST to the `report-uri`
endpoint (if configured) with a JSON violation report:

```json
{
    "csp-report": {
        "document-uri": "https://app.example.com/dashboard",
        "violated-directive": "script-src-elem",
        "blocked-uri": "inline",
        "script-sample": "self.__next_f.push([0, {\"timesta",
        "source-file": "https://app.example.com/dashboard",
        "line-number": 42
    }
}
```

`script-sample` is the first 40 characters of the blocked inline script. Useful for diagnosis; not
enough to recompute the hash.

### DappFence violation pipeline

DappFence always injects `report-uri /sw-api/csp-violation` into the generated CSP. This endpoint is
already within the SW's scope, so the violation report POST fires a SW fetch event with
`event.clientId` set to the client that generated the violation.

The SW handles it:

```
CSP blocks script (browser, synchronous)
  → browser POSTs violation report to /sw-api/csp-violation
    → SW fetch event fires (event.clientId = violating page)
      → SW logs and stores violation (telemetry — browser already blocked execution)
```

DappFence **appends** its CSP header rather than replacing the server's existing one. A server-side
`Content-Security-Policy` with its own `report-uri` is preserved and the browser delivers to both
endpoints independently — no proxying needed.

### `report-uri` vs `report-to`

`report-uri` is deprecated but has universal browser support and its reports reliably fire the SW
fetch event. The newer Reporting API (`report-to` + `Reporting-Endpoints` header) has inconsistent
SW interception across browsers. DappFence uses `report-uri` for now. `report-to` can be added as an
additional directive once its SW interception behavior stabilises, but `report-uri` is the load-
bearing mechanism.

---

## Integration layer requirements summary

| Framework                               | Build-time requirement                                                   | SW behavior                                     |
| --------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `@dappfence/astro` (static)             | Extract inline script hashes into `manifest.csp.pages`                   | Inject manifest-derived CSP                     |
| `@dappfence/astro` (SSR)                | Assert no dynamic inline scripts; extract static hashes into `csp.pages` | Same as static                                  |
| `@dappfence/next` (static export)       | Hash inline scripts                                                      | Same as static                                  |
| `@dappfence/next` (RSC `force-dynamic`) | Build warning — dynamicRSC opt-in required; residual explained           | RSC re-push via `securitypolicyviolation` event |

---

## Remaining gaps

| Vector                                                | Status                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Dynamic inline scripts (Next.js RSC `force-dynamic`)  | dynamicRSC opt-in: RSC re-push after pattern validation; data injection residual remains |
| `eval()` in verified scripts that legitimately use it | `'unsafe-eval'` must stay; cannot be removed without breaking those scripts              |
| Blob URL workers/iframes from verified scripts        | `worker-src` without `blob:` would break legitimate patterns                             |
| `postMessage` + `eval` (16b)                          | Requires static analysis; not addressable by CSP or SW                                   |
