import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApiHandler } from '../api-handler.js';

vi.mock('../../templates/security-warning.html?raw', () => ({
    default:
        '<html><!-- API_TOKEN_PLACEHOLDER --><style>/* CSS will be injected here during build */</style><script>/* JavaScript values will be injected here during build */</script></html>',
}));
vi.mock('../../templates/security-warning.css?raw', () => ({
    default: 'body { color: red; }',
}));
vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn(() => false),
}));

const TOKEN = 'test-token-123';

function createMockAppStore() {
    return {
        apiTokenStore: {
            getApiToken: vi.fn().mockResolvedValue(TOKEN),
        },
        activeBlocksStore: {
            isBlocked: vi.fn().mockResolvedValue(false),
            getActiveBlocks: vi.fn().mockResolvedValue([]),
            getAllBlocks: vi.fn().mockResolvedValue([]),
            clearBlockCondition: vi.fn().mockResolvedValue(undefined),
        },
        appVersionStore: {
            get: vi.fn().mockResolvedValue('v1'),
        },
        trustedManifestStore: {
            get: vi.fn().mockResolvedValue({ files: { '/app.js': 'hash1' } }),
        },
        verificationResultsStore: {
            get: vi.fn().mockResolvedValue([{ file: '/app.js', status: 'match' }]),
        },
    };
}

function req(pathname, { method = 'GET', token, mode } = {}) {
    const url = `https://example.com${pathname}`;
    const headers = {};
    if (token) headers['X-DappFence-Token'] = token;
    const r = new Request(url, { method, headers });
    // Request.mode = 'navigate' cannot be set via init (spec forbids it), so we
    // override the property for tests that need to simulate a real navigation.
    if (mode) Object.defineProperty(r, 'mode', { value: mode, configurable: true });
    return r;
}

describe('createApiHandler', () => {
    let handler;
    let appStore;
    let onSecurityViolation;

    beforeEach(() => {
        appStore = createMockAppStore();
        onSecurityViolation = vi.fn();
        handler = createApiHandler({ onSecurityViolation, appStore });
    });

    describe('authentication', () => {
        it('falls through (undefined) for protected endpoints without token', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST' })
            );
            expect(res).toBeUndefined();
        });

        it('falls through (undefined) for protected endpoints with wrong token', async () => {
            const res = await handler(
                '/sw-api/active-blocks',
                req('/sw-api/active-blocks', { token: 'wrong' })
            );
            expect(res).toBeUndefined();
        });

        it('accepts token via header', async () => {
            const res = await handler(
                '/sw-api/active-blocks',
                req('/sw-api/active-blocks', { token: TOKEN })
            );
            expect(res.status).toBe(200);
        });

        it('accepts token via query param', async () => {
            const res = await handler(
                '/sw-api/active-blocks',
                new Request(`https://example.com/sw-api/active-blocks?token=${TOKEN}`)
            );
            expect(res.status).toBe(200);
        });

        it('does not require auth for /sw-api/status', async () => {
            const res = await handler('/sw-api/status', req('/sw-api/status'));
            expect(res.status).toBe(200);
        });

        it('does not require auth for /sw-api/security-warning on navigation', async () => {
            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            // No active block → 302 home redirect; auth is not checked
            expect(res.status).toBe(302);
        });
    });

    describe('GET /sw-api/status', () => {
        it('returns status JSON with manifest stats', async () => {
            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(res.headers.get('Content-Type')).toBe('application/json');
            expect(body.appVersion).toBe('v1');
            expect(body.stats.trustedFiles).toBe(1);
            expect(body.stats.totalVerifications).toBe(1);
            expect(body.stats.totalBlocks).toBe(0);
            expect(body.stats.activeBlocks).toBe(0);
            expect(body.blockHistory).toEqual([]);
        });

        it('returns empty manifest when no app version', async () => {
            // The real stores return empty defaults for a missing appVersion;
            // mirror that in the mocks since we removed the caller-side ternary.
            appStore.appVersionStore.get.mockResolvedValue(null);
            appStore.trustedManifestStore.get.mockResolvedValue({ files: {} });
            appStore.verificationResultsStore.get.mockResolvedValue([]);

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(body.appVersion).toBeNull();
            expect(body.stats.trustedFiles).toBe(0);
            expect(body.stats.totalVerifications).toBe(0);
        });

        it('returns the full verification-results log (no cap)', async () => {
            const results = Array.from({ length: 30 }, (_, i) => ({ id: i }));
            appStore.verificationResultsStore.get.mockResolvedValue(results);

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(body.verificationResults).toHaveLength(30);
            expect(body.stats.totalVerifications).toBe(30);
        });

        it('includes blockHistory and counts active vs total blocks', async () => {
            appStore.activeBlocksStore.getAllBlocks.mockResolvedValue([
                { id: 'block_a', fileKey: '/a.js', active: true, occurrenceCount: 2 },
                { id: 'block_b', fileKey: '/b.js', active: false, occurrenceCount: 5 },
                { id: 'block_c', fileKey: '/c.js', active: true, occurrenceCount: 1 },
            ]);

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            const body = await res.json();

            expect(body.blockHistory).toHaveLength(3);
            expect(body.stats.totalBlocks).toBe(3);
            expect(body.stats.activeBlocks).toBe(2);
        });
    });

    describe('GET /sw-api/security-warning', () => {
        it('falls through (undefined) when accessed without navigate mode', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);

            const res = await handler('/sw-api/security-warning', req('/sw-api/security-warning'));
            expect(res).toBeUndefined();
            expect(onSecurityViolation).not.toHaveBeenCalled();
        });

        it('redirects to / when there are no active blocks', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(false);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );
            expect(res.status).toBe(302);
            expect(res.headers.get('Location')).toBe('/');
            expect(onSecurityViolation).not.toHaveBeenCalled();
        });

        it('renders the security page and broadcasts when blocked', async () => {
            appStore.activeBlocksStore.isBlocked.mockResolvedValue(true);

            const res = await handler(
                '/sw-api/security-warning',
                req('/sw-api/security-warning', { mode: 'navigate' })
            );

            expect(res.status).toBe(200);
            expect(res.headers.get('Content-Type')).toContain('text/html');
            expect(onSecurityViolation).toHaveBeenCalledWith();
            expect(onSecurityViolation).toHaveBeenCalledTimes(1);

            const html = await res.text();
            expect(html).toContain(`content="${TOKEN}"`);
            expect(html).toContain('body { color: red; }');
        });
    });

    describe('GET /sw-api/active-blocks', () => {
        it('returns an empty array when no blocks', async () => {
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([]);

            const res = await handler(
                '/sw-api/active-blocks',
                req('/sw-api/active-blocks', { token: TOKEN })
            );
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual([]);
        });

        it('returns block records with public fields', async () => {
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([
                {
                    id: 'block_abc',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    lastSeen: '2025-01-02T00:00:00.000Z',
                    status: 'MISMATCH',
                    fileKey: '/app.js',
                    url: 'https://example.com/app.js',
                    expectedHash: 'aaa',
                    actualHash: 'bbb',
                    occurrenceCount: 3,
                },
            ]);

            const res = await handler(
                '/sw-api/active-blocks',
                req('/sw-api/active-blocks', { token: TOKEN })
            );
            const body = await res.json();

            expect(body).toHaveLength(1);
            expect(body[0]).toMatchObject({
                id: 'block_abc',
                fileKey: '/app.js',
                occurrenceCount: 3,
                expectedHash: 'aaa',
                actualHash: 'bbb',
            });
            expect(body[0].formattedTimestamp).toBeDefined();
        });

        it('defaults missing optional fields', async () => {
            appStore.activeBlocksStore.getActiveBlocks.mockResolvedValue([
                {
                    id: 'block_xyz',
                    timestamp: '2025-01-01T00:00:00.000Z',
                    status: 'NEW_FILE',
                    fileKey: '/new.js',
                    url: 'https://example.com/new.js',
                },
            ]);

            const res = await handler(
                '/sw-api/active-blocks',
                req('/sw-api/active-blocks', { token: TOKEN })
            );
            const body = await res.json();

            expect(body[0].expectedHash).toBe('N/A');
            expect(body[0].actualHash).toBe('N/A');
            expect(body[0].occurrenceCount).toBe(1);
        });
    });

    describe('POST /sw-api/site-unblock', () => {
        it('clears the block condition and returns success', async () => {
            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST', token: TOKEN })
            );
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(appStore.activeBlocksStore.clearBlockCondition).toHaveBeenCalledTimes(1);
        });

        it('returns a plain-text 500 when clearBlockCondition throws', async () => {
            appStore.activeBlocksStore.clearBlockCondition.mockRejectedValue(new Error('DB error'));

            const res = await handler(
                '/sw-api/site-unblock',
                req('/sw-api/site-unblock', { method: 'POST', token: TOKEN })
            );

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('Internal server error');
        });
    });

    describe('unknown endpoint', () => {
        it('falls through (undefined) so the network returns its own 404', async () => {
            const res = await handler('/sw-api/nope', req('/sw-api/nope', { token: TOKEN }));
            expect(res).toBeUndefined();
        });
    });

    describe('outer error handling', () => {
        it('returns 500 when an unexpected error occurs', async () => {
            appStore.appVersionStore.get.mockRejectedValue(new Error('unexpected'));

            const res = await handler('/sw-api/status', req('/sw-api/status'));
            expect(res.status).toBe(500);
            expect(await res.text()).toBe('Internal server error');
        });
    });
});
