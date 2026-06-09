/**
 * End-to-end tests for non-OK HTTP response verification.
 *
 * With SW active, the verifier now processes navigation responses regardless
 * of HTTP status code. Sub-resources with non-OK status are still skipped.
 */
import { expect, test } from '../sw-fixtures';

test.describe('non-OK response verification', () => {
    test.beforeEach(async ({ page, swHelper }, testInfo) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');

        const swCapture = testInfo.project.name.startsWith('simple-app-sw-capture');
        const serviceWorkers = await swHelper.waitForServiceWorkers(swCapture ? 2 : 1);
        if (swCapture) {
            await serviceWorkers[0].waitUntilClosed();
        }
        const url = await swHelper.waitForServiceWorkerActivation();
        if (swCapture || testInfo.project.name.startsWith('simple-app-sw-fixed')) {
            expect(url).toContain('appSW=sw_app.js');
        }
    });

    test('should block with hard message when known page has tampered body and non-OK status', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/',
            formula: 'default',
            statusCode: 404,
        });
        await page.goto('about:blank');
        await page.goto('');
        await page.waitForURL(/.*\/sw-api/);
        await expect(page.getByText('Security Warning')).toBeVisible();
    });

    test('should pass through when known page has correct body and non-OK status', async ({
        page,
        swHelper,
    }) => {
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/',
            formula: 'unchanged',
            statusCode: 404,
        });
        await page.goto('about:blank');
        await page.goto('');
        // SW verifies MATCH — passes the 404 response through without blocking
        await expect(page).not.toHaveURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('should skip and not block when a sub-resource script has a non-OK status', async ({
        page,
        swHelper,
    }, testInfo) => {
        test.skip(
            testInfo.project.name.startsWith('simple-app-sw-capture'),
            'app.js is not loaded by index.html in sw-capture variant'
        );
        await swHelper.interceptAndModifyPageContent({
            pattern: '**/app.js',
            formula: 'empty',
            statusCode: 404,
        });
        await page.goto('about:blank');
        await page.goto('');
        // Non-OK sub-resource is SKIPPED — page loads without triggering security block
        await expect(page).not.toHaveURL(/.*\/sw-api/);
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });
});
