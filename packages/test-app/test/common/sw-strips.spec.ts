/**
 * End-to-end tests for manifest strip rules.
 *
 * Strip rules remove known CDN injections from file content before hashing so
 * the SW can verify pre-injection content recorded in the manifest. These tests
 * confirm that:
 *   - A valid CDN snippet is stripped → hash matches → page loads normally.
 *   - A CDN-like snippet with extra content is NOT stripped → hash mismatch → page is blocked.
 */
import { expect, test } from '../sw-fixtures';

test.describe('strip rules', () => {
    test.beforeEach(async ({ page, swHelper }) => {
        await page.goto('');
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
        await swHelper.waitForServiceWorkerActivation();
    });

    test('should not block when a valid CDN injection is stripped', async ({ page, swHelper }) => {
        // The manifest carries strips: ['netlify-cdp']. The SW strips the injected
        // snippet before hashing, so the hash still matches the manifest entry.
        await swHelper.interceptAndModifyPageContent('**/', 'cdn-inject');
        await page.reload();
        await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
    });

    test('should block when a CDN-like injection contains extra content', async ({
        page,
        swHelper,
    }) => {
        // The injected snippet has an extra <script> inside the div, so the strict
        // netlify-cdp pattern does not match, and the snippet is NOT stripped.
        // The resulting hash mismatch must trigger a security block.
        await swHelper.interceptAndModifyPageContent('**/', 'cdn-inject-malicious');
        await page.reload();
        await page.waitForURL(/.*\/sw-api/);
    });
});
