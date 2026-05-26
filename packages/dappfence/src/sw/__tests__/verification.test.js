import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    verifyFilePath,
    toPathname,
    resolveManifestKey,
    verifyManifestSignature,
    verifyImportedScript,
    verifyLocation,
} from '../manifest/verification.js';
import { normalizeManifestData } from '../storage/manifest-store.js';
import { createSingleFlight } from '../../core/utils.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

// ── verifyFilePath ────────────────────────────────────────────────────────────

describe('verifyFilePath', () => {
    const manifest = {
        files: {
            '/app.js': 'abc123',
            '/style.css': 'def456',
            '/index.html': 'idx111',
            '/docs/index.html': 'idx222',
            '/about.html': 'about111',
            '/.netlify/scripts/cdp': 'cdp111',
            '/api/config.json': 'cfg111',
            '/legacy/index.htm': 'htm111',
        },
    };

    it('returns MATCH when fileKey is registered and the hash matches', () => {
        const result = verifyFilePath(manifest, '/app.js', 'abc123');
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/app.js');
        expect(result.expectedHash).toBe('abc123');
        expect(result.actualHash).toBe('abc123');
    });

    it('returns MISMATCH when fileKey is registered but hash differs', () => {
        const result = verifyFilePath(manifest, '/app.js', 'wrong');
        expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
        expect(result.actualHash).toBe('wrong');
    });

    it('returns NOT_FOUND_IN_MANIFEST for an unregistered fileKey', () => {
        const result = verifyFilePath(manifest, '/unknown.js', 'def456');
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
        expect(result.expectedHash).toBeUndefined();
    });

    it('does not match by hash value alone (content under a different key is NOT_FOUND)', () => {
        const result = verifyFilePath(manifest, '/any-path', 'def456');
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('returns NOT_FOUND for extensionless path not explicitly in files (no remapping)', () => {
        const result = verifyFilePath(manifest, '/docs', 'idx222');
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('does not remap paths — direct lookup only', () => {
        const result = verifyFilePath(manifest, '/', 'idx111');
        expect(result.status).toBe(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST);
    });

    it('returns MATCH when hash is in an array of known hashes', () => {
        const m = { files: { '/lib.js': ['hash-a', 'hash-b'] } };
        expect(verifyFilePath(m, '/lib.js', 'hash-b').status).toBe(VERIFICATION_STATUS.MATCH);
    });

    it('returns MISMATCH when hash is not in the array of known hashes', () => {
        const m = { files: { '/lib.js': ['hash-a', 'hash-b'] } };
        expect(verifyFilePath(m, '/lib.js', 'hash-c').status).toBe(VERIFICATION_STATUS.MISMATCH);
    });

    it('matches extensionless key stored directly in files (e.g. CDN scripts)', () => {
        const m = { files: { '/.netlify/scripts/cdp': ['hash-v1', 'hash-v2'] } };
        const result = verifyFilePath(m, '/.netlify/scripts/cdp', 'hash-v2');
        expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
        expect(result.fileKey).toBe('/.netlify/scripts/cdp');
    });
});

// ── normalizeManifestData ─────────────────────────────────────────────────────

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
        expect(normalizeManifestData(42)).toEqual({ files: {} });
        expect(normalizeManifestData(undefined)).toEqual({ files: {} });
    });

    it('skips entries with no hash value', () => {
        const input = { files: { '/app.js': null, '/ok.js': 'hash' } };
        const result = normalizeManifestData(input);
        expect(result.files['/app.js']).toBeUndefined();
        expect(result.files['/ok.js']).toBe('hash');
    });

    it('handles enhanced format with array of hashes', () => {
        const input = { files: { '/lib.js': ['hash-a', 'hash-b'] } };
        const result = normalizeManifestData(input);
        expect(result.files['/lib.js']).toEqual(['hash-a', 'hash-b']);
    });

    it('skips entries with empty hash arrays', () => {
        const input = { files: { '/lib.js': [], '/ok.js': 'hash' } };
        const result = normalizeManifestData(input);
        expect(result.files['/lib.js']).toBeUndefined();
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

// ── toPathname ────────────────────────────────────────────────────────────────

describe('toPathname', () => {
    const baseUrl = 'https://example.com/dappfence.js';

    it('returns pathname for same-origin absolute URLs', () => {
        expect(toPathname('https://example.com/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns pathname for relative URLs', () => {
        expect(toPathname('/app.js', baseUrl)).toBe('/app.js');
    });

    it('returns full href for cross-origin URLs', () => {
        expect(toPathname('https://cdn.other.com/lib.js', baseUrl)).toBe(
            'https://cdn.other.com/lib.js'
        );
    });

    it('prepends / for bare relative paths', () => {
        expect(toPathname('app.js', 'not-a-valid-url')).toBe('/app.js');
    });

    it('returns absolute URL as-is on parse failure', () => {
        expect(toPathname('https://cdn.com/lib.js', 'bad-base')).toBe('https://cdn.com/lib.js');
    });
});

// ── resolveManifestKey ────────────────────────────────────────────────────────

describe('resolveManifestKey', () => {
    const base = 'https://example.com/dappfence.js';

    describe('no pathRules', () => {
        it('returns pathname for same-origin URL', () => {
            expect(resolveManifestKey('https://example.com/app.js', base)).toBe('/app.js');
        });

        it('returns full URL for cross-origin', () => {
            expect(resolveManifestKey('https://cdn.other.com/lib.js', base)).toBe(
                'https://cdn.other.com/lib.js'
            );
        });

        it('falls back to pathname when no rule matches', () => {
            const files = { '/about/index.html': 'h' };
            expect(resolveManifestKey('/about', base, [], files)).toBe('/about');
        });

        it('returns pathname for relative path', () => {
            expect(resolveManifestKey('/style.css', base)).toBe('/style.css');
        });
    });

    describe('directory-index rule', () => {
        const files = { '/index.html': 'h', '/docs/index.html': 'h', '/about/index.html': 'h' };
        const pathRules = [{ type: 'directory-index' }];

        it('resolves "/" to "/index.html"', () => {
            expect(resolveManifestKey('/', base, pathRules, files)).toBe('/index.html');
        });

        it('resolves "/docs/" to "/docs/index.html"', () => {
            expect(resolveManifestKey('/docs/', base, pathRules, files)).toBe('/docs/index.html');
        });

        it('resolves extensionless "/docs" to "/docs/index.html"', () => {
            expect(resolveManifestKey('/docs', base, pathRules, files)).toBe('/docs/index.html');
        });

        it('resolves "/about" to "/about/index.html"', () => {
            expect(resolveManifestKey('/about', base, pathRules, files)).toBe('/about/index.html');
        });

        it('does not remap paths that already have an extension', () => {
            expect(resolveManifestKey('/app.js', base, pathRules, files)).toBe('/app.js');
        });

        it('falls back to pathname when candidate not in files', () => {
            expect(resolveManifestKey('/missing', base, pathRules, files)).toBe('/missing');
        });

        it('never applies to cross-origin URLs', () => {
            expect(resolveManifestKey('https://cdn.com/lib.js', base, pathRules, files)).toBe(
                'https://cdn.com/lib.js'
            );
        });
    });

    describe('html-extension rule', () => {
        const files = { '/about.html': 'h', '/contact.html': 'h' };
        const pathRules = [{ type: 'html-extension' }];

        it('resolves "/about" to "/about.html"', () => {
            expect(resolveManifestKey('/about', base, pathRules, files)).toBe('/about.html');
        });

        it('does not remap paths with extension', () => {
            expect(resolveManifestKey('/app.js', base, pathRules, files)).toBe('/app.js');
        });

        it('does not remap trailing-slash paths', () => {
            expect(resolveManifestKey('/about/', base, pathRules, files)).toBe('/about/');
        });

        it('falls back to pathname when candidate not in files', () => {
            expect(resolveManifestKey('/missing', base, pathRules, files)).toBe('/missing');
        });
    });

    describe('match/resolveAs override', () => {
        const files = { '/campaigns/landing/index.html': 'h' };
        const pathRules = [{ match: '/landing', resolveAs: '/campaigns/landing/index.html' }];

        it('returns resolveAs for exact match', () => {
            expect(resolveManifestKey('/landing', base, pathRules, files)).toBe(
                '/campaigns/landing/index.html'
            );
        });

        it('falls through for non-matching paths', () => {
            expect(resolveManifestKey('/other', base, pathRules, files)).toBe('/other');
        });
    });

    describe('condition.urlFilter scoping', () => {
        const files = { '/docs/index.html': 'h' };
        const pathRules = [
            { condition: { urlFilter: '/docs/' }, type: 'directory-index' },
            { type: 'html-extension' },
        ];

        it('applies scoped rule only to matching prefix', () => {
            expect(resolveManifestKey('/docs/', base, pathRules, files)).toBe('/docs/index.html');
        });

        it('falls through to next rule when prefix does not match', () => {
            const files2 = { ...files, '/about.html': 'h2' };
            expect(resolveManifestKey('/about', base, pathRules, files2)).toBe('/about.html');
        });
    });
});

// ── verifyManifestSignature ───────────────────────────────────────────────────

describe('verifyManifestSignature', () => {
    it('returns UNSUPPORTED_SIGNATURE for unknown signature types', () => {
        const result = verifyManifestSignature('unknown-type', '0xABC', { pay: {}, sig: 'sig' });
        expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
    });
});

// ── verifyLocation ────────────────────────────────────────────────────────────

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

// ── verifyImportedScript ──────────────────────────────────────────────────────

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

// ── createSingleFlight ────────────────────────────────────────────────────────

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
