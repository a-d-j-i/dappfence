import { chromium, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { Protocol } from 'playwright-core/types/protocol';

/**
 * Navigate to the app and wait for the DappFence SW to be installed, activated,
 * and controlling the page with the manifest loaded. Takes two navigations:
 * the first registers the SW; the second loads under its control.
 */
async function waitForSWReady(page: Page) {
    await page.goto('/');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // Poll /sw-api/status until the manifest is loaded (trustedFiles > 0).
    await page.waitForFunction(async () => {
        try {
            const r = await fetch('/sw-api/status');
            const s = await r.json();
            return s.stats?.trustedFiles > 0;
        } catch {
            return false;
        }
    });
}

test.afterEach(async ({ page }) => {
    await page.request.delete('/api/test-config');
});

test('inject.js prepends dappfence.js script tag', async ({ page }) => {
    await page.goto('/');
    const src = await page.locator('script[src*="dappfence.js"]').first().getAttribute('src');
    expect(src).toBeTruthy();
});

test('service worker registers and controls the page', async ({ page }) => {
    await waitForSWReady(page);
    const swURL = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
    expect(swURL).toContain('dappfence.js');
});

test('/sw-api/status returns version and trusted file count', async ({ page }) => {
    await waitForSWReady(page);
    const status = await page.evaluate(async () => {
        const r = await fetch('/sw-api/status');
        return r.json();
    });
    expect(status.appVersion).toBeDefined();
    expect(typeof status.stats.trustedFiles).toBe('number');
    expect(status.stats.trustedFiles).toBeGreaterThan(0);
});

// Get the extension ID via CDP. Calling Runtime.enable causes Chrome to immediately
// re-emit executionContextCreated for every existing context, so this works on a page
// that has already loaded — no extra navigation or new page needed.
async function getExtensionId(page: Page): Promise<string> {
    const cdp = await page.context().newCDPSession(page);
    const idPromise = new Promise<string>((resolve) => {
        cdp.on('Runtime.executionContextCreated', ({ context: ctx }) => {
            if (ctx.origin?.startsWith('chrome-extension://')) {
                resolve(new URL(ctx.origin).hostname);
            }
        });
    });
    await cdp.send('Runtime.enable');
    return idPromise;
}

test('popup shows Inactive when active tab is not http', async ({ context, page }) => {
    await page.goto('/');
    const extensionId = await getExtensionId(page);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // Active tab is the popup itself (chrome-extension://), which fails the http check.
    await expect(popup.locator('#state-badge')).toHaveText('Inactive');
    await expect(popup.locator('#message')).toBeVisible();
    await popup.close();
});

test('popup shows Active with stats when pointing at SW-controlled page', async ({
    context,
    page,
    browser,
}) => {
    await waitForSWReady(page);
    // The background SW registers at browser launch, before test code runs, so
    // waitForEvent would miss it. Find it directly; fall back to waitForEvent
    // in case the browser is still starting up.
    const background = context
        .serviceWorkers()
        .find((x) => x.url().startsWith('chrome-extension://'));
    // Open the popup. Chrome sets the active tab correctly, so popup.js can query it.
    await background.evaluate(() => (globalThis as any).chrome.action.openPopup());
    // Why must we open it twice?
    const b2 = await chromium.connectOverCDP('http://localhost:9222');
    const popup = b2
        .contexts()[0]
        .pages()
        .find((x) => x.url().startsWith('chrome-extension://'));
    await expect(popup.locator('#state-badge')).toHaveText('Active');
    await expect(popup.locator('#details')).toBeVisible();
    await expect(popup.locator('#trusted-files')).not.toHaveText('—');
});

test('blocks navigation when app.js is tampered', async ({ page }) => {
    await waitForSWReady(page);

    // Tell the dev server to tamper with app.js responses (prepends "// modified\n").
    await page.request.post('/api/test-config', {
        data: {
            appName: 'app',
            appVersion: 'latest',
            intercept: { pattern: '**/app.js', formula: 'default' },
        },
    });

    // Navigate — SW fetches tampered app.js, detects hash mismatch, redirects to security page.
    await page.goto('/');
    await page.waitForURL(/\/sw-api\//);
});
