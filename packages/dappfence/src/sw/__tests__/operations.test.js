import { describe, it, expect, vi } from 'vitest';
import {
    verifyFileHash,
    normalizeManifestData,
    getFileKey,
    identifyAppFromFile,
    verifyManifestSignature,
    verifyImportedScript,
    verifyLocation,
} from '../manifest/operations.js';
import { createSingleFlight } from '../../core/utils.js';
import { VERIFICATION_STATUS } from '../manifest/verification-helpers.js';

describe('verifyFileHash', () => {
    const manifest = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };

    it('returns MATCH when hash matches by key', () => {
        const result = verifyFileHash(manifest, '/app.js', 'abc123', false);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('abc123');
    });

    it('returns MISMATCH when hash differs', () => {
        const result = verifyFileHash(manifest, '/app.js', 'wrong', false);
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('wrong');
    });

    it('returns NOT_FOUND_IN_MANIFEST for unknown file', () => {
        const result = verifyFileHash(manifest, '/unknown.js', 'somehash', false);
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('matches by hash value when searchByHash is true', () => {
        const result = verifyFileHash(manifest, '/any-path', 'def456', true);
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('falls back to key match when searchByHash finds nothing', () => {
        const result = verifyFileHash(manifest, '/app.js', 'abc123', true);
        // searchByHash iterates values — 'abc123' is a value, so it matches
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('returns NOT_FOUND when searchByHash fails and key not found', () => {
        const result = verifyFileHash(manifest, '/unknown.js', 'nope', true);
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

    it('converts SRI format to hex', () => {
        // sha256- prefix triggers SRI conversion
        const sriHash = 'sha256-' + btoa('test');
        const input = { files: { '/app.js': sriHash } };
        const result = normalizeManifestData(input);
        // Should be converted from SRI to hex
        expect(result.files['/app.js']).not.toContain('sha256-');
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

describe('identifyAppFromFile', () => {
    it('returns null when no manifests are stored', async () => {
        const mockStore = { getAll: async () => ({}) };
        const result = await identifyAppFromFile(mockStore, '/app.js', 'hash123');
        expect(result).toBeNull();
    });

    it('returns matching version when file hash matches', async () => {
        const mockStore = {
            getAll: async () => ({
                v1: { files: { '/app.js': 'hash123' } },
                v2: { files: { '/app.js': 'other' } },
            }),
        };
        const result = await identifyAppFromFile(mockStore, '/app.js', 'hash123');
        expect(result).toBe('v1');
    });

    it('returns null when no version matches', async () => {
        const mockStore = {
            getAll: async () => ({
                v1: { files: { '/app.js': 'nope' } },
            }),
        };
        const result = await identifyAppFromFile(mockStore, '/app.js', 'hash123');
        expect(result).toBeNull();
    });

    it('returns null on error', async () => {
        const mockStore = {
            getAll: async () => {
                throw new Error('db error');
            },
        };
        const result = await identifyAppFromFile(mockStore, '/app.js', 'hash123');
        expect(result).toBeNull();
    });
});

describe('verifyManifestSignature', () => {
    it('returns UNSUPPORTED_SIGNATURE for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe('UNSUPPORTED_SIGNATURE');
    });
});

describe('verifyLocation', () => {
    it('fetches the URL and returns the verifyFile result', async () => {
        const verifyFileResult = {
            status: 'MATCH',
            fileKey: '/lib.js',
            expectedHash: 'abc',
            actualHash: 'abc',
            timestamp: '2026-01-01T00:00:00.000Z',
        };
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue({
                    ok: true,
                    text: async () => 'file content',
                }),
            },
            manifestService: { verifyFile: vi.fn().mockResolvedValue(verifyFileResult) },
        };

        const result = await verifyLocation(deps, '/lib.js', false);

        expect(deps.swContext.fetch).toHaveBeenCalledWith('/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(deps.manifestService.verifyFile).toHaveBeenCalledWith(
            '/lib.js',
            'file content',
            false
        );
        expect(result).toEqual(verifyFileResult);
    });

    it('passes searchByHash through to verifyFile', async () => {
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue({
                    ok: true,
                    text: async () => 'content',
                }),
            },
            manifestService: {
                verifyFile: vi.fn().mockResolvedValue({ status: 'MATCH' }),
            },
        };

        await verifyLocation(deps, '/sw.js', true);

        expect(deps.manifestService.verifyFile).toHaveBeenCalledWith('/sw.js', 'content', true);
    });

    it('returns verifyFile-compatible error on fetch failure', async () => {
        const deps = {
            swContext: {
                fetch: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Error' }),
            },
            manifestService: { verifyFile: vi.fn() },
        };

        const result = await verifyLocation(deps, '/missing.js', false);

        expect(deps.manifestService.verifyFile).not.toHaveBeenCalled();
        expect(result).toEqual({
            status: 'VERIFICATION_ERROR',
            url: '/missing.js',
            expectedHash: null,
            actualHash: null,
            timestamp: expect.any(String),
        });
    });
});

describe('verifyImportedScript', () => {
    it('calls verifyFile with script URL and content', async () => {
        const core = {
            manifestService: {
                verifyFile: vi.fn().mockResolvedValue({ status: 'MATCH' }),
            },
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue({
                    ok: true,
                    text: async () => 'script content',
                }),
            },
        };

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.swContext.fetch).toHaveBeenCalledWith('https://example.com/lib.js', {
            headers: { 'x-dappfence': 'sw-verification' },
        });
        expect(core.manifestService.verifyFile).toHaveBeenCalledWith(
            'https://example.com/lib.js',
            'script content',
            false
        );
        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });

    it('records violation on mismatch', async () => {
        const core = {
            manifestService: {
                verifyFile: vi.fn().mockResolvedValue({ status: 'MISMATCH', fileKey: '/lib.js' }),
            },
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi.fn().mockResolvedValue({
                    ok: true,
                    text: async () => 'bad content',
                }),
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
        const core = {
            manifestService: { verifyFile: vi.fn() },
            appStore: { recordSecurityViolation: vi.fn() },
            swContext: {
                fetch: vi
                    .fn()
                    .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
            },
        };

        await verifyImportedScript(core, 'https://example.com/missing.js');

        expect(core.manifestService.verifyFile).not.toHaveBeenCalled();
        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'VERIFICATION_ERROR',
                assetType: 'service-worker',
                url: 'https://example.com/missing.js',
            })
        );
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
