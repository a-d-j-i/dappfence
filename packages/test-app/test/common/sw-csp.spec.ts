import { expect, test } from '../sw-fixtures';

// SHA-256 of the first inline template script body in simple-app.html:
//   "\n            window.__csp_inline_1 = 'script-1-ran';\n        "
// Stable as long as the template script content and indentation don't change.
const CSP_INLINE_1_HASH = 'sha256-vRDxHJVof5XdgQz3jMqMeB0wpoGfCWXTSV60g2VfXx4=';

test.describe('CSP injection', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('SW injects Content-Security-Policy header on document navigation', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain('script-src-elem');
        expect(csp).toContain('*');
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain("base-uri 'self'");
        expect(csp).toContain('report-uri');
    });

    test('CSP header for path with no csp.pages entry has no hash or strict-dynamic', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).not.toContain('sha256-');
        expect(csp).not.toContain('strict-dynamic');
    });

    test('CSP header for path with csp.pages entry includes hashes', async ({ page, swHelper }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-allowed');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain(`'${CSP_INLINE_1_HASH}'`);
        expect(csp).toContain('*');
    });

    test('page loads without CSP violations and all directives have the expected semantics', async ({
        page,
        swHelper,
    }) => {
        // Capture any CSP violations that fire during page load. The init script runs
        // before any page JS, so the listener is active before dappfence.js executes.
        await page.addInitScript(() => {
            (window as unknown as Record<string, unknown>).__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (e) => {
                ((window as unknown as Record<string, unknown>).__cspViolations as string[]).push(
                    `${e.effectiveDirective}: ${e.blockedURI}`
                );
            });
        });

        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-allowed');

        // The SW must serve this response — DappFence is in control.
        expect(response.fromServiceWorker()).toBeTruthy();
        const isControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
        expect(isControlled).toBeTruthy();

        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();

        // default-src 'none': deny-all baseline — every permitted resource type must be
        // listed explicitly; prevents new resource types from being silently permitted.
        expect(csp).toContain("default-src 'none'");

        // script-src-elem controls <script> elements (both inline and external src).
        //   - Inline scripts: only those whose SHA-256 matches a hash in this directive run;
        //     all others are blocked by the browser without DappFence involvement.
        //   - External scripts (*): any origin is permitted at the CSP level. DappFence
        //     already verifies every external script by content hash at the SW layer, so
        //     restricting by origin in the CSP would add no security benefit.
        //   - 'strict-dynamic' is omitted: it is incompatible with '*' (strict-dynamic
        //     ignores all origin allowlists), and the trust propagation it provides is
        //     already covered by DappFence's SW-level verification.
        //   - eval / new Function / inline event handlers are NOT covered by script-src-elem
        //     and fall back to default-src 'none' — they remain blocked.
        expect(csp).toContain('script-src-elem');
        expect(csp).toContain(`'${CSP_INLINE_1_HASH}'`); // one of the hashed template scripts
        expect(csp).toContain('*');
        expect(csp).not.toContain('strict-dynamic');

        // style-src 'self' 'unsafe-inline': 'unsafe-inline' is safe for styles because all
        // CSS JS-execution vectors (expression(), behavior:, HTC) are IE-only and dead in
        // modern browsers — see docs/js-execution-vectors.md §11.
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");

        // worker-src 'self': DappFence registers its own service worker from the page
        // context (navigator.serviceWorker.register in dappfence.js). Without this,
        // default-src 'none' would block the registration. 'self' cannot be tightened to a
        // specific path without hardcoding the deployment URL. The browser already enforces
        // that service workers must be same-origin regardless of CSP.
        expect(csp).toContain("worker-src 'self'");

        // object-src 'none': blocks Flash, Java, and PDF plugin execution vectors (§4 of
        // docs/js-execution-vectors.md). No legitimate use case requires plugin embeds.
        expect(csp).toContain("object-src 'none'");

        // base-uri 'self': prevents <base href> injection. Without this, an attacker who
        // can inject a <base> tag can redirect all relative URLs (including script src
        // attributes) to an attacker-controlled origin.
        expect(csp).toContain("base-uri 'self'");

        // frame-ancestors 'none': prevents the page from being loaded inside an iframe,
        // closing clickjacking and UI-redressing attack vectors.
        expect(csp).toContain("frame-ancestors 'none'");

        // report-uri: CSP violations are posted to the SW API endpoint. The SW logs them
        // in IndexedDB and exposes them via /sw-api/status. The token query param
        // authenticates the report so the endpoint rejects unauthenticated posts.
        expect(csp).toContain('report-uri');
        expect(csp).toContain('/sw-api/csp-violation');

        // Styles applied: check a CSS custom property from the inline <style> block.
        // If style-src had blocked the inline styles this property would be empty.
        const brandColor = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--color-brand').trim()
        );
        expect(brandColor).toBeTruthy();

        // No CSP violations during page load — every directive is correctly configured.
        const violations = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__cspViolations as string[]
        );
        expect(violations).toEqual([]);
    });

    test('inline script without a matching hash is blocked by browser CSP', async ({
        page,
        swHelper,
    }) => {
        const unknownScript = '<script>window.__blockedScriptRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html', inject: [unknownScript, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-denied');
        const ran = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__blockedScriptRan
        );
        expect(ran).toBeUndefined();
    });

    test('POST /sw-api/csp-violation returns 204 when called with the token from report-uri', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        // The SW embeds ?token=<apiToken> in the report-uri directive.
        // Extract the full URL so the test can POST with a valid token.
        const reportUriMatch = csp.match(/report-uri\s+(\S+)/);
        const reportUri = reportUriMatch?.[1];
        expect(reportUri).toContain('/sw-api/csp-violation');

        const status = await page.evaluate(async (uri) => {
            const res = await fetch(uri, {
                method: 'POST',
                headers: { 'Content-Type': 'application/csp-report' },
                body: JSON.stringify({
                    'csp-report': {
                        'blocked-uri': 'inline',
                        'document-uri': window.location.href,
                        'violated-directive': 'script-src-elem',
                    },
                }),
            });
            return res.status;
        }, reportUri);
        expect(status).toBe(204);
    });

    test('CSP violation is stored in IndexedDB and visible in /sw-api/status', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-denied');
        const csp = response.headers()['content-security-policy'];
        const reportUriMatch = csp.match(/report-uri\s+(\S+)/);
        const reportUri = reportUriMatch?.[1];

        const violationReport = {
            'csp-report': {
                'blocked-uri': 'inline',
                'document-uri': 'http://localhost:3333/csp-test-denied',
                'violated-directive': 'script-src-elem',
            },
        };
        await page.evaluate(
            async ({ uri, body }) => {
                await fetch(uri, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/csp-report' },
                    body: JSON.stringify(body),
                });
            },
            { uri: reportUri, body: violationReport }
        );

        const status = await page.evaluate(async () => {
            const res = await fetch('/sw-api/status');
            return res.json();
        });
        expect(status.cspViolations).toBeDefined();
        expect(status.cspViolations.length).toBeGreaterThan(0);
        expect(status.cspViolations[0].report?.['csp-report']?.['violated-directive']).toBe(
            'script-src-elem'
        );
        expect(status.cspViolations[0].receivedAt).toBeDefined();
        expect(status.stats.totalCspViolations).toBeGreaterThan(0);
    });

    test('template inline scripts execute when their hashes are in the manifest', async ({
        page,
        swHelper,
    }) => {
        const injectedScript = '<script>window.__injectedRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedScript, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-allowed');
        // Wait for the 50ms setTimeout template script to fire
        await page.waitForFunction(
            () => (window as unknown as Record<string, unknown>).__csp_timer !== undefined,
            { timeout: 2000 }
        );
        const result = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                cspInline1: w.__csp_inline_1,
                cspTimer: w.__csp_timer,
                rscChunks: w.__rsc_chunks,
                bypassExecuted: w.__bypass_executed,
                injectedRan: w.__injectedRan,
            };
        });
        expect(result.cspInline1).toBe('script-1-ran');
        expect(result.cspTimer).toBe('timer-ran');
        expect(result.rscChunks).toEqual([
            [0, { value: 42 }],
            [0, '<!--<script>'],
        ]);
        expect(result.bypassExecuted).toBe(true);
        expect(result.injectedRan).toBeUndefined();
    });

    // TODO(MutationObserver): update this test once the client-side Observer is implemented.
    // The Observer will detect the blocked RSC push, validate its JSON structure, and call
    // self.__next_f.push() safely — so rscChunks should then include [0, { value: 99 }].
    test('injected RSC push script is blocked by CSP when its hash is not in the manifest', async ({
        page,
        swHelper,
    }) => {
        // Template scripts on /csp-test-allowed have hashes in the manifest — RSC emulator runs.
        // The injected push has no hash — CSP blocks it, so value:99 never lands in rscChunks.
        const injectedPush = '<script>self.__next_f.push([0, { value: 99 }]);</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedPush, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-allowed');
        await page.waitForFunction(
            () => Array.isArray((window as unknown as Record<string, unknown>).__rsc_chunks),
            { timeout: 2000 }
        );
        const chunks = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__rsc_chunks
        );
        // Only the two template RSC pushes ran; the injected value:99 push was blocked.
        expect(chunks).toEqual([
            [0, { value: 42 }],
            [0, '<!--<script>'],
        ]);
    });

    test('all inline scripts are blocked when the manifest has no hashes for the page', async ({
        page,
        swHelper,
    }) => {
        const injectedScript = '<script>window.__cspAllowedScriptRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-rsc',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedScript, '<!-- test:inject-body-end -->'] },
        });
        await page.goto('/csp-test-rsc');
        const result = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                bypass_executed: w.__bypass_executed,
                cspInline1: w.__csp_inline_1,
                cspTimer: w.__csp_timer,
                rscChunks: w.__rsc_chunks,
                cspAllowedScriptRan: w.__cspAllowedScriptRan,
            };
        });
        expect(result.bypass_executed).toBeUndefined();
        expect(result.cspInline1).toBeUndefined();
        expect(result.cspTimer).toBeUndefined();
        expect(result.rscChunks).toBeUndefined();
        expect(result.cspAllowedScriptRan).toBeUndefined();
    });

    test('all template inline scripts run when the page has no CSP header', async ({ page }) => {
        // Navigate to the root — full-hash path, no CSP rule matches, no CSP header injected.
        // All inline scripts in simple-app.html should execute normally.
        const response = await page.goto('/');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeUndefined();

        // Wait for the 50ms setTimeout in the template to fire.
        await page.waitForFunction(
            () => (window as unknown as Record<string, unknown>).__csp_timer !== undefined,
            { timeout: 2000 }
        );

        const result = await page.evaluate(() => {
            const w = window as unknown as Record<string, unknown>;
            return {
                cspInline1: w.__csp_inline_1,
                cspTimer: w.__csp_timer,
                rscChunks: w.__rsc_chunks,
                bypassExecuted: w.__bypass_executed,
            };
        });

        expect(result.cspInline1).toBe('script-1-ran');
        expect(result.cspTimer).toBe('timer-ran');
        // Both RSC pushes run: first the object push, then the double-escape push.
        expect(result.rscChunks).toEqual([
            [0, { value: 42 }],
            [0, '<!--<script>'],
        ]);
        // The </script>/ trick makes </script> parse as </regexp/ in JS; __bypass_executed runs.
        expect(result.bypassExecuted).toBe(true);
    });
});
