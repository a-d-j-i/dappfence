import { defineConfig, devices } from '@playwright/test';

const port = process.env.TEST_PORT ? parseInt(process.env.TEST_PORT) : 7777;

export default defineConfig({
    testDir: 'test',
    testMatch: '*.spec.ts',
    fullyParallel: false,
    retries: 0,
    reporter: 'list',
    use: {
        baseURL: `http://localhost:${port}`,
    },
    projects: [
        {
            name: 'extension',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    webServer: {
        command: 'node test/server.js',
        port,
        reuseExistingServer: !process.env.CI,
        env: { TEST_PORT: String(port) },
    },
});
