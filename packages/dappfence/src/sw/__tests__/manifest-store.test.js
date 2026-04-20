import { describe, it, expect, beforeEach } from 'vitest';
import { createManifestStore } from '../storage/manifest-store.js';

function createInMemoryStorage() {
    const store = new Map();
    return {
        get: async (key) => store.get(key),
        set: async (key, value) => store.set(key, value),
        delete: async (key) => store.delete(key),
    };
}

describe('createManifestStore', () => {
    let storage;

    beforeEach(() => {
        storage = createManifestStore(createInMemoryStorage());
    });

    describe('appVersion', () => {
        it('returns undefined when no version is set', async () => {
            const version = await storage.appVersionStore.get();
            expect(version).toBeUndefined();
        });

        it('stores and retrieves an app version', async () => {
            await storage.appVersionStore.set('v1.0');
            const version = await storage.appVersionStore.get();
            expect(version).toBe('v1.0');
        });

        it('sets session version on first set, keeps it on subsequent sets', async () => {
            await storage.appVersionStore.set('v1.0');
            // Session version is now v1.0 — subsequent set should not overwrite it
            await storage.appVersionStore.set('v2.0');

            // get() prefers session version
            const version = await storage.appVersionStore.get();
            expect(version).toBe('v1.0');
        });

        it('returns app version after session is cleared', async () => {
            await storage.appVersionStore.set('v1.0');
            await storage.appVersionStore.set('v2.0');
            await storage.appVersionStore.clearSession();

            const version = await storage.appVersionStore.get();
            expect(version).toBe('v2.0');
        });
    });

    describe('config', () => {
        it('returns default config when nothing is stored', async () => {
            const config = await storage.configStore.get();
            expect(config).toEqual({
                includeExternalDomains: true,
                allowedExternalDomains: [],
                blockedExternalDomains: [],
            });
        });

        it('merges stored config with defaults', async () => {
            await storage.configStore.set({ includeExternalDomains: false });
            const config = await storage.configStore.get();
            expect(config).toEqual({
                includeExternalDomains: false,
                allowedExternalDomains: [],
                blockedExternalDomains: [],
            });
        });

        it('stores and retrieves custom config fields', async () => {
            await storage.configStore.set({
                includeExternalDomains: true,
                allowedExternalDomains: ['cdn.example.com'],
                blockedExternalDomains: ['evil.com'],
            });
            const config = await storage.configStore.get();
            expect(config.allowedExternalDomains).toEqual(['cdn.example.com']);
            expect(config.blockedExternalDomains).toEqual(['evil.com']);
        });
    });

    describe('trustedManifest', () => {
        it('returns empty manifest for unknown version', async () => {
            const manifest = await storage.trustedManifestStore.get('unknown');
            expect(manifest).toEqual({ files: {} });
        });

        it('stores and retrieves a manifest by version', async () => {
            const manifestData = { files: { '/app.js': 'abc123', '/style.css': 'def456' } };
            await storage.trustedManifestStore.set('v1', manifestData);

            const manifest = await storage.trustedManifestStore.get('v1');
            expect(manifest.files).toEqual({ '/app.js': 'abc123', '/style.css': 'def456' });
        });

        it('keeps manifests isolated by version', async () => {
            await storage.trustedManifestStore.set('v1', {
                files: { '/app.js': 'hash-v1' },
            });
            await storage.trustedManifestStore.set('v2', {
                files: { '/app.js': 'hash-v2' },
            });

            const v1 = await storage.trustedManifestStore.get('v1');
            const v2 = await storage.trustedManifestStore.get('v2');
            expect(v1.files['/app.js']).toBe('hash-v1');
            expect(v2.files['/app.js']).toBe('hash-v2');
        });

        it('getAllVersions returns stored version keys', async () => {
            await storage.trustedManifestStore.set('v1', { files: { '/a.js': 'x' } });
            await storage.trustedManifestStore.set('v2', { files: { '/b.js': 'y' } });

            const versions = await storage.trustedManifestStore.getAllVersions();
            expect(versions).toEqual(['v1', 'v2']);
        });

        it('getAll returns all manifests keyed by version', async () => {
            await storage.trustedManifestStore.set('v1', { files: { '/a.js': 'x' } });
            await storage.trustedManifestStore.set('v2', { files: { '/b.js': 'y' } });

            const all = await storage.trustedManifestStore.getAll();
            expect(Object.keys(all)).toEqual(['v1', 'v2']);
            expect(all['v1'].files).toEqual({ '/a.js': 'x' });
            expect(all['v2'].files).toEqual({ '/b.js': 'y' });
        });

        it('overwrites manifest for an existing version', async () => {
            await storage.trustedManifestStore.set('v1', { files: { '/a.js': 'old' } });
            await storage.trustedManifestStore.set('v1', { files: { '/a.js': 'new' } });

            const manifest = await storage.trustedManifestStore.get('v1');
            expect(manifest.files['/a.js']).toBe('new');
        });
    });

    describe('verificationResults', () => {
        it('returns empty array for unknown version', async () => {
            const results = await storage.verificationResultsStore.get('unknown');
            expect(results).toEqual([]);
        });

        it('adds and retrieves verification results', async () => {
            const result = { status: 'MATCH', fileKey: '/app.js' };
            await storage.verificationResultsStore.add('v1', result);

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toEqual([result]);
        });

        it('appends multiple results for same version', async () => {
            await storage.verificationResultsStore.add('v1', {
                status: 'MATCH',
                fileKey: '/a.js',
            });
            await storage.verificationResultsStore.add('v1', {
                status: 'MISMATCH',
                fileKey: '/b.js',
            });

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toHaveLength(2);
            expect(results[0].fileKey).toBe('/a.js');
            expect(results[1].fileKey).toBe('/b.js');
        });

        it('keeps results isolated by version', async () => {
            await storage.verificationResultsStore.add('v1', { fileKey: '/a.js' });
            await storage.verificationResultsStore.add('v2', { fileKey: '/b.js' });

            expect(await storage.verificationResultsStore.get('v1')).toHaveLength(1);
            expect(await storage.verificationResultsStore.get('v2')).toHaveLength(1);
        });

        it('caps results at 100 per version', async () => {
            for (let i = 0; i < 110; i++) {
                await storage.verificationResultsStore.add('v1', { index: i });
            }

            const results = await storage.verificationResultsStore.get('v1');
            expect(results).toHaveLength(100);
            // Should keep the last 100 (indices 10-109)
            expect(results[0].index).toBe(10);
            expect(results[99].index).toBe(109);
        });
    });
});
