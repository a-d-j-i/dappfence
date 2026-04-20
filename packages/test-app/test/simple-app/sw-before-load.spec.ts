/*
 * During the first load the service worker is not installed, so we cannot catch the fetch event,
 * still we potently may want to do some checks on certain files and values.
 */
import { expect, test } from '../sw-fixtures'; // WE USE FIXTURES!!!!

['', 'index_copy.html', 'some_subdirectory/index_copy.html'].forEach((path) => {
    test.describe(`index.html file${path.length == 0 ? '' : ' copy in ' + path}`, () => {
        test('should load a signed page without service worker on first visit', async ({
            page,
            swHelper,
        }) => {
            // We need this call just to enshure that we hook requests.
            await swHelper.setVersion('latest');
            const initialResponse = await page.goto(path);
            await page.goto('some_subdirectory/index_copy.html');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            expect(initialResponse.fromServiceWorker()).toBeFalsy();
            // This cannot be warrantied in the before case: expect(response.fromServiceWorker()).toBeTruthy();
        });
    });
});

test('should register a single service worker, no automatic child SW capture', async ({
    page,
    context,
    swHelper,
}) => {
    // 1. The first time the page is not loaded via the service worker
    // 2. This example (simple-app) only loads our serviceworker on reload it must be loaded and nothing more
    const response0 = await page.goto('');

    const serviceWorkers = await swHelper.waitForServiceWorkers(1);
    const swURL = await swHelper.waitForServiceWorkerActivation();

    const urls1 = serviceWorkers.map((sw) => sw.url());
    expect(urls1.length).toBe(1);
    expect(urls1[0]).toContain('/dappfence.js');
    expect(urls1[0]).not.toContain('appSW=sw_app.js');
    expect(swURL).toBe(urls1[0]);

    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    const response1 = await page.reload();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    await page.waitForTimeout(300);
    // Ensure no additional service workers are registered after reload
    await swHelper.waitForServiceWorkerActivation();

    const serviceWorkers2 = await swHelper.waitForServiceWorkers(0);
    const urls2 = serviceWorkers2.map((sw) => sw.url());
    expect(urls2.length).toBe(1);
    expect(urls2[0]).toContain('/dappfence.js');
    expect(urls2[0]).not.toContain('appSW=sw_app.js');

    const url22 = context.serviceWorkers().map((sw) => sw.url());
    expect(url22.length).toBe(1);
    expect(url22[0]).toContain('/dappfence.js');
    expect(url22[0]).not.toContain('appSW=sw_app.js');

    expect(response0.fromServiceWorker()).toBeFalsy();
    expect(response1.fromServiceWorker()).toBeTruthy();
    const status = await page.evaluate(async () => {
        const res = await fetch('/sw-api/status');
        return await res.json();
    });
    expect(status.appVersion).toBeDefined();
});
