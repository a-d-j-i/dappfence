/**
 * Manifest Service
 * Composes manifest loading and file verification into the public API.
 */

import { MODE } from '../../core/constants.js';
import { isFeatureEnabled } from '../../core/utils.js';
import { toPathname } from './verification.js';
import { createManifestLoader } from './manifest-loader.js';
import { createFileVerifier } from './file-verifier.js';
import { createLogger } from '../../core/logger.js';

const logger = createLogger();

const getEffectiveMode = (manifest) =>
    manifest?.mode ||
    (isFeatureEnabled('default-to-protected-mode') ? MODE.PROTECTED : MODE.REPORTING);

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config
 */
export const createManifestService = ({ swContext, appStore, config }) => {
    const manifestFileKey = toPathname(config.manifestUrl, swContext.getLocationHref());
    const { fetchAndStoreManifest, resolveManifestInfo } = createManifestLoader({
        swContext,
        appStore,
        config,
    });
    const { verifyFileWithContext } = createFileVerifier({
        swContext,
        appStore,
        manifestFileKey,
        resolveManifestInfo,
    });

    const resolveManifest = async () => {
        let latestManifest = await appStore.trustedManifestStore.getLatest();
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
