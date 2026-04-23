/**
 * End-to-end tests for the Service Worker functionality.
 */
import { expect, test } from '../sw-fixtures';

/*
 * The manifest file serves as the root of trust for the integrity verification system.
 * If it is compromised, the entire security model is invalidated, as the Service Worker
 * relies on the manifest to verify all other resources. Therefore, tampering with the
 * manifest is considered a fundamental breach that cannot be mitigated by the system itself.
 */
test('should block navigation when integrity-manifest.json is tampered', async ({
    page,
    swHelper,
}) => {
    await swHelper.interceptAndModifyPageContent('**/integrity-manifest.json');
    await page.goto('');
    await page.waitForURL(/.*\/sw-api/);

    // If the user ignores the error, we keep going.
    await page.getByRole('button', { name: 'Remove Site Lock' }).click();
    await expect(page).toHaveTitle('DappFence - Manifest Mode Example');
});

test('should block navigation when integrity-manifest.json is tampered and empty', async ({
    page,
    swHelper,
}) => {
    // if the manifest is not a valid json we will throw, we need to capture that.
    await swHelper.interceptAndModifyPageContent('**/integrity-manifest.json', 'empty');
    // We found a bug, so we have this test to confirm and avoid regresions
    await page.goto('');
    await page.waitForURL(/.*\/sw-api/);
});
