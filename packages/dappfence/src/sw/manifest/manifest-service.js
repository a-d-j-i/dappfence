/**
 * Manifest Service
 * Composes manifest loading and file verification into the public API.
 */

import { MODE } from '../../core/constants.js';
import { isFeatureEnabled } from '../../core/utils.js';
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
export const createManifestService = (deps) => {
    const manifestLoader = createManifestLoader(deps);
    const { verifyFileWithContext } = createFileVerifier(deps, manifestLoader);

    const resolveManifest = async () => {
        const latestManifest = await manifestLoader.resolveLatest();
        const mode = getEffectiveMode(latestManifest?.manifest);
        logger.log(`Resolved manifest ${latestManifest?.appVersion} with mode ${mode}`);

        const verifyFile = (req, response, clientId = null) =>
            verifyFileWithContext(req, response, clientId, latestManifest);

        return { mode, verifyFile };
    };

    return {
        fetchAndStoreManifest: manifestLoader.fetchAndStoreManifest,
        resolveManifest,
    };
};
