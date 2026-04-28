/**
 * Manifest Service
 * Handles manifest loading, storage, and file verification.
 */

import { calculateHash } from '../../core/crypto.js';
import { MODE } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest } from '../../core/utils.js';
import {
    getFileKey,
    identifyAppFromFile,
    normalizeManifestData,
    verifyFileHash,
    verifyManifestSignature,
} from './operations.js';
import {
    ASSET_TYPE,
    createSyntheticAppVersion,
    shouldVerifyAsset,
    VERIFICATION_STATUS,
} from './verification-helpers.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config - Manifest config (manifestUrl, manifestSignatureType, manifestSignatureIdentity)
 */
export const createManifestService = ({ swContext, appStore, config }) => {
    const { appVersionStore, trustedManifestStore, verificationResultsStore } = appStore;

    const singleFlight = createSingleFlight();

    const getAppVersion = async () => {
        return await appVersionStore.get();
    };

    const setAppVersion = async (version) => {
        await appVersionStore.set(version);
        logger.log(`App version set: ${version}`);
    };

    const loadManifestFromUrl = async () => {
        const { manifestUrl, manifestSignatureType, manifestSignatureIdentity } = config;
        logger.log(`Loading manifest from ${manifestUrl}`);
        try {
            const response = await swContext.fetch(manifestUrl, {
                cache: 'no-cache',
                headers: { 'x-dappfence': 'manifest-load' },
            });

            if (!response.ok) {
                logger.error(
                    `Failed to load manifest: ${response?.status} ${response?.statusText}`
                );
                return {
                    status: VERIFICATION_STATUS.ERROR,
                    fileKey: getFileKey(manifestUrl, swContext.getLocationHref()),
                    url: manifestUrl,
                    actualHash: 'N/A',
                    expectedHash: 'N/A',
                };
            }

            const json = await response.json();
            const signatureResult = verifyManifestSignature(
                manifestSignatureType,
                manifestSignatureIdentity,
                json
            );
            if (signatureResult.status !== VERIFICATION_STATUS.MATCH) {
                return {
                    ...signatureResult,
                    assetType: ASSET_TYPE.MANIFEST,
                    fileKey: getFileKey(manifestUrl, swContext.getLocationHref()),
                    url: manifestUrl,
                    actualHash: signatureResult.actualHash || 'N/A',
                    expectedHash: signatureResult.expectedHash || 'ERROR',
                };
            }

            const manifest = normalizeManifestData(signatureResult.payload);
            logger.log(`Loaded manifest with ${Object.keys(manifest.files).length} entries`);
            const appVersion = await setTrustedManifestFromData(manifest);
            return { status: VERIFICATION_STATUS.MATCH, manifest, appVersion };
        } catch (error) {
            logger.error('Error loading manifest:', error);
        }
        return {
            status: VERIFICATION_STATUS.ERROR,
            fileKey: getFileKey(manifestUrl, swContext.getLocationHref()),
            url: manifestUrl,
            actualHash: 'N/A',
            expectedHash: 'N/A',
        };
    };

    const fetchAndStoreManifest = () => singleFlight(loadManifestFromUrl);

    const initializeManifest = async () => {
        logger.log('Initialize manifest with config:', config);
        if (!hasConfigManifest(config)) {
            throw new Error('CRITICAL FAILURE: invalid manifest config');
        }
        logger.log('Loading predefined manifest...');
        const violationOrManifest = await fetchAndStoreManifest();
        if (violationOrManifest.status === VERIFICATION_STATUS.MATCH) {
            logger.log(
                `Manifest loaded, app version: ${violationOrManifest.appVersion.substring(0, 12)}...`
            );
        }
        return violationOrManifest;
    };

    const setTrustedManifestFromData = async (manifestData) => {
        let appVersion = await getAppVersion();

        if (!appVersion) {
            appVersion = await createSyntheticAppVersion(manifestData, calculateHash);
            await setAppVersion(appVersion);
            logger.log(`Created synthetic app version: ${appVersion}`);
        }

        await trustedManifestStore.set(appVersion, manifestData);
        logger.log(
            `Set trusted manifest for ${appVersion.substring(0, 12)}... (${Object.keys(manifestData.files).length} files)`
        );

        return appVersion;
    };

    const tryIdentifyApp = async (fileKey, fileHash) => {
        if (hasConfigManifest(config)) {
            logger.log('tryIdentifyApp, Skipping identification - config manifest provided');
            return null;
        }

        logger.log(`tryIdentifyApp, Identifying app from file: ${fileKey}, hash ${fileHash}`);
        return await identifyAppFromFile(trustedManifestStore, fileKey, fileHash);
    };

    /**
     * Verify a file against a (possibly pre-resolved) manifest. When
     * `manifest` is undefined, runs the cold-start path: identify the app
     * from a stored manifest by file hash, or fetch a fresh one. Once a
     * manifest is in hand, hashes the content and checks against it; on
     * mismatch, refetches once in case an in-flight manifest update has
     * landed (skipped if we just fetched a fresh manifest above).
     */

    const verifyFileWithContext = async ({ appVersion, manifest }, url, isNavigation, content) => {
        const fileKey = getFileKey(url, swContext.getLocationHref());
        const fileHash = await calculateHash(new TextEncoder().encode(content));
        logger.log(`Verifying file: ${fileKey} (${fileHash.substring(0, 12)}...)`);

        let freshlyFetched = false;
        if (!manifest) {
            appVersion = await tryIdentifyApp(fileKey, fileHash);
            if (appVersion) {
                await setAppVersion(appVersion);
                manifest = await trustedManifestStore.get(appVersion);
                logger.log(`Identified existing app from file: ${appVersion}`);
            } else {
                const violationOrManifest = await fetchAndStoreManifest();
                if (violationOrManifest.status !== VERIFICATION_STATUS.MATCH) {
                    return violationOrManifest;
                }
                appVersion = violationOrManifest.appVersion;
                manifest = violationOrManifest.manifest;
                freshlyFetched = true;
            }
        }

        let result = verifyFileHash(manifest, fileKey, fileHash);
        if (result.status !== VERIFICATION_STATUS.MATCH && !freshlyFetched) {
            logger.log(`Verification failed for ${fileKey} - ${result.status}, refetching`);
            const violationOrManifest = await fetchAndStoreManifest();
            if (violationOrManifest.status !== VERIFICATION_STATUS.MATCH) {
                return violationOrManifest;
            }
            result = verifyFileHash(violationOrManifest.manifest, fileKey, fileHash);
        }
        await verificationResultsStore.add(appVersion, result);

        const icon = fileKey.startsWith('/') ? '📄' : '🌐';
        const statusIcon = result.status === VERIFICATION_STATUS.MATCH ? '✅' : '❌';
        logger.log(`${statusIcon} ${icon} ${result.status}: ${fileKey}`);
        return result;
    };

    /**
     * Resolve the manifest context for a single request/operation.
     * Loads the current trusted manifest once and returns a view with
     * `mode`, `shouldVerify`, and `verifyFile` so downstream consumers
     * don't each re-read IndexedDB.
     *
     * `clientId` and `isNavigation` are accepted for forward compatibility
     * with per-client manifest pinning — the current implementation still
     * resolves the global manifest. Pass `{}` (or nothing) for operations
     * outside the fetch pipeline such as importScripts.
     */
    // eslint-disable-next-line no-unused-vars
    const resolveManifest = async ({ clientId, isNavigation } = {}) => {
        // TODO: We will use the latest manifest for the configuration, but for the files we keep a list of manifests
        // TODO: that we search by hash first.
        const appVersion = await appVersionStore.get();
        const latestManifest = appVersion ? await trustedManifestStore.get(appVersion) : undefined;

        return {
            // TODO: read mode from manifest.policy once that field is defined.
            mode: MODE.PROTECTED,
            shouldVerify: (url) => shouldVerifyAsset(url, isNavigation, latestManifest),
            verifyFile: (url, content) =>
                verifyFileWithContext(
                    { appVersion, manifest: latestManifest },
                    url,
                    isNavigation,
                    content
                ),
        };
    };

    return {
        initializeManifest,
        resolveManifest,
    };
};
