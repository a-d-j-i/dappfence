/**
 * End-to-end tests for the Service Worker functionality.
 */
import { expect, test } from '../sw-fixtures';

test('should return a not found page for missing assets', async ({ page }) => {
    await page.goto('/assets/not-exists.html');
    await expect(page.getByText('File not found')).toBeVisible();
    await page.reload();
    await expect(page.getByText('File not found')).toBeVisible();
});
