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

const getEffectiveMode = (manifest) =>
    manifest?.mode ||
    (isFeatureEnabled('default-to-protected-mode') ? MODE.PROTECTED : MODE.REPORTING);

/**
 * Collect all contentRules whose condition matches (fileKey, destination) into
 * an ordered action list. Conditions are AND-ed; an absent condition matches all.
 *
 * @param condition
 * @param {string} fileKey - Resolved manifest key
 * @param {string} destination - `request.destination` value
 * @returns {boolean} Ordered list of action objects
 */
const matchesCondition = (condition, fileKey, destination) => {
    if (!condition) {
        return true;
    }

    const { urlFilter, resourceTypes } = condition;
    if (urlFilter && !fileKey.startsWith(urlFilter)) {
        return false;
    }
    return !(resourceTypes && !resourceTypes.includes(destination));
};

const collectContentRuleActions = (fileKey, destination, contentRules) =>
    contentRules
        .filter(({ condition }) => matchesCondition(condition, fileKey, destination))
        .map(({ action }) => action);

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
    const manifestFileKey = toPathname(config.manifestUrl, swContext.getLocationHref());

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

    const verifyBuffer = async (fileKey, fileHash, clientId, isNavigation) => {
        const manifestInfo = await resolveManifestInfo(fileHash, clientId, isNavigation);
        if (manifestInfo.violation) {
            return manifestInfo.violation;
        }
        logger.log(
            `Using manifest ${manifestInfo.appVersion} for ${fileKey} hash ${fileHash} clientId ${clientId}`
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
        } else {
            logger.log(`❌ ${result.status.description}: ${fileKey}`);
        }
        return result;
    };

    // Checks pre-body-read gate conditions. Returns a result to short-circuit, or null to proceed.
    const getGateResult = (fileKey, response, destination) => {
        if (!response || !response.ok) {
            logger.log(`⏭️  Skipping non-ok response: ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }
        if (fileKey === manifestFileKey) {
            logger.log(`⏭️  Skipping verification (manifest file): ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }
        if (response.type === 'opaque') {
            if (destination === 'script') {
                logger.log(`↩️  Rewriting opaque script: ${fileKey}`);
                return { status: VERIFICATION_STATUS.REWRITE, fileKey };
            }
            logger.log(`⏭️  Skipping opaque non-script: ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }
        return null;
    };

    // Returns a result object if the action is terminal or null to fall through.
    const applyAction = async (action, rawBuffer, fileKey, clientId, isNavigation) => {
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
                    return null; // unknown transform → fall through
                }
                buf = transformed;
            }
            const fileHash = await calculateHash(buf);
            const result = await verifyBuffer(fileKey, fileHash, clientId, isNavigation);
            if (!result.status.isViolation) {
                return result;
            }
            logger.log(`❌ ${result.status.description} (action: ${action.type}): ${fileKey}`);
        }
        return null; // unknown action type or verify/transform failure → fall through
    };

    /**
     * Core verification loop. Reads the response body once, then walks the ordered
     * action list from contentRules. Verify/transform fall through on failure;
     * allow/deny/rewrite are terminal. With no matching rules, an implicit `verify` is used.
     */
    const verifyFileWithContext = async (req, response, clientId, latestManifest) => {
        // Method gate: only GET and POST-navigate enter the verification pipeline.
        const isPostNavigation = req.method === 'POST' && req.mode === 'navigate';
        if (req.method !== 'GET' && !isPostNavigation) {
            logger.log(`⏭️  Skipping non-GET/non-navigate: ${req.method} ${req.url}`);
            return { status: VERIFICATION_STATUS.SKIPPED };
        }

        const { url, destination } = req;
        const manifest = latestManifest?.manifest ?? {};
        const pathRules = manifest.pathRules ?? [];
        const files = manifest.files ?? {};
        const contentRules = manifest.contentRules ?? [];
        const fileKey = resolveManifestKey(url, swContext.getLocationHref(), pathRules, files);

        const gateResult = getGateResult(fileKey, response, destination);
        if (gateResult !== null) {
            return gateResult;
        }

        // Read body once; all action attempts to reuse this buffer.
        const rawBuffer = await response.arrayBuffer();
        const actions = collectContentRuleActions(fileKey, destination, contentRules);
        // With no matching content rules, fall back to a plain `verify`
        // (backward-compatible: no contentRules → everything verified against files).
        const actionsToWalk = actions.length ? actions : [{ type: 'verify' }];
        const isNavigation = req.mode === 'navigate';

        for (const action of actionsToWalk) {
            const result = await applyAction(action, rawBuffer, fileKey, clientId, isNavigation);
            if (result !== null) {
                return result;
            }
        }
        logger.log(`❌ No action succeeded: ${fileKey}`);
        return { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST, fileKey };
    };

    const resolveManifest = async () => {
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
        const mode = getEffectiveMode(latestManifest?.manifest);
        logger.log(`Resolved manifest ${latestManifest?.appVersion} with mode ${mode}`);

        const verifyFile = (req, response, clientId = null) =>
            verifyFileWithContext(req, response, clientId, latestManifest);

        return { mode, verifyFile };
    };

    return {
        fetchAndStoreManifest,
        resolveManifest,
    };
};
