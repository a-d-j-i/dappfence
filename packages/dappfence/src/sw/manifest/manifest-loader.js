/**
 * Manifest Loader
 * Handles manifest fetching, signature verification, storage, and per-client caching.
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
export const createManifestLoader = ({ swContext, appStore, config }) => {
    const { trustedManifestStore } = appStore;
    const clientIdXManifest = new Map();
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
                return { status: VERIFICATION_STATUS.ERROR, fileKey };
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
            return { status: VERIFICATION_STATUS.MATCH, manifest, appVersion };
        } catch (error) {
            logger.error('Error loading manifest:', error);
        }
        return { status: VERIFICATION_STATUS.ERROR, fileKey };
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

    const pruneStaleClients = () => {
        swContext.matchAllClients().then((activeClients) => {
            const activeIds = new Set(activeClients.map((c) => c.id));
            for (const id of clientIdXManifest.keys()) {
                if (!activeIds.has(id)) {
                    clientIdXManifest.delete(id);
                }
            }
        });
    };

    const resolveManifestInfo = async (fileHash, clientId, isNavigation) => {
        if (clientId && !isNavigation) {
            const pinned = clientIdXManifest.get(clientId);
            if (pinned) {
                return pinned;
            }
        }
        let manifestInfo = await trustedManifestStore.findByHash(fileHash);
        if (!manifestInfo || !manifestInfo.appVersion) {
            const fetched = await fetchAndStoreManifest();
            if (fetched.status.isViolation) {
                return { violation: fetched };
            }
            manifestInfo = { appVersion: fetched.appVersion, manifest: fetched.manifest };
        }
        if (clientId) {
            clientIdXManifest.set(clientId, manifestInfo);
            pruneStaleClients();
        }
        return manifestInfo;
    };

    return {
        fetchAndStoreManifest,
        resolveManifestInfo,
    };
};
