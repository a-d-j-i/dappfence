import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    verifyFilePath,
    normalizeManifestData,
    getFileKey,
    verifyManifestSignature,
    verifyImportedScript,
    verifyLocation,
} from '../manifest/operations.js';
import { createSingleFlight } from '../../core/utils.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

describe('verifyFilePath', () => {
    const manifest = {
        files: {
            '/app.js': 'abc123',
            '/style.css': 'def456',
            '/index.html': 'idx111',
            '/docs/index.html': 'idx222',
        },
    };

    it('returns MATCH when fileKey is registered and the hash matches', () => {
        const result = verifyFilePath(manifest, '/app.js', 'abc123', false);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/app.js');
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('abc123');
    });

    it('returns MISMATCH when fileKey is registered but hash differs', () => {
        const result = verifyFilePath(manifest, '/app.js', 'wrong', false);
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('wrong');
    });

    it('returns NOT_FOUND_IN_MANIFEST for an unregistered fileKey', () => {
        const result = verifyFilePath(manifest, '/unknown.js', 'def456', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
        expect(result.expectedHash).toBeUndefined();
    });

    it('does not match by hash value alone (content under a different key is NOT_FOUND)', () => {
        const result = verifyFilePath(manifest, '/any-path', 'def456', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('navigation: remaps "/" to "/index.html"', () => {
        const result = verifyFilePath(manifest, '/', 'idx111', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/index.html');
        expect(result.expectedHash).toBe('idx111');
    });

    it('navigation: remaps "/docs/" to "/docs/index.html"', () => {
        const result = verifyFilePath(manifest, '/docs/', 'idx222', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/docs/index.html');
    });

    it('navigation: remaps extensionless "/docs" to "/docs/index.html"', () => {
        const result = verifyFilePath(manifest, '/docs', 'idx222', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/docs/index.html');
    });

    it('non-navigation: does not remap "/"', () => {
        const result = verifyFilePath(manifest, '/', 'idx111', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });
});

describe('normalizeManifestData', () => {
    it('handles enhanced format with files section', () => {
        const input = {
            files: { '/app.js': 'abc123', '/style.css': 'def456' },
        };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
        expect(result.files['/style.css']).toBe('def456');
    });

    it('handles enhanced format with object entries', () => {
        const input = {
            files: { '/app.js': { hash: 'abc123' } },
        };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
    });

    it('handles legacy flat format with string values', () => {
        const input = { '/app.js': 'abc123' };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
    });

    it('handles legacy flat format with object entries', () => {
        const input = { '/app.js': { hash: 'abc123' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe('abc123');
    });

    it('preserves SRI hashes as-is (no encoding conversion)', () => {
        const sriHash = 'sha256-' + btoa('test');
        const input = { files: { '/app.js': sriHash } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBe(sriHash);
    });

    it('returns empty files for non-object input', () => {
        // Note: null passes typeof === 'object' so it throws — only test primitives
        expect(normalizeManifestData(42)).toEqual({ files: {} });
        expect(normalizeManifestData(undefined)).toEqual({ files: {} });
    });

    it('skips entries with no hash value', () => {
        const input = { files: { '/app.js': null, '/ok.js': 'hash' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBeUndefined();
        expect(result.files['/ok.js']).toBe('hash');
    });

    it('preserves top-level fields (mode, metadata, future fields) in enhanced format', () => {
        const input = {
            files: { '/app.js': 'abc' },
            mode: 'reporting',
            metadata: { extensions: ['.js', '.wasm'] },
            customField: { future: true },
        };
        const result = normalizeManifestData(input);
        expect(result.mode).toBe('reporting');
        expect(result.metadata).toEqual({ extensions: ['.js', '.wasm'] });
        expect(result.customField).toEqual({ future: true });
        expect(result.files['/app.js']).toBe('abc');
    });
});

describe('getFileKey', () => {
    const baseUrl = 'https://example.com/dappfence.js';

    it('returns pathname for same-origin URLs', () => {
        expect(getFileKey('https://example.com/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns pathname for relative URLs', () => {
        expect(getFileKey('/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns full href for cross-origin URLs', () => {
        expect(getFileKey('https://cdn.other.com/lib.js', baseUrl)).toBe(
            'https://cdn.other.com/lib.js'
        );
    });

    it('prepends / for bare relative paths', () => {
        // When URL parsing fails, falls back to prepending /
        expect(getFileKey('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('returns absolute URL as-is on parse failure', () => {
        expect(getFileKey('https://cdn.com/lib.js', 'bad-base')).toBe('https://cdn.com/lib.js');
    });
});

describe('verifyManifestSignature', () => {
    it('returns UNSUPPORTED_SIGNATURE for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
    });
});

const mockManifestService = (verifyFileMock) => ({
    resolveManifest: vi.fn().mockResolvedValue({ verifyFile: verifyFileMock }),
});

describe('verifyLocation', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('fetches the URL and returns the verifyFile result', async () => {
        const verifyFileResult = {
            status: 'MATCH',
            fileKey: '/lib.js',
            expectedHash: 'abc',
            actualHash: 'abc',
            timestamp: '2026-01-01T00:00:00.000Z',
        };
        const verifyFile = vi.fn().mockResolvedValue(verifyFileResult);
        const response = new Response('file content');
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue(response),
            },
            manifestService: mockManifestService(verifyFile),
        };

        const result = await verifyLocation(deps, '/lib.js');

        expect(deps.swContext.fetch).toHaveBeenCalledWith('/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(verifyFile).toHaveBeenCalledWith('/lib.js', response);
        expect(result).toEqual(verifyFileResult);
    });

    it('returns verifyFile-compatible error on fetch failure', async () => {
        const verifyFile = vi.fn();
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' }),
            },
            manifestService: mockManifestService(verifyFile),
        };

        const result = await verifyLocation(deps, '/missing.js');

        expect(verifyFile).not.toHaveBeenCalled();
        expect(result).toEqual({ status: VERIFICATION_STATUS.ERROR });
    });
});

describe('verifyImportedScript', () => {
    beforeEach(() => {
        globalThis.__FEATURES__ = { mark_request: true };
    });
    afterEach(() => {
        delete globalThis.__FEATURES__;
    });

    it('calls verifyFile with script URL and the fetched response', async () => {
        const verifyFile = vi.fn().mockResolvedValue({ status: 'MATCH' });
        const response = new Response('script content');
        const core = {
            manifestService: mockManifestService(verifyFile),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(response),
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.swContext.fetch).toHaveBeenCalledWith('https://example.com/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(verifyFile).toHaveBeenCalledWith('https://example.com/lib.js', response);
        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });

    it('records violation on mismatch', async () => {
        const verifyFile = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.MISMATCH,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyFile),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('bad content')),
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                assetType: 'service-worker',
                url: 'https://example.com/lib.js',
            })
        );
    });

    it('records violation on fetch failure', async () => {
        const verifyFile = vi.fn();
        const core = {
            manifestService: mockManifestService(verifyFile),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi
                    .fn()
                    .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
            },
        };

        await verifyImportedScript(core, 'https://example.com/missing.js');

        expect(verifyFile).not.toHaveBeenCalled();
        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.ERROR,
                assetType: 'service-worker',
                url: 'https://example.com/missing.js',
            })
        );
    });

    it('treats SKIPPED results as non-violations', async () => {
        const verifyFile = vi.fn().mockResolvedValue({
            status: VERIFICATION_STATUS.SKIPPED,
            fileKey: '/lib.js',
        });
        const core = {
            manifestService: mockManifestService(verifyFile),
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue(new Response('content')),
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });
});

describe('createSingleFlight', () => {
    it('returns the result of the function', async () => {
        const sf = createSingleFlight();
        const result = await sf(async () => 42);
        expect(result).toBe(42);
    });

    it('deduplicates concurrent calls', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const fn = () =>
            new Promise((resolve) => {
                callCount++;
                setTimeout(() => resolve('done'), 10);
            });

        const [a, b] = await Promise.all([sf(fn), sf(fn)]);
        expect(callCount).toBe(1);
        expect(a).toBe('done');
        expect(b).toBe('done');
    });

    it('allows a new call after the previous one completes', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const fn = async () => ++callCount;

        await sf(fn);
        await sf(fn);
        expect(callCount).toBe(2);
    });

    it('resets after rejection so the next call retries', async () => {
        const sf = createSingleFlight();
        let callCount = 0;
        const failOnce = async () => {
            callCount++;
            if (callCount === 1) {
                throw new Error('fail');
            }
            return 'ok';
        };

        await expect(sf(failOnce)).rejects.toThrow('fail');
        const result = await sf(failOnce);
        expect(result).toBe('ok');
        expect(callCount).toBe(2);
    });
});
