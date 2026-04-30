import { BrowserContext, chromium, test as base } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.join(here, '..', 'dist-test');

export const test = base.extend<{ context: BrowserContext }>({
    context: async ({}, use) => {
        // Extensions require a persistent context with headless: false (old headless strips extensions).
        // When DISPLAY is not set (CI/no X11), --headless=new is injected for Chrome 112+ headless extension support.
        const context = await chromium.launchPersistentContext('', {
            headless: false,
            args: [
                '--headless=new',
                '--remote-debugging-port=9222',
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
            ],
        });
        await use(context);
        await context.close();
    },
});

export { expect } from '@playwright/test';
