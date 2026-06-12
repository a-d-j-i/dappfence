/**
 * Manifest Loader
 * Handles manifest fetching, signature verification, and storage.
 */

import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest } from '../../core/utils.js';
import { toPathname, verifyManifestSignature } from './verification.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config
 */
export const createManifestLoader = ({ swContext, appStore, config, onBlocksResolved }) => {
    const { trustedManifestStore, activeBlocksStore } = appStore;
    const singleFlight = createSingleFlight();

    const loadManifestFromUrl = async () => {
        const { manifestUrl, manifestSignatureType, manifestSignatureIdentity } = config;
        const fileKey = toPathname(manifestUrl, swContext.getLocationHref());
        logger.log(`Loading manifest from ${manifestUrl} fileKey: ${fileKey}`);
        try {
            const response = await swContext.fetch(manifestUrl, {
                cache: 'no-cache',
                headers: { 'x-dappfence': 'manifest-load' },
            });

            if (!response || !response.ok) {
                logger.error(
                    `Failed to load manifest: ${response?.status} ${response?.statusText}`
                );
                return { status: VERIFICATION_STATUS.ERROR, fileKey, assetType: ASSET_TYPE.MANIFEST };
            }

            const json = await response.json();
            const signatureResult = verifyManifestSignature(
                manifestSignatureType,
                manifestSignatureIdentity,
                json
            );
            if (signatureResult.status.isViolation) {
                return {
                    ...signatureResult,
                    assetType: ASSET_TYPE.MANIFEST,
                    fileKey,
                };
            }

            const { appVersion, manifest } = await trustedManifestStore.addLatest(
                signatureResult.payload
            );
            logger.log(
                `Loaded manifest, app version: ${appVersion.substring(0, 12)}... (${Object.keys(manifest.files).length} files)`
            );
            const resolved = await activeBlocksStore.resolveStaleBlocks(manifest.files);
            if (resolved > 0 && onBlocksResolved) {
                onBlocksResolved();
            }
            return { status: VERIFICATION_STATUS.MATCH, manifest, appVersion, assetType: ASSET_TYPE.MANIFEST };
        } catch (error) {
            logger.error('Error loading manifest:', error);
        }
        return { status: VERIFICATION_STATUS.ERROR, fileKey, assetType: ASSET_TYPE.MANIFEST };
    };

    const fetchAndStoreManifest = async () => {
        if (!hasConfigManifest(config)) {
            return {
                status: VERIFICATION_STATUS.CONFIG_ERROR,
                assetType: ASSET_TYPE.MANIFEST,
            };
        }
        return singleFlight(loadManifestFromUrl);
    };

    const resolveLatest = async () => {
        const cached = await trustedManifestStore.getLatest();
        if (cached) {
            logger.log(`Resolved manifest from cache ${cached.appVersion} ${cached.manifest.mode}`);
            return cached;
        }
        const fetched = await fetchAndStoreManifest();
        logger.log(
            `Resolved manifest from network ${fetched?.appVersion} ${fetched?.manifest?.mode}`
        );
        return fetched;
    };

    return {
        fetchAndStoreManifest,
        resolveLatest,
        getManifestHistory: trustedManifestStore.getAll,
    };
};
