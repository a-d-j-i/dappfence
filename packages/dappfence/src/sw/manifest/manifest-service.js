/**
 * Manifest Service
 * Handles manifest loading, storage, and file verification.
 */

import { calculateHash } from '../../core/crypto.js';
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

    const verifyFile = async (url, content, searchByHash) => {
        const fileKey = getFileKey(url, swContext.getLocationHref());
        const fileHash = await calculateHash(new TextEncoder().encode(content));
        logger.log(`Verifying file: ${fileKey} (${fileHash.substring(0, 12)}...)`);

        let latestManifest;
        let appVersion = await getAppVersion();
        if (!appVersion) {
            appVersion = await tryIdentifyApp(fileKey, fileHash);

            if (appVersion) {
                await setAppVersion(appVersion);
                logger.log(`Identified existing app from file: ${appVersion}`);
            } else {
                const violationOrManifest = await fetchAndStoreManifest();
                if (violationOrManifest.status !== VERIFICATION_STATUS.MATCH) {
                    return violationOrManifest;
                }
                latestManifest = violationOrManifest.manifest;
                appVersion = violationOrManifest.appVersion;
            }
        }

        const trustedManifest = await trustedManifestStore.get(appVersion);

        let result = verifyFileHash(trustedManifest, fileKey, fileHash, searchByHash);
        if (result.status !== VERIFICATION_STATUS.MATCH) {
            logger.log(`Verification failed for ${fileKey} - ${result.status}`);
            if (!latestManifest) {
                const violationOrManifest = await fetchAndStoreManifest();
                if (violationOrManifest.status !== VERIFICATION_STATUS.MATCH) {
                    return violationOrManifest;
                }
                latestManifest = violationOrManifest.manifest;
                result = verifyFileHash(latestManifest, fileKey, fileHash, searchByHash);
            }
        }
        await verificationResultsStore.add(appVersion, result);

        const icon = fileKey.startsWith('/') ? '📄' : '🌐';
        const statusIcon = result.status === VERIFICATION_STATUS.MATCH ? '✅' : '❌';
        logger.log(`${statusIcon} ${icon} ${result.status}: ${fileKey}`);
        return result;
    };

    return {
        initializeManifest,
        verifyFile,
    };
};
