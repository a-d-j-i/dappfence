/**
 * Manifest Service
 * Handles manifest loading, storage, and file verification.
 */

import { calculateHash } from '../../core/crypto.js';
import { ASSET_TYPE, MODE, VERIFICATION_STATUS } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest, isFeatureEnabled } from '../../core/utils.js';
import {
    getFileKey,
    shouldVerifyAsset,
    verifyFilePath,
    verifyManifestSignature,
} from './verification.js';
import { applyFilters, isFilterRewrite } from './filters.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config - Manifest config (manifestUrl, manifestSignatureType, manifestSignatureIdentity)
 */
export const createManifestService = ({ swContext, appStore, config }) => {
    const { trustedManifestStore, verificationResultsStore } = appStore;
    const clientIdXManifest = new Map();
    const singleFlight = createSingleFlight();

    const loadManifestFromUrl = async () => {
        const { manifestUrl, manifestSignatureType, manifestSignatureIdentity } = config;
        const fileKey = getFileKey(manifestUrl, swContext.getLocationHref());
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

    /**
     * Verify a file against a (possibly pre-resolved) manifest. When
     * `manifest` is undefined, runs the cold-start path: identify the app
     * from a stored manifest by file hash, or fetch a fresh one. Once a
     * manifest is in hand, hashes the content and checks against it; on
     * mismatch, refetches once in case an in-flight manifest update has
     * landed (skipped if we just fetched a fresh manifest above).
     *
     * once `resolveManifest` pins a manifest to `clientId` on navigation,
     * this function takes that pinned `{appVersion, manifest}` and verifies
     * against it, falling back to `findByHash` only when there's no pin yet.
     */
    const manifestFileKey = getFileKey(config.manifestUrl, swContext.getLocationHref());

    const verifyFileWithContext = async (url, isNavigation, response, latestManifest, clientId) => {
        const meta = latestManifest?.manifest?.metadata;
        const fileKey = getFileKey(url, swContext.getLocationHref());
        if (
            fileKey === manifestFileKey ||
            !shouldVerifyAsset(fileKey, isNavigation, response, meta)
        ) {
            logger.log(`⏭️  Skipping verification: ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }
        const rawBuffer = await response.arrayBuffer();
        const filters = latestManifest?.manifest?.filters || [];
        const normalizedBuffer = applyFilters(rawBuffer, filters, fileKey, isNavigation);
        const fileHash = await calculateHash(normalizedBuffer);
        logger.log(`Verifying file: ${fileKey} hash ${fileHash}`);
        let manifestInfo;
        if (clientId && !isNavigation) {
            manifestInfo = clientIdXManifest.get(clientId);
        }
        // Use pinned manifest for this client if available; otherwise look up by hash.
        // (Pinned manifests are set during navigation; prior clients may lack one.)
        if (!manifestInfo) {
            manifestInfo = await trustedManifestStore.findByHash(fileHash);
            if (!manifestInfo || !manifestInfo.appVersion) {
                const violationOrManifest = await fetchAndStoreManifest();
                if (violationOrManifest.status.isViolation) {
                    return violationOrManifest;
                }
                manifestInfo = {
                    appVersion: violationOrManifest.appVersion,
                    manifest: violationOrManifest.manifest,
                };
            }
            if (clientId) {
                clientIdXManifest.set(clientId, manifestInfo);
            }
        }
        logger.log(
            `Using manifest ${manifestInfo.appVersion} for ${fileKey} hash ${fileHash} clientId ${clientId} ${isNavigation ? 'navigation' : 'no-navigation'}`
        );
        const result = verifyFilePath(manifestInfo.manifest, fileKey, fileHash);
        if (result.status.isViolation && isFilterRewrite(filters, fileKey)) {
            logger.log(`↩️  Rewriting: ${fileKey}`);
            return { ...result, status: VERIFICATION_STATUS.REWRITE };
        }
        await verificationResultsStore.add(manifestInfo.appVersion, {
            ...result,
            status: result.status.description,
            timestamp: new Date().toISOString(),
        });
        const icon = fileKey.startsWith('/') ? '📄' : '🌐';
        const statusIcon = result.status.isViolation ? '❌' : '✅';
        logger.log(`${statusIcon} ${icon} ${result.status.description}: ${fileKey}`);
        return result;
    };

    /**
     * Resolve the manifest context for a single request/operation.
     * Loads the current trusted manifest once and returns a view with
     * `mode` and `verifyFile` so downstream consumers don't each re-read
     * IndexedDB. The skip-or-verify decision is folded into `verifyFile`
     * (returns SKIPPED for non-applicable assets), so the caller doesn't
     * carry a per-asset policy.
     *
     * `clientId` and `isNavigation` are accepted for forward compatibility
     * with per-client manifest pinning — the current implementation still
     * resolves the global manifest. Pass `{}` (or nothing) for operations
     * outside the fetch pipeline such as importScripts.
     */
    const resolveManifest = async ({ clientId, isNavigation } = {}) => {
        // The latest stored manifest drives policy; on a cold start we fetch one.
        // On fetch failure the result has no `manifest` field, so policy
        // falls through to defaults via policyFromManifest's optional
        // chaining. verifyFileWithContext does its own findByHash lookup.
        let latestManifest = await trustedManifestStore.getLatest();
        if (latestManifest) {
            logger.log(
                `Resolved manifest from cache ${latestManifest.appVersion} ${latestManifest.manifest.mode}`
            );
        } else {
            latestManifest = await fetchAndStoreManifest();
            logger.log(
                `Resolved manifest from network ${latestManifest.appVersion} ${latestManifest.manifest.mode}`
            );
        }
        const mode =
            latestManifest?.manifest?.mode ||
            (isFeatureEnabled('default-to-protected-mode') ? MODE.PROTECTED : MODE.REPORTING);
        logger.log(`Resolved manifest ${latestManifest?.appVersion} with mode ${mode}`);
        return {
            mode,
            verifyFile: (url, response) =>
                verifyFileWithContext(url, isNavigation, response, latestManifest, clientId),
        };
    };

    return {
        fetchAndStoreManifest,
        resolveManifest,
    };
};
