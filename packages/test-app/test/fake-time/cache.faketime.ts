import { expect, test } from '../sw-fixtures';

test.setTimeout(20 * 60 * 60 * 1000); // 20 minutes

function formatTimestampDelta(start: number, end: number) {
    const deltaSecs = Math.floor((end - start) / 1000);
    const hours = Math.floor(deltaSecs / 3600);
    const minutes = Math.floor((deltaSecs % 3600) / 60);
    const secs = deltaSecs % 60;
    const format = (n: number) => n.toString().padStart(2, '0');
    return `${format(hours)}:${format(minutes)}:${format(secs)}`;
}

test('measure cache expiration time for DappFence reload with fake time acceleration', async ({
    page,
    swHelper,
    baseURL,
}) => {
    await swHelper.setServerTestParameters({
        appName: 'simple-app',
        appVersion: 'latest',
        saveResponses: true,
        responseHeaders: [
            {
                match: '*',
                headers: {
                    'Cache-Control': 'max-age=3600000', // 1000 hours
                },
            },
        ],
    });

    await page.goto('');
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    await swHelper.waitForServiceWorkerActivation(page);

    // await swHelper.interceptAndModifyPageContent('**/dappfence.js');
    const prevRequests = await swHelper.getServerResponses();

    const DELAY = 10 * 1000; // ms we wait between page reloads
    const ADVANCE = 4 * 60; // the pace at which the clock advances inside the browser

    await swHelper.setFakeTime(`+0 x${ADVANCE}`);

    const startDate = await page.evaluate(() => Date.now());
    let requests = [];
    let endDate = startDate;
    let i = 0;
    while (true) {
        // Log iteration and time while libfaketime speeds up the page's clock independently of Playwright's
        console.log(
            'Estimated delta',
            formatTimestampDelta(0, i++ * DELAY * ADVANCE),
            'Browser delta',
            formatTimestampDelta(startDate, endDate),
            'Current Time',
            new Date().toTimeString().slice(0, 8)
        );
        // OBS: libfaketime affects the way page.waitForTimeout() works.
        await new Promise((resolve) => setTimeout(resolve, DELAY));

        requests = (await swHelper.getServerResponses())
            .slice(prevRequests.length)
            .filter((x) => x.url.includes('dappfence'));
        if (requests.length !== 0) {
            break;
        }

        try {
            endDate = await page.evaluate(() => Date.now());
        } catch (err) {
            console.log('Error evaluating Date.now():', err.toString());
        }

        // Page reload serves most resources from the browser cache; only the root document (/) triggers a new network request
        // Skip awaiting page.reload() to prevent timing variability in test execution
        // OBS: When we don't do a reload (we are still doing non-network related stuff in the browser), there is a dappfence
        // fetch around 43hs (an ajax fetch doesn't change anything)
        const doReload = true;
        if (doReload) {
            page.reload({ waitUntil: 'commit' }).catch((err) => console.log(err.toString()));
        }
    }
    // Check what we fetched that wasn't the base URL
    requests = (await swHelper.getServerResponses())
        .slice(prevRequests.length)
        .filter((x) => x.url !== baseURL);
    console.log();
    console.log();
    console.log(
        'Time until DappFence was fetched again:',
        formatTimestampDelta(startDate, endDate),
        '- What we fetched:',
        requests.map((x) => x.url)
    );
});

test.describe('24hs limit', () => {
    test('should maintain DappFence protection within 24 hour window despite cache expiration', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app',
            appVersion: 'latest',
            saveResponses: true,
            responseHeaders: [
                {
                    match: '*dappfence.js',
                    headers: {
                        'Cache-Control': 'max-age=3600000', // 1000 hours
                    },
                },
                {
                    match: '*',
                    headers: {
                        'Cache-Control': 'max-age=36000', // 10 hours
                    },
                },
            ],
        });

        await page.goto('');
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation(page);

        await swHelper.interceptAndModifyPageContent('**/dappfence.js', 'replace', 'null.js');

        await swHelper.setFakeTime(`+9h`);

        // The null.js file that replaces dappfence.js is not loaded yet, everything comes from the cache.
        await page.reload();
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');

        // Dappfence is still active and protecting us, cache expired
        await swHelper.setFakeTime(`+23.9h`);
        await page.reload();
        await page.waitForURL(/.*\/sw-api/);
    });

    test('should lose DappFence protection after 24 hour threshold when compromised script is served', async ({
        page,
        swHelper,
    }) => {
        await swHelper.setServerTestParameters({
            appName: 'simple-app',
            appVersion: 'latest',
            saveResponses: true,
            responseHeaders: [
                {
                    match: '*dappfence.js',
                    headers: {
                        'Cache-Control': 'max-age=3600000', // 1000 hours
                    },
                },
                {
                    match: '*',
                    headers: {
                        'Cache-Control': 'max-age=108000', // 30 hours
                    },
                },
            ],
        });

        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation(page);

        await swHelper.interceptAndModifyPageContent('**/dappfence.js', 'replace', 'null.js');

        await swHelper.setFakeTime(`+9h`);

        // The null.js file that replaces dappfence.js is not loaded yet, everything comes from the cache.
        await page.reload();
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        // after 25hs automatic reload loads `null.js`
        await swHelper.setFakeTime(`+25h`);
        await page.reload();
        await page.waitForURL('/');
        await page.waitForTimeout(500);
        await page.reload();
        await page.waitForURL('/');

        // Now when we reload, we are not protected anymore
        await swHelper.interceptAndModifyPageContent('**/jquery-3.7.1.min.js');
        await swHelper.setFakeTime(`+31h x600`);
        await page.reload();
        await page.waitForURL('/');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        // Check that null.js is loaded
        await new Promise<void>((resolve) => {
            const listener = (msg) => {
                if (msg.text().includes('NULL')) {
                    page.off('console', listener);
                    resolve();
                }
            };
            page.on('console', listener);
        });
    });
});
