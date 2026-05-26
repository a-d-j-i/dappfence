/**
 * Manifest Service
 * Handles manifest loading, storage, and file verification.
 */

import { calculateHash } from '../../core/crypto.js';
import { ASSET_TYPE, MODE, VERIFICATION_STATUS } from '../../core/constants.js';
import { createSingleFlight, hasConfigManifest, isFeatureEnabled } from '../../core/utils.js';
import {
    toPathname,
    resolveManifestKey,
    verifyFilePath,
    verifyManifestSignature,
} from './verification.js';
import { applyTransform } from './filters.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

/**
 * Collect all contentRules whose condition matches (fileKey, destination) into
 * an ordered action list. Conditions are AND-ed; an absent condition matches all.
 *
 * @param {string} fileKey - Resolved manifest key
 * @param {string} destination - request.destination value
 * @param {Array} contentRules - manifest contentRules array
 * @returns {Array} Ordered list of action objects
 */
const collectContentRuleActions = (fileKey, destination, contentRules) => {
    const actions = [];
    for (const rule of contentRules) {
        const { condition, action } = rule;
        if (condition) {
            const { urlFilter, resourceTypes } = condition;
            if (urlFilter && !fileKey.startsWith(urlFilter)) continue;
            if (resourceTypes && !resourceTypes.includes(destination)) continue;
        }
        actions.push(action);
    }
    return actions;
};

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config
 */
export const createManifestService = ({ swContext, appStore, config }) => {
    const { trustedManifestStore, verificationResultsStore } = appStore;
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

    const manifestFileKey = toPathname(config.manifestUrl, swContext.getLocationHref());

    /**
     * Core verification loop. Reads the response body once, then walks the
     * ordered action list from contentRules. Verify/transform fall through on
     * failure; allow/deny/rewrite are terminal. With no matching rules, an
     * implicit verify is used (backward-compatible default).
     */
    const verifyFileWithContext = async (req, response, latestManifest, clientId) => {
        const url = req.url;
        const destination = req.destination;
        const isNavigation = req.isNavigation;
        const manifest = latestManifest?.manifest;
        const fileKey = resolveManifestKey(
            url,
            swContext.getLocationHref(),
            manifest?.pathRules || [],
            manifest?.files || {}
        );

        if (fileKey === manifestFileKey) {
            logger.log(`⏭️  Skipping verification (manifest file): ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }

        const contentRules = manifest?.contentRules || [];
        const actions = collectContentRuleActions(fileKey, destination, contentRules);

        // If the first action is allow, bypass opaque/status gates and return early.
        if (actions.length > 0 && actions[0].type === 'allow') {
            logger.log(`⏭️  Skipping verification (allow rule): ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }

        // Opaque responses — body is inaccessible to SW JavaScript.
        if (response.type === 'opaque') {
            if (destination === 'script') {
                // Browser would still execute the script; neutralize it.
                logger.log(`↩️  Rewriting opaque script: ${fileKey}`);
                return { status: VERIFICATION_STATUS.REWRITE, fileKey };
            }
            logger.log(`⏭️  Skipping opaque non-script: ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }

        if (!response.ok) {
            logger.log(`⏭️  Skipping non-ok response: ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }

        // Read body once; all action attempts reuse this buffer.
        const rawBuffer = await response.arrayBuffer();

        // With no matching content rules, fall back to a plain verify
        // (backward-compatible: no contentRules → everything verified against files).
        const actionsToWalk = actions.length > 0 ? actions : [{ type: 'verify' }];

        for (const action of actionsToWalk) {
            if (action.type === 'allow') {
                logger.log(`⏭️  Skipping (allow): ${fileKey}`);
                return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
            }
            if (action.type === 'deny') {
                logger.log(`❌ Denied by rule: ${fileKey}`);
                return { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST, fileKey };
            }
            if (action.type === 'rewrite') {
                logger.log(`↩️  Rewriting by rule: ${fileKey}`);
                return { status: VERIFICATION_STATUS.REWRITE, fileKey };
            }
            if (action.type === 'verify' || action.type === 'transform') {
                let buf = rawBuffer;
                if (action.type === 'transform') {
                    const transformed = applyTransform(rawBuffer, action.transform);
                    if (transformed === null) {
                        // Unknown transform name → fall through to next action.
                        continue;
                    }
                    buf = transformed;
                }
                const fileHash = await calculateHash(buf);
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
                if (!result.status.isViolation) {
                    await verificationResultsStore.add(manifestInfo.appVersion, {
                        ...result,
                        status: result.status.description,
                        timestamp: new Date().toISOString(),
                    });
                    const icon = fileKey.startsWith('/') ? '📄' : '🌐';
                    logger.log(`✅ ${icon} ${result.status.description}: ${fileKey}`);
                    return result;
                }
                logger.log(`❌ ${result.status.description} (action: ${action.type}): ${fileKey}`);
                // Fall through to the next action in the list.
            }
        }

        logger.log(`❌ No action succeeded: ${fileKey}`);
        return { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST, fileKey };
    };

    /**
     * Resolve the manifest context for a single request/operation.
     * Returns { mode, verifyFile } so downstream consumers share a single
     * IndexedDB lookup. verifyFile applies the method gate and delegates to
     * verifyFileWithContext.
     *
     * Accepts a plain string URL as well as a Request-like object — the string
     * form uses a synthetic destination of 'script' (for importScripts callers).
     */
    const resolveManifest = async ({ clientId, request } = {}) => {
        let latestManifest = await trustedManifestStore.getLatest();
        if (latestManifest) {
            logger.log(
                `Resolved manifest from cache ${latestManifest.appVersion} ${latestManifest.manifest.mode}`
            );
        } else {
            latestManifest = await fetchAndStoreManifest();
            logger.log(
                `Resolved manifest from network ${latestManifest?.appVersion} ${latestManifest?.manifest?.mode}`
            );
        }
        const mode =
            latestManifest?.manifest?.mode ||
            (isFeatureEnabled('default-to-protected-mode') ? MODE.PROTECTED : MODE.REPORTING);
        logger.log(`Resolved manifest ${latestManifest?.appVersion} with mode ${mode}`);

        const verifyFile = (requestOrUrl, response) => {
            // Accept a plain string URL (from importScripts callers) or a Request-like object.
            const req =
                typeof requestOrUrl === 'string'
                    ? { url: requestOrUrl, destination: 'script', method: 'GET', mode: '' }
                    : requestOrUrl;

            // Method gate: only GET and POST-navigate enter the verification pipeline.
            const isPostNavigation = req.method === 'POST' && req.mode === 'navigate';
            if (req.method !== 'GET' && !isPostNavigation) {
                logger.log(`⏭️  Skipping non-GET/non-navigate: ${req.method} ${req.url}`);
                return Promise.resolve({ status: VERIFICATION_STATUS.SKIPPED });
            }

            return verifyFileWithContext(req, response, latestManifest, clientId);
        };

        return { mode, verifyFile };
    };

    return {
        fetchAndStoreManifest,
        resolveManifest,
    };
};
