/**
 * File Verifier
 * Rule engine: content rule matching, action pipeline, and file hash verification.
 *
 * Manifest escalation for unpinned clients (MISMATCH / NOT_FOUND only):
 *   1. latestManifest (caller-supplied, IndexedDB cache)
 *   2. getManifestHistory — stored historic manifests, newest-first
 *   3. fetchAndStoreManifest — force network fetch (terminal)
 *
 * Any other result (MATCH, SKIPPED, REWRITE, DENIED_BY_RULE, ERROR) stops
 * escalation immediately — see manifestDecided().
 *
 * Pinned clients skip escalation entirely: their manifest is the truth for the
 * page load, so any failure is a genuine violation.
 */

import { VERIFICATION_STATUS } from '../../core/constants.js';
import { applyTransform, collectContentRuleActions, resolveManifestKey } from './rules.js';
import { toPathname } from './verification.js';
import { createLogger } from '../../core/logger.js';
import { calculateHash } from '../../core/crypto.js';

const logger = createLogger();

// A manifest has decided when it produced a result other than a hash-lookup
// failure. Hash failures (MISMATCH, NOT_FOUND_IN_MANIFEST) mean the manifest
// may be stale — escalate to a newer or historic version. Any other outcome
// — including DENIED_BY_RULE — is a policy decision that must not be
// bypassed by trying a different manifest version.
// null means tryManifest skipped the manifest entirely; keep escalating.
const manifestDecidedAbout = (result) =>
    result !== null &&
    result.status !== VERIFICATION_STATUS.MISMATCH &&
    result.status !== VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST;

/**
 * @param {object} deps
 * @param {object} deps.swContext
 * @param {object} deps.appStore
 * @param {object} deps.config
 * @param {object} manifestLoader
 */
export const createFileVerifier = ({ swContext, appStore, config }, manifestLoader) => {
    const { fetchAndStoreManifest, getManifestHistory } = manifestLoader;
    const { verificationResultsStore } = appStore;
    const locationHref = swContext.getLocationHref();
    const manifestFileKey = toPathname(config.manifestUrl, locationHref);
    const clientIdXManifest = new Map();

    const pruneStaleClients = () => {
        swContext
            .matchAllClients()
            .then((activeClients) => {
                const activeIds = new Set(activeClients.map((c) => c.id));
                for (const id of clientIdXManifest.keys()) {
                    if (!activeIds.has(id)) {
                        clientIdXManifest.delete(id);
                    }
                }
            })
            .catch((err) => {
                logger.error('Error pruning stale clients:', err);
            });
    };

    const pinClient = (clientId, manifestInfo) => {
        if (!clientId) return;
        clientIdXManifest.set(clientId, manifestInfo);
        pruneStaleClients();
    };

    const shouldSkipVerification = (req, response) => {
        const { destination } = req;
        if (!response) {
            logger.log(`⏭️  Error: null response`);
            return VERIFICATION_STATUS.ERROR;
        }
        logger.log(
            `[shouldSkipVerification] ${req.method} destination=${destination} response.ok=${response?.ok} response.type=${response?.type}`
        );
        const skip = (reason) => {
            logger.log(`⏭️  Skipping: ${reason}`);
            return VERIFICATION_STATUS.SKIPPED;
        };

        const isPostNavigation = req.method === 'POST' && req.mode === 'navigate';
        if (req.method !== 'GET' && !isPostNavigation) {
            return skip('non-GET/non-POST-navigate request');
        }
        if (!destination) return skip('programmatic fetch (destination="")');
        if (!response.ok && destination !== 'document') return skip('non-ok sub-resource');
        if (response.type === 'opaqueredirect' || response.type === 'error') {
            return skip(`empty body, response type ${response.type}`);
        }
        if (response.type === 'opaque') {
            if (destination !== 'script') {
                return skip('non-script opaque');
            }
            logger.log(`↩️  Rewriting opaque script`);
            return VERIFICATION_STATUS.REWRITE;
        }
        return null;
    };

    const getExpectedHashes = (fileKey, manifest) => {
        const entry = manifest.files[fileKey];
        if (entry === undefined) return [];
        return Array.isArray(entry) ? entry : [entry];
    };

    const applyAction = async (action, rawBuffer, fileKey, manifestInfo) => {
        logger.log(
            `[applyAction] fileKey=${fileKey} action.type=${action.type}${action.transform ? ` transform=${action.transform}` : ''}`
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
        if (action.type === 'transform') {
            const transformed = applyTransform(rawBuffer, action.transform);
            if (transformed === null) {
                return null;
            }
            const fileHash = await calculateHash(transformed);
            const expectedHashes = getExpectedHashes(fileKey, manifestInfo.manifest);
            logger.log(
                `Using manifest ${manifestInfo.appVersion} for ${fileKey} hash ${fileHash} expected: ${expectedHashes.join(', ')}`
            );
            if (expectedHashes.includes(fileHash)) {
                return {
                    status: VERIFICATION_STATUS.MATCH,
                    fileKey,
                    expectedHashes,
                    actualHash: fileHash,
                };
            }
            return null;
        }

        if (action.type === 'verify') {
            const fileHash = await calculateHash(rawBuffer);
            const expectedHashes = getExpectedHashes(fileKey, manifestInfo.manifest);
            logger.log(
                `Using manifest ${manifestInfo.appVersion} for ${fileKey} hash ${fileHash} expected: ${expectedHashes.join(', ')}`
            );
            if (expectedHashes.length === 0) {
                return null;
            }
            if (expectedHashes.includes(fileHash)) {
                return {
                    status: VERIFICATION_STATUS.MATCH,
                    fileKey,
                    expectedHashes,
                    actualHash: fileHash,
                };
            }
            return {
                status: VERIFICATION_STATUS.MISMATCH,
                fileKey,
                expectedHashes,
                actualHash: fileHash,
            };
        }
        return null;
    };

    const runPipeline = async (req, response, manifestInfo, rawBuffer) => {
        const { manifest } = manifestInfo;
        const fileKey = resolveManifestKey(req, response, locationHref, manifest);
        const actions = collectContentRuleActions(fileKey, req.destination, manifest?.contentRules);
        const actionsToWalk = actions.length ? actions : [{ type: 'verify' }];
        let lastResult = { status: VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST, fileKey };
        for (const action of actionsToWalk) {
            const r = await applyAction(action, rawBuffer, fileKey, manifestInfo);
            if (r !== null) {
                if (r.status.isTerminal) {
                    return r;
                }
                lastResult = r;
            }
        }
        logger.log(`❌ ${lastResult.status.description}: ${fileKey}`);
        return lastResult;
    };

    const verifyFileWithContext = async (req, response, clientId, latestManifest) => {
        const fileKey = toPathname(req.url, locationHref);

        if (fileKey === manifestFileKey) {
            return fetchAndStoreManifest();
        }

        const status = shouldSkipVerification(req, response);
        if (status !== null) {
            logger.log(`⏭️  ${status.description}: ${fileKey}`);
            return { status, fileKey };
        }

        const isNavigation = req.mode === 'navigate';
        logger.log(
            `[verifyFileWithContext] req.method=${req.method} clientId=${clientId} isNavigation=${isNavigation}`
        );

        // Step 1: pinned client (non-navigation). The pinned manifest is the
        // truth for this page load — any failure is a genuine violation.
        if (clientId && !isNavigation) {
            const pinned = clientIdXManifest.get(clientId);
            if (pinned) {
                logger.log(`[verifyFileWithContext] clientId=${clientId} (pinned)`);
                let rawBuffer;
                try {
                    rawBuffer = await response.arrayBuffer();
                } catch (err) {
                    logger.warn(`Failed to read response body (pinned client)`, err);
                    return { status: VERIFICATION_STATUS.ERROR, fileKey };
                }
                return runPipeline(req, response, pinned, rawBuffer);
            }
        }

        let rawBuffer;
        try {
            rawBuffer = await response.arrayBuffer();
        } catch (err) {
            logger.warn(`Failed to read response body: ${req.url}`, err);
            return { status: VERIFICATION_STATUS.ERROR, fileKey };
        }

        const triedVersions = new Set();
        const tryManifest = async (manifestInfo) => {
            if (
                !manifestInfo ||
                !manifestInfo.manifest ||
                triedVersions.has(manifestInfo.appVersion)
            ) {
                return null;
            }
            triedVersions.add(manifestInfo.appVersion);
            const result = await runPipeline(req, response, manifestInfo, rawBuffer);
            if (result.status === VERIFICATION_STATUS.MATCH) {
                await verificationResultsStore.add(manifestInfo.appVersion, {
                    ...result,
                    status: result.status.description,
                    timestamp: new Date().toISOString(),
                });
                const icon = result.fileKey.startsWith('/') ? '📄' : '🌐';
                logger.log(`✅ ${icon} ${result.status.description}: ${result.fileKey}`);
                pinClient(clientId, manifestInfo);
            } else {
                logger.log(`❌ ${result.status.description}: ${result.fileKey}`);
            }
            return result;
        };

        const latestResult = await tryManifest(latestManifest);
        if (manifestDecidedAbout(latestResult)) {
            return latestResult;
        }

        // Try all stored historic manifests newest-first, skipping already tried.
        // Each is run through the full pipeline, so transforms are applied correctly.
        const historicResults = [];
        for (const manifestInfo of await getManifestHistory()) {
            const result = await tryManifest(manifestInfo);
            if (manifestDecidedAbout(result)) {
                return result;
            }
            historicResults.push(result);
        }

        const fetched = await fetchAndStoreManifest();
        const fetchedResult = await tryManifest(fetched);
        // Prefer freshly fetched result first, then latest, then history in order.
        return [fetchedResult, latestResult, ...historicResults].find((r) => r !== null) ?? fetched;
    };

    return { verifyFileWithContext };
};
