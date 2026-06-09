/**
 * File Verifier
 * Rule engine: content rule matching, action pipeline, and file hash verification.
 */

import { VERIFICATION_STATUS } from '../../core/constants.js';
import {
    resolveManifestKey,
    verifyFilePath,
    collectContentRuleActions,
    applyTransform,
} from './rules.js';
import { createLogger } from '../../core/logger.js';
import { calculateHash } from '../../core/crypto.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {string} deps.manifestFileKey
 * @param {Function} deps.resolveManifestInfo
 */
export const createFileVerifier = ({
    swContext,
    appStore,
    manifestFileKey,
    resolveManifestInfo,
}) => {
    const { verificationResultsStore } = appStore;
    const locationHref = swContext.getLocationHref();

    const getGateResult = (fileKey, response, destination) => {
        logger.log(
            `[getGateResult] fileKey=${fileKey} manifestFileKey=${manifestFileKey} response.ok=${response?.ok} response.type=${response?.type} destination=${destination}`
        );
        if (!response) {
            logger.log(`⏭️  Skipping null response: ${fileKey}`);
            return { status: VERIFICATION_STATUS.ERROR, fileKey };
        }
        if (!destination) {
            logger.log(`⏭️  Skipping programmatic fetch (destination=""): ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }
        if (!response.ok && destination !== 'document') {
            logger.log(`⏭️  Skipping non-ok sub-resource: ${fileKey}`);
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

    const verifyBuffer = async (fileKey, fileHash, manifestInfo) => {
        logger.log(`Using manifest ${manifestInfo.appVersion} for ${fileKey} hash ${fileHash}`);
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

    const applyAction = async (action, rawBuffer, fileKey, clientId, isNavigation) => {
        logger.log(
            `[applyAction] fileKey=${fileKey} action.type=${action.type}${action.transform ? ` transform=${action.transform}` : ''} clientId=${clientId} isNavigation=${isNavigation}`
        );
        if (action.type === 'allow') {
            logger.log(`⏭️  Skipping (allow): ${fileKey}`);
            return { status: VERIFICATION_STATUS.SKIPPED, fileKey };
        }
        if (action.type === 'deny') {
            logger.log(`❌ Denied by rule: ${fileKey}`);
            return { status: VERIFICATION_STATUS.DENIED_BY_RULE, fileKey };
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
                    return null;
                }
                buf = transformed;
            }
            const fileHash = await calculateHash(buf);
            const manifestInfo = await resolveManifestInfo(fileHash, clientId, isNavigation);
            if (manifestInfo.violation) {
                return manifestInfo.violation;
            }
            const result = await verifyBuffer(fileKey, fileHash, manifestInfo);
            if (!result.status.isViolation) {
                return result;
            }
            logger.log(`❌ ${result.status.description} (action: ${action.type}): ${fileKey}`);
        }
        return null;
    };

    const verifyFileWithContext = async (req, response, clientId, latestManifest) => {
        const isPostNavigation = req.method === 'POST' && req.mode === 'navigate';
        if (req.method !== 'GET' && !isPostNavigation) {
            logger.log(`⏭️  Skipping non-GET/non-navigate: ${req.method} ${req.url}`);
            return { status: VERIFICATION_STATUS.SKIPPED };
        }

        const manifest = latestManifest?.manifest;

        const fileKey = resolveManifestKey(req, response, locationHref, manifest);
        logger.log(`[verifyFileWithContext] fileKey=${fileKey} clientId=${clientId}`);

        const gateResult = getGateResult(fileKey, response, req.destination);
        if (gateResult !== null) {
            return gateResult;
        }

        let rawBuffer;
        try {
            rawBuffer = await response.arrayBuffer();
        } catch (err) {
            logger.warn(`Failed to read response body for verification: ${fileKey}`, err);
            return { status: VERIFICATION_STATUS.ERROR, fileKey };
        }

        const actions = collectContentRuleActions(fileKey, req.destination, manifest?.contentRules);
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

    return { verifyFileWithContext };
};
