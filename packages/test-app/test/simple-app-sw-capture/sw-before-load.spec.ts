/*
 * During the first load the service worker is not installed, so we cannot catch the fetch event,
 * still we potently may want to do some checks on certain files and values.
 */
import { expect, test } from '../sw-fixtures';

test.describe(`index.html file`, () => {
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
});

test('should register a single service worker, no automatic child SW capture', async ({
    page,
    swHelper,
}) => {
    // 1. The first time the page is not loaded via the service worker
    // 2. The service worker is loaded twice, the second time with the captured child sw app (`appSW=sw_app.js`)
    // 3. During page reload, the service worker is loaded, but it doesn't reload itself again
    // 4. The second time the page is loaded via the service worker
    const swPromise = swHelper.waitForServiceWorkers(2);
    const response0 = await page.goto('', { waitUntil: 'domcontentloaded' });

    const serviceWorkers = await swPromise;
    const urls1 = serviceWorkers.map((sw) => sw.url());
    expect(urls1[0]).toContain('/dappfence.js');
    expect(urls1[0]).not.toContain('appSW=sw_app.js');
    expect(urls1[1]).toContain('/dappfence.js');
    expect(urls1[1]).toContain('appSW=sw_app.js');

    expect(response0.fromServiceWorker()).toBeFalsy();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

    await serviceWorkers[0].waitUntilClosed();
    // Ensure no additional service workers are registered after reload
    const url = await swHelper.waitForServiceWorkerActivation();
    expect(url).toContain('appSW=sw_app.js');

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

test.fail(
    'this test will fail, used to reproduce an issue with playwright when pooling /sw-api/status',
    async ({ page, swHelper }) => {
        // This test demonstrates a Playwright-specific issue where polling /sw-api/status
        // prevents service worker lifecycle transitions. Kept for future reference and debugging.
        test.skip();

        // Service Worker Registration Lifecycle:
        // 1. Initial load: dappfence.js registers without appSW parameter (temporary instance)
        // 2. After app SW capture: dappfence.js?appSW=sw_app.js registers and becomes controller
        //
        // Note: In Playwright, polling /sw-api/status prevents the first service worker instance
        // from terminating, which blocks the second instance with appSW from becoming active.
        // Loop DONE!!!! 1 installing null null
        // Loop DONE!!!! 1 waiting http://localhost:8080/dappfence.js?appSW=sw_app.js&manifestUrl=...
        // Loop DONE!!!! 1 active http://localhost:8080/dappfence.js?manifestUrl=...
        // This comment mirrors app.js functionality. We use addInitScript here to demonstrate how polling /sw-api/status
        // during initialization can interfere with service worker lifecycle transitions
        await page.addInitScript(() => {
            function logRegistrations(msg) {
                console.log(
                    msg,
                    `controller ${navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL}`
                );
                navigator.serviceWorker.getRegistrations().then((registrations) => {
                    registrations.forEach((registration) => {
                        ['installing', 'waiting', 'active'].forEach((state) => {
                            console.log(
                                msg,
                                registrations.length,
                                state,
                                registration[state] && registration[state].scriptURL,
                                registration[state] && registration[state].state
                            );
                        });
                    });
                });
            }
            navigator.serviceWorker.ready.then(async () => {
                let i = 0;

                function heavilyPollingStatus() {
                    fetch('/sw-api/status')
                        .then(() => {
                            if (i++ < 100) {
                                setTimeout(heavilyPollingStatus, 1);
                            } else {
                                logRegistrations('Loop DONE!!!!');
                            }
                        })
                        .catch((err) => console.error('error fetching status', err));
                }

                heavilyPollingStatus();
            });
        });

        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const serviceWorkers = await swHelper.waitForServiceWorkers(2);
        // Wait for the first service worker (sw_register.js) to close after registering sw_app.js.
        // This ensures sw_app.js becomes the active service worker before proceeding with tests.
        // Note: Adding app.js to index.html would cause polling to /sw-api, preventing the first
        // service worker without the appSW parameter from closing, which would break this wait logic.
        await serviceWorkers[0].waitUntilClosed();

        // We don't know which one is active, because sometimes the second one stays in loading state forever
        const url = await swHelper.waitForServiceWorkerActivation();
        expect(url).toContain('appSW=sw_app.js');
    }
);

test('should be able to reload the page from the test server', async ({ page, swHelper }) => {
    await page.goto('');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    const serviceWorkers = await swHelper.waitForServiceWorkers(2);
    await serviceWorkers[0].waitUntilClosed();
    // We don't know which one is active, because sometimes the second one stays in loading state forever
    const url = await swHelper.waitForServiceWorkerActivation();
    expect(url).toContain('appSW=sw_app.js');
    for (let i = 0; i < 10; i++) {
        const response = await page.reload();
        // Intermittent test failure: fromServiceWorker() occasionally returns false after the first reload.
        // Root cause: The dual service worker loading pattern (first without appSW, then with appSW parameter) seems
        // to be creating a race condition where the service worker may not be fully active during the reload timing window.
        expect(response.fromServiceWorker()).toBeTruthy();
    }
});
