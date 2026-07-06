import { expect, test } from '../sw-fixtures';

// Content of the script whose hash is in the test manifest's csp.pages['/csp-test-allowed'].
// SHA-256 of this string = dn3lpVwy3xTrVW9IFWo1OhSyOw1z11oIQpnUeJ0FHzY=
// const CSP_ALLOWED_SCRIPT_CONTENT = 'window.__cspAllowedScriptRan = true;';
const CSP_ALLOWED_HASH = 'sha256-dn3lpVwy3xTrVW9IFWo1OhSyOw1z11oIQpnUeJ0FHzY=';

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
        expect(csp).toContain("script-src 'self'");
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

    test('CSP header for path with csp.pages entry includes the hash and strict-dynamic', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html' },
        });
        const response = await page.goto('/csp-test-allowed');
        expect(response.fromServiceWorker()).toBeTruthy();
        const csp = response.headers()['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain(`'${CSP_ALLOWED_HASH}'`);
        expect(csp).toContain("'strict-dynamic'");
    });

    test('inline script without a matching hash is blocked by browser CSP', async ({
        page,
        swHelper,
    }) => {
        const unknownScript = '<script>window.__blockedScriptRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-denied',
            formula: 'remap',
            args: { file: 'index.html', inject: [unknownScript, '</body>'] },
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

    test('inline script with matching hash is allowed by CSP and executes', async ({
        page,
        swHelper,
    }) => {
        const allowedScript = '<script>window.__cspAllowedScriptRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-allowed',
            formula: 'remap',
            args: { file: 'index.html', inject: [allowedScript, '</body>'] },
        });
        await page.goto('/csp-test-allowed');
        const ran = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__cspAllowedScriptRan
        );
        expect(ran).toBe(true);
    });

    test('all inline scripts are blocked when the manifest has no hashes for the page', async ({
        page,
        swHelper,
    }) => {
        const injectedScript = '<script>window.__cspAllowedScriptRan = true;</script>';
        await swHelper.interceptAndModifyPageContent({
            pattern: '/csp-test-rsc',
            formula: 'remap',
            args: { file: 'index.html', inject: [injectedScript, '</body>'] },
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
