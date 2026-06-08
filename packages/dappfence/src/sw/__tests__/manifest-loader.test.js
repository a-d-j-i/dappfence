import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createManifestLoader } from '../manifest/manifest-loader.js';
import { VERIFICATION_STATUS, ASSET_TYPE } from '../../core/constants.js';

// Control verifyManifestSignature without real secp256k1 crypto.
vi.mock('../manifest/verification.js', () => ({
    toPathname: () => '/manifest.json',
    verifyManifestSignature: vi.fn(),
}));

import { verifyManifestSignature } from '../manifest/verification.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MANIFEST_URL = 'https://example.com/manifest.json';
const VALID_PAYLOAD = { files: { '/app.js': 'sha256-abc' }, mode: 'protected' };
const MANIFEST_INFO = { appVersion: 'v1', manifest: VALID_PAYLOAD };

function makeConfig(overrides = {}) {
    return {
        manifestUrl: MANIFEST_URL,
        manifestSignatureType: 'secp256k1',
        manifestSignatureIdentity: '0xABCDEF',
        ...overrides,
    };
}

function makeOkResponse(json) {
    return { ok: true, status: 200, json: () => Promise.resolve(json) };
}

function makeSwContext({
    fetchResult = makeOkResponse({ pay: VALID_PAYLOAD, sig: 'sig' }),
    clients = [],
} = {}) {
    return {
        getLocationHref: () => 'https://example.com/sw.js',
        fetch: vi.fn(() => Promise.resolve(fetchResult)),
        matchAllClients: vi.fn(() => Promise.resolve(clients)),
    };
}

function makeAppStore({ findByHashResult = null, addLatestResult = MANIFEST_INFO } = {}) {
    return {
        trustedManifestStore: {
            findByHash: vi.fn(() => Promise.resolve(findByHashResult)),
            addLatest: vi.fn(() => Promise.resolve(addLatestResult)),
        },
    };
}

function makeLoader({ config, swContext, appStore } = {}) {
    return createManifestLoader({
        config: config ?? makeConfig(),
        swContext: swContext ?? makeSwContext(),
        appStore: appStore ?? makeAppStore(),
    });
}

// ── fetchAndStoreManifest ─────────────────────────────────────────────────────

describe('fetchAndStoreManifest', () => {
    beforeEach(() => vi.clearAllMocks());

    describe('config validation', () => {
        it('returns CONFIG_ERROR when manifestUrl is missing', async () => {
            const result = await makeLoader({
                config: makeConfig({ manifestUrl: null }),
            }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
            expect(result.assetType).toBe(ASSET_TYPE.MANIFEST);
        });

        it('returns CONFIG_ERROR when manifestSignatureType is missing', async () => {
            const result = await makeLoader({
                config: makeConfig({ manifestSignatureType: null }),
            }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
        });

        it('returns CONFIG_ERROR when manifestSignatureIdentity is missing', async () => {
            const result = await makeLoader({
                config: makeConfig({ manifestSignatureIdentity: null }),
            }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.CONFIG_ERROR);
        });
    });

    describe('fetch errors', () => {
        it('returns ERROR with fileKey when response is not ok', async () => {
            const swContext = makeSwContext({
                fetchResult: { ok: false, status: 404, statusText: 'Not Found' },
            });
            const result = await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('returns ERROR with fileKey when response is null', async () => {
            const swContext = makeSwContext({ fetchResult: null });
            const result = await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('returns ERROR when fetch throws', async () => {
            const swContext = makeSwContext();
            swContext.fetch.mockRejectedValue(new Error('network error'));
            const result = await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('fetches with no-cache and dappfence header', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const swContext = makeSwContext();
            await makeLoader({ swContext }).fetchAndStoreManifest();
            expect(swContext.fetch).toHaveBeenCalledWith(
                MANIFEST_URL,
                expect.objectContaining({
                    cache: 'no-cache',
                    headers: expect.objectContaining({ 'x-dappfence': 'manifest-load' }),
                })
            );
        });
    });

    describe('signature verification', () => {
        it('returns violation enriched with assetType and fileKey when signature is a mismatch', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MISMATCH,
                expectedHash: 'addr-expected',
                actualHash: 'addr-got',
            });
            const result = await makeLoader().fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.MISMATCH);
            expect(result.assetType).toBe(ASSET_TYPE.MANIFEST);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('returns UNSUPPORTED_SIGNATURE violation with assetType and fileKey', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE,
            });
            const result = await makeLoader().fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE);
            expect(result.assetType).toBe(ASSET_TYPE.MANIFEST);
            expect(result.fileKey).toBe('/manifest.json');
        });

        it('stores manifest payload and returns MATCH on valid signature', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const appStore = makeAppStore({
                addLatestResult: { appVersion: 'v-ok', manifest: VALID_PAYLOAD },
            });
            const result = await makeLoader({ appStore }).fetchAndStoreManifest();
            expect(result.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(result.appVersion).toBe('v-ok');
            expect(result.manifest).toEqual(VALID_PAYLOAD);
            expect(appStore.trustedManifestStore.addLatest).toHaveBeenCalledWith(VALID_PAYLOAD);
        });
    });

    describe('single-flight deduplication', () => {
        it('issues only one fetch for concurrent calls', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const swContext = makeSwContext();
            const loader = makeLoader({ swContext });
            const [r1, r2] = await Promise.all([
                loader.fetchAndStoreManifest(),
                loader.fetchAndStoreManifest(),
            ]);
            expect(swContext.fetch).toHaveBeenCalledTimes(1);
            expect(r1.status).toBe(VERIFICATION_STATUS.MATCH);
            expect(r2.status).toBe(VERIFICATION_STATUS.MATCH);
        });

        it('issues a new fetch after the previous in-flight call settles', async () => {
            verifyManifestSignature.mockReturnValue({
                status: VERIFICATION_STATUS.MATCH,
                payload: VALID_PAYLOAD,
            });
            const swContext = makeSwContext();
            const loader = makeLoader({ swContext });
            await loader.fetchAndStoreManifest();
            await loader.fetchAndStoreManifest();
            expect(swContext.fetch).toHaveBeenCalledTimes(2);
        });
    });
});

// ── resolveManifestInfo ───────────────────────────────────────────────────────

describe('resolveManifestInfo', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        verifyManifestSignature.mockReturnValue({
            status: VERIFICATION_STATUS.MATCH,
            payload: VALID_PAYLOAD,
        });
    });

    describe('client pinning', () => {
        it('returns pinned manifest on subsequent non-navigation calls for same clientId', async () => {
            // Keep client-1 in the active list so pruneStaleClients does not evict it.
            const swContext = makeSwContext({ clients: [{ id: 'client-1' }] });
            const appStore = makeAppStore({ findByHashResult: MANIFEST_INFO });
            const loader = makeLoader({ swContext, appStore });
            await loader.resolveManifestInfo('hash-x', 'client-1', false);
            appStore.trustedManifestStore.findByHash.mockClear();

            const result = await loader.resolveManifestInfo('hash-x', 'client-1', false);
            expect(appStore.trustedManifestStore.findByHash).not.toHaveBeenCalled();
            expect(result).toEqual(MANIFEST_INFO);
        });

        it('bypasses pin for navigation requests', async () => {
            const swContext = makeSwContext({ clients: [{ id: 'client-1' }] });
            const appStore = makeAppStore({ findByHashResult: MANIFEST_INFO });
            const loader = makeLoader({ swContext, appStore });
            await loader.resolveManifestInfo('hash-x', 'client-1', false);
            appStore.trustedManifestStore.findByHash.mockClear();

            await loader.resolveManifestInfo('hash-x', 'client-1', true);
            expect(appStore.trustedManifestStore.findByHash).toHaveBeenCalled();
        });

        it('does not pin when clientId is falsy', async () => {
            const appStore = makeAppStore({ findByHashResult: MANIFEST_INFO });
            const loader = makeLoader({ appStore });
            await loader.resolveManifestInfo('hash-x', null, false);
            await loader.resolveManifestInfo('hash-x', null, false);
            expect(appStore.trustedManifestStore.findByHash).toHaveBeenCalledTimes(2);
        });
    });

    describe('manifest resolution', () => {
        it('returns findByHash result without fetching when hash is known', async () => {
            const swContext = makeSwContext();
            const appStore = makeAppStore({ findByHashResult: MANIFEST_INFO });
            const loader = makeLoader({ swContext, appStore });

            const result = await loader.resolveManifestInfo('known-hash', null, false);
            expect(swContext.fetch).not.toHaveBeenCalled();
            expect(result).toEqual(MANIFEST_INFO);
        });

        it('fetches manifest when findByHash returns null', async () => {
            const swContext = makeSwContext();
            const appStore = makeAppStore({
                findByHashResult: null,
                addLatestResult: { appVersion: 'v-fresh', manifest: VALID_PAYLOAD },
            });
            const loader = makeLoader({ swContext, appStore });

            const result = await loader.resolveManifestInfo('unknown-hash', null, false);
            expect(swContext.fetch).toHaveBeenCalled();
            expect(result.appVersion).toBe('v-fresh');
        });

        it('returns { violation } when manifest fetch fails', async () => {
            const swContext = makeSwContext({ fetchResult: { ok: false, status: 503 } });
            const appStore = makeAppStore({ findByHashResult: null });
            const loader = makeLoader({ swContext, appStore });

            const result = await loader.resolveManifestInfo('unknown-hash', null, false);
            expect(result.violation).toBeDefined();
            expect(result.violation.status).toBe(VERIFICATION_STATUS.ERROR);
        });

        it('returns { violation } when manifest has invalid signature', async () => {
            verifyManifestSignature.mockReturnValue({ status: VERIFICATION_STATUS.MISMATCH });
            const swContext = makeSwContext();
            const appStore = makeAppStore({ findByHashResult: null });
            const loader = makeLoader({ swContext, appStore });

            const result = await loader.resolveManifestInfo('unknown-hash', null, false);
            expect(result.violation).toBeDefined();
            expect(result.violation.status).toBe(VERIFICATION_STATUS.MISMATCH);
        });
    });

    describe('stale client pruning', () => {
        it('calls matchAllClients after pinning a client', async () => {
            const swContext = makeSwContext({ clients: [{ id: 'client-1' }] });
            const appStore = makeAppStore({ findByHashResult: MANIFEST_INFO });
            const loader = makeLoader({ swContext, appStore });

            await loader.resolveManifestInfo('hash-x', 'client-1', false);
            await new Promise((r) => setTimeout(r, 0));

            expect(swContext.matchAllClients).toHaveBeenCalled();
        });

        it('evicts pins for clients no longer in matchAllClients', async () => {
            const swContext = makeSwContext({ clients: [] }); // client-1 not active
            const appStore = makeAppStore({ findByHashResult: MANIFEST_INFO });
            const loader = makeLoader({ swContext, appStore });

            await loader.resolveManifestInfo('hash-x', 'client-1', false);
            await new Promise((r) => setTimeout(r, 0)); // let pruneStaleClients run

            appStore.trustedManifestStore.findByHash.mockClear();
            await loader.resolveManifestInfo('hash-x', 'client-1', false);
            expect(appStore.trustedManifestStore.findByHash).toHaveBeenCalled();
        });
    });
});
