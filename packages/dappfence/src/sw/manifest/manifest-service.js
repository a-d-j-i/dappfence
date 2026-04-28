/**
 * Manifest Service
 * Handles manifest loading, storage, and file verification.
 */

import { calculateHash } from '../../core/crypto.js';
import { DEFAULT_SECURITY_EXTENSIONS, MODE } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest, isFeatureEnabled } from '../../core/utils.js';
import { getFileKey, verifyFilePath, verifyManifestSignature } from './operations.js';
import { ASSET_TYPE, shouldVerifyAsset, VERIFICATION_STATUS } from './verification-helpers.js';
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

            if (!response.ok) {
                logger.error(
                    `Failed to load manifest: ${response?.status} ${response?.statusText}`
                );
                return {
                    status: VERIFICATION_STATUS.ERROR,
                    fileKey,
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
                    fileKey,
                    url: manifestUrl,
                    actualHash: signatureResult.actualHash || 'N/A',
                    expectedHash: signatureResult.expectedHash || 'ERROR',
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
        return {
            status: VERIFICATION_STATUS.ERROR,
            fileKey,
            url: manifestUrl,
            actualHash: 'N/A',
            expectedHash: 'N/A',
        };
    };

    const fetchAndStoreManifest = async () => {
        if (!hasConfigManifest(config)) {
            return {
                status: VERIFICATION_STATUS.CONFIG_ERROR,
                assetType: ASSET_TYPE.MANIFEST,
                url: 'N/A',
                actualHash: 'N/A',
                expectedHash: 'N/A',
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
     * TODO(per-client pinning): once `resolveManifest` pins a manifest to
     * `clientId` on navigation, this function needs to take that pinned
     * `{appVersion, manifest}` as an argument and verify against it,
     * falling back to `findByHash` only when there's no pin yet. Today's
     * content-driven `findByHash` lookup is shared across clients, so two
     * clients running different apps could verify against each other's
     * manifest — fine for single-app deploys, wrong once pinning is on.
     */
    const verifyFileWithContext = async (url, isNavigation, content) => {
        const fileKey = getFileKey(url, swContext.getLocationHref());
        const fileHash = await calculateHash(new TextEncoder().encode(content));
        logger.log(`Verifying file: ${fileKey} (${fileHash.substring(0, 12)}...)`);

        let { appVersion, manifest } = (await trustedManifestStore.findByHash(fileHash)) ?? {};
        if (appVersion) {
            logger.log(`Identified manifest from hash ${fileHash} ${appVersion}`);
        } else {
            const violationOrManifest = await fetchAndStoreManifest();
            if (violationOrManifest.status !== VERIFICATION_STATUS.MATCH) {
                return violationOrManifest;
            }
            appVersion = violationOrManifest.appVersion;
            manifest = violationOrManifest.manifest;
        }
        const result = verifyFilePath(manifest, fileKey, fileHash, isNavigation);
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
        const extensions =
            latestManifest?.manifest?.metadata?.extensions || DEFAULT_SECURITY_EXTENSIONS;
        logger.log(
            `Resolved manifest ${latestManifest?.appVersion} with mode ${mode} and extensions ${extensions.join(', ')}`
        );
        return {
            mode,
            extensions,
            shouldVerify: (url) => shouldVerifyAsset(url, isNavigation, extensions),
            verifyFile: (url, content) => verifyFileWithContext(url, isNavigation, content),
        };
    };

    return {
        fetchAndStoreManifest,
        resolveManifest,
    };
};
