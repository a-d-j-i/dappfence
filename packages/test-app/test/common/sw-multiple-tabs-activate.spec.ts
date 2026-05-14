/**
 * End-to-end tests for the Service Worker functionality.
 */
import { expect, test } from '../sw-fixtures';

test("should claim pages that doesn't have dappfence installed", async ({ swHelper }, testInfo) => {
    const pageBefore = await swHelper.newPage('before page without dappfence');
    // Load a page that doesn't have dappfence
    await pageBefore.goto('/withoutDappfence.html');
    await expect(pageBefore).toHaveTitle('Without dappfence example');
    const urlBeforeSwApp = await swHelper.waitForServiceWorkerActivation(pageBefore);
    expect(urlBeforeSwApp).toContain('sw_app.js');

    // Load a page with dappfence
    const mainPage = await swHelper.newPage('main page');
    await mainPage.goto('');
    await expect(mainPage).toHaveTitle('DappFence - Manifest Mode Example');

    const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
    const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 3 : 2);
    await serviceWorkers[0].waitUntilClosed();
    if (swCapture) {
        // Wait for the first service worker (sw_register.js) to close after registering sw_app.js.
        // This ensures sw_app.js becomes the active service worker before proceeding with tests.
        // Note: Adding app.js to index.html would cause polling to /sw-api, preventing the first
        // service worker without the appSW parameter from closing, which would break this wait logic.
        await serviceWorkers[1].waitUntilClosed();
    }
    // We don't know which one is active, because sometimes the second one stays in loading state forever
    const url = await swHelper.waitForServiceWorkerActivation(mainPage);
    expect(url).toContain('dappfence.js');
    if (swCapture || testInfo.project.name.startsWith('simple-app-sw-fixed')) {
        expect(url).toContain('appSW=sw_app.js');
    }

    const pageAfter = await swHelper.newPage('after page without any sw');
    // Load a page that doesn't have dappfence
    await pageAfter.goto('/sign.html');
    await expect(pageAfter).toHaveTitle('Personal Message Signing');

    const urlBefore = await swHelper.waitForServiceWorkerActivation(pageBefore);
    const urlAfter = await swHelper.waitForServiceWorkerActivation(pageAfter);
    expect(urlAfter).toContain('dappfence.js');
    expect(urlBefore).toContain('dappfence.js');
    if (
        testInfo.project.name.startsWith('simple-app-sw-capture') ||
        testInfo.project.name.startsWith('simple-app-sw-fixed')
    ) {
        expect(urlBefore).toContain('appSW=sw_app.js');
        expect(urlAfter).toContain('appSW=sw_app.js');
    }
    // Checks the service worker response on each page
    for (const p of [pageBefore, mainPage, pageAfter]) {
        const status = await p.evaluate(async () => {
            const response = await fetch('/sw-api/status');
            if (!response.ok) {
                throw new Error(
                    `Failed to fetch status: ${response.status} ${response.statusText}`
                );
            }
            return await response.json();
        });
        expect(status.appVersion).toBeDefined();
    }
});
