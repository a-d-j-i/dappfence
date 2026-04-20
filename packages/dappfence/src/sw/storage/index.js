/**
 * App Store Facade
 *
 * Manifest Store properties (appVersion, config, trustedManifest,
 * verificationResults) are spread at the top level since they're
 * already uniquely named. The other three are grouped objects.
 *
 * @param {object} db - Low-level Store backend from createDatabase()
 * @param {object} env - Environment info for log enrichment
 * @param {string} env.userAgent
 * @param {string} env.origin
 */
import { createLogger } from '../../core/logger.js';
import { VERIFICATION_STATUS } from '../manifest/verification-helpers.js';
import { createManifestStore } from './manifest-store.js';
import {
    createActiveBlocksStore,
    createSecurityEventsStore,
    createApiTokenStore,
} from './security-stores.js';

const logger = createLogger();

export function createAppStore(db, { userAgent, origin } = {}) {
    const activeBlocksStore = createActiveBlocksStore(db);
    const securityEventsStore = createSecurityEventsStore(db);

    /**
     * Logs a security violation event and records the block.
     * Returns whether the caller must block the current request. Recurrences of
     * already-known blocks (including previously cleared ones) are still logged
     * and counted, but return false. Storage failures fail-safe and return true.
     * @param {object} details - Violation details (status, fileKey, url, expectedHash, actualHash, assetType)
     * @returns {Promise<boolean>} mustBlock — true if the caller should block the request
     */
    async function recordSecurityViolation(details) {
        try {
            if (details.status === VERIFICATION_STATUS.MATCH) {
                logger.log(`SW file verification passed: ${details.fileKey}`);
            } else if (details.status === VERIFICATION_STATUS.MISMATCH) {
                logger.error(
                    `SECURITY ALERT: Service Worker file integrity violation!`,
                    `File: ${details.url}\nExpected: ${details.expectedHash}...`,
                    `Actual: ${details.actualHash}...`
                );
            } else if (details.status === VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST) {
                logger.error(
                    `SECURITY ALERT: Unknown file not in trusted manifest!`,
                    `File: ${details.fileKey}`,
                    `Hash: ${details.expectedHash}...`
                );
            } else {
                logger.error(
                    `SECURITY ALERT: {${details.status}}`,
                    `URL: ${details.url}`,
                    `File: ${details.fileKey}`
                );
            }

            try {
                await securityEventsStore.logSecurityEvent({
                    type: 'SECURITY_VIOLATION',
                    status: details.status,
                    assetType: details.assetType,
                    timestamp: new Date().toISOString(),
                    url: details.url,
                    fileKey: details.fileKey,
                    expectedHash: details.expectedHash?.substring(0, 16) + '...',
                    actualHash: details.actualHash?.substring(0, 16) + '...',
                    userAgent,
                    origin,
                });
            } catch (error) {
                logger.error('Failed to store security log:', error);
            }

            const mustBlock = await activeBlocksStore.recordSecurityBlock(details);
            if (mustBlock) {
                logger.log(`Security violation handled: ${details.status} - ${details.fileKey}`);
            } else {
                logger.log(
                    `%cSecurity violation recurrence (not re-activated): ${details.status} - ${details.fileKey}`,
                    'color:yellow'
                );
            }
            return mustBlock;
        } catch (error) {
            logger.error('Failed to handle security violation:', error);
            // Fail-safe: on unexpected error, tell the caller to block.
            return true;
        }
    }

    return {
        ...createManifestStore(db),
        activeBlocksStore,
        securityEventsStore,
        apiTokenStore: createApiTokenStore(db),
        recordSecurityViolation,
    };
}
