/**
 * End-to-end tests for Clear-Site-Data emergency panel.
 *
 * Chrome processes Clear-Site-Data at the network layer — when the SW's
 * inner fetch() receives the server response, AppSecurity.onclose fires synchronously
 * enough that isClosed() is true by the time the SW checks it in the same request
 * handler. Clear-Site-Data: "storage" also unregisters the SW.
 *
 * Two detection paths:
 *   1. Client side (AppSecurityWatchdog.onclose): fires when a running page receives a
 *      response with Clear-Site-Data, replacing the DOM with the emergency panel.
 *   2. SW side (appStore.isClosed()): fires on the same navigation that carries
 *      Clear-Site-Data, returning the emergency panel before content checks run.
 *      Because Clear-Site-Data also unregisters the SW, this path is only exercised
 *      from about:blank (no client context running).
 */
import { expect, test } from '../sw-fixtures';

test.describe('Clear-Site-Data: client-side detection via AppSecurityWatchdog', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        await swHelper.waitForServiceWorkerActivation();
    });

    test('Subresource fetch with Clear-Site-Data closes AppSecurityWatchdog and shows emergency panel', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '**/null.js',
                    headers: {
                        'Clear-Site-Data': '"storage"',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                    },
                },
            ],
        });

        // Fetch a resource that returns Clear-Site-Data: "storage". The SW passes it
        // through unchanged (destination=""), so the header reaches the browser and
        // forces all IndexedDB connections for this origin to close.
        await page.evaluate(async () => {
            const r = await fetch('/null.js');
            await r.text();
        });

        // AppSecurityWatchdog.onclose fires and replaces the page DOM with the emergency panel.
        await expect(page.locator('h1')).toHaveText('Security Action Required', { timeout: 5000 });
    });
});

test.describe('Clear-Site-Data: SW-side detection via isClosed()', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        await swHelper.waitForServiceWorkerActivation();

        // Navigate away so no DappFence client context is running.
        // AppSecurityWatchdog is not open — the SW is the only line of defense.
        await page.goto('about:blank');
    });

    test('navigation with Clear-Site-Data on correct content returns SW emergency panel', async ({
        page,
        swHelper,
    }) => {
        // Serve the correct page (hash matches manifest) + Clear-Site-Data: "storage".
        // isClosed() fires on the same navigation (before applyIntegrityPolicy) and the
        // SW returns the emergency panel even though the content would have passed.
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '**/',
                    headers: {
                        'Clear-Site-Data': '"storage"',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                    },
                },
            ],
        });

        await page.goto('');

        await expect(page.locator('h1')).toHaveText('Security Action Required', { timeout: 10000 });
    });

    test('navigation with Clear-Site-Data on withoutDappfence.html returns SW emergency panel before integrity check', async ({
        page,
        swHelper,
    }) => {
        // Navigate directly to withoutDappfence.html served with Clear-Site-Data: "storage".
        // isClosed() fires before applyIntegrityPolicy, so the emergency panel is returned
        // rather than the integrity block — Clear-Site-Data preempts the content check.
        await swHelper.setServerTestParameters({
            responseHeaders: [
                {
                    match: '**/withoutDappfence.html',
                    headers: {
                        'Clear-Site-Data': '"storage"',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                    },
                },
            ],
        });

        await page.goto('/withoutDappfence.html');

        await expect(page.locator('h1')).toHaveText('Security Action Required', { timeout: 10000 });
    });
});

test.describe('Clear-Site-Data: "*" on a navigation opened in a new tab', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        await swHelper.waitForServiceWorkerActivation();
    });

    test('navigating to /xslt-safety-test.xml with Clear-Site-Data: "*" shows emergency panel', async ({
        page,
        swHelper,
    }) => {
        // Mirror devSetClearSiteData('"*"', '/xslt-safety-test.xml'):
        //   - root serves withoutDappfence.html (no DappFence after storage+SW wipe)
        //   - /xslt-safety-test.xml carries Clear-Site-Data: "*"
        // The SW detects isClosed() on the navigation and returns the emergency panel.
        // Note: Clear-Site-Data: "*" also unregisters the SW, so in a real browser
        // without DevTools the SW may be torn down before respondWith() completes and
        // the tab hangs. Headless Chromium handles this differently.
        await swHelper.setServerTestParameters({
            intercept: [
                { pattern: '/dappfence.js', formula: 'unchanged' },
                { pattern: '/integrity-manifest.json', formula: 'unchanged' },
                { pattern: '^/$', formula: 'replace', args: 'withoutDappfence.html' },
            ],
            responseHeaders: [
                {
                    match: '/xslt-safety-test.xml',
                    headers: {
                        'Clear-Site-Data': '"*"',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        Pragma: 'no-cache',
                        Expires: '0',
                    },
                },
            ],
        });

        const newTab = await swHelper.newPage('xslt-tab');
        await newTab.goto('/xslt-safety-test.xml');

        // New tab: SW detects isClosed() on the navigation and returns the emergency panel.
        await expect(newTab.locator('h1')).toHaveText('Security Action Required', {
            timeout: 10000,
        });

        // Original tab: AppSecurityWatchdog.onclose fires because Clear-Site-Data: "*"
        // closes the IndexedDB connection for the whole origin, replacing the DOM.
        await expect(page.locator('h1')).toHaveText('Security Action Required', {
            timeout: 5000,
        });
    });

    test('clicking the Open /xslt-safety-test.xml link shows emergency panel in new tab', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            intercept: [
                { pattern: '/dappfence.js', formula: 'unchanged' },
                { pattern: '/integrity-manifest.json', formula: 'unchanged' },
                { pattern: '^/$', formula: 'replace', args: 'withoutDappfence.html' },
            ],
            responseHeaders: [
                {
                    match: '/xslt-safety-test.xml',
                    headers: {
                        'Clear-Site-Data': '"*"',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        Pragma: 'no-cache',
                        Expires: '0',
                    },
                },
            ],
        });

        const [newTab] = await Promise.all([
            page.context().waitForEvent('page'),
            page.click('a[href="/xslt-safety-test.xml"]'),
        ]);

        // New tab: SW detects isClosed() on the navigation and returns the emergency panel.
        await expect(newTab.locator('h1')).toHaveText('Security Action Required', {
            timeout: 10000,
        });

        // Original tab: AppSecurityWatchdog.onclose fires because Clear-Site-Data: "*"
        // closes the IndexedDB connection for the whole origin, replacing the DOM.
        await expect(page.locator('h1')).toHaveText('Security Action Required', {
            timeout: 5000,
        });
    });
});
