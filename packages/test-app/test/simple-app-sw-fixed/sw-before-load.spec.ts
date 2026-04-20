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
            // It can happen at any time, we create the promise and wait for it latter so we don't lose the message.
            // This message corresponds to the console.log inside `sw_utils.js` we check that the file is loaded
            const childWorkerMessage = swHelper.waitForServiceWorkerMessage(
                'Utility functions registered globally'
            );
            const initialResponse = await page.goto(path);
            expect(initialResponse.fromServiceWorker()).toBeFalsy();
            // const response =
            await page.goto('some_subdirectory/index_copy.html');
            await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
            expect(initialResponse.fromServiceWorker()).toBeFalsy();
            // This cannot be warrantied in the before case: expect(response.fromServiceWorker()).toBeTruthy();

            // The child service worker is loaded, we will verify if it is working properly in a different test
            await childWorkerMessage;
        });
    });
});

test('should register a single service worker, no automatic child SW capture', async ({
    page,
    context,
    swHelper,
}) => {
    // Service worker lifecycle verification:
    // 1. Initial page load: Page is NOT served by the service worker (not yet installed)
    // 2. Service worker registration: This example (simple-app-sw-capture) loads the DappFence service worker,
    //    which internally imports the child service worker (sw_app.js) using the appSW parameter
    // 3. After reload: Only the DappFence service worker with the appSW parameter should remain active
    const response0 = await page.goto('');

    const serviceWorkers = await swHelper.waitForServiceWorkers(1);
    const swURL = await swHelper.waitForServiceWorkerActivation();

    const urls1 = serviceWorkers.map((sw) => sw.url());
    expect(urls1.length).toBe(1);
    expect(urls1[0]).toContain('/dappfence.js');
    expect(urls1[0]).toContain('appSW=sw_app.js');
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
    expect(urls2[0]).toContain('appSW=sw_app.js');

    const url22 = context.serviceWorkers().map((sw) => sw.url());
    expect(url22.length).toBe(1);
    expect(url22[0]).toContain('/dappfence.js');
    expect(url22[0]).toContain('appSW=sw_app.js');

    expect(response0.fromServiceWorker()).toBeFalsy();
    expect(response1.fromServiceWorker()).toBeTruthy();

    const dappfenceStatus = await page.evaluate(async () => {
        const res = await fetch('/sw-api/status');
        return await res.json();
    });
    expect(dappfenceStatus.appVersion).toBeDefined();

    const simpleAppStatus = await page.evaluate(async () => {
        const res = await fetch('/simple-app/status');
        return await res.json();
    });
    expect(simpleAppStatus.status).toBe('simple app ready');
});
