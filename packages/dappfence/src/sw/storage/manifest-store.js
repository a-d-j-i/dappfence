/**
 * Manifest Store Abstraction
 * Handles all Store operations with a clear separation of concerns
 *
 * Uses dependency injection: createManifestStore(Store) takes a
 * { get, set, delete } interface, making it testable with in-memory backends.
 */

// Trusted Manifest System constants
const TRUSTED_MANIFEST_KEY = 'trusted-manifest';
const VERIFICATION_RESULTS_KEY = 'verification-results';
const APP_VERSION_KEY = 'app-version';
const MANIFEST_CONFIG_KEY = 'manifest-config';
const SESSION_APP_VERSION_KEY = 'session-app-version'; // Stable across SW re-registrations

/**
 * Create all manifest database operations with an injected database backend.
 * @param {object} database - database backend with { get(key), set(key, value), delete(key) }
 */
export function createManifestStore(database) {
    /**
     * App Version database Operations
     */
    const appVersionStore = {
        async get() {
            // First check for session version (more stable across SW re-registrations)
            const sessionVersion = await database.get(SESSION_APP_VERSION_KEY);
            if (sessionVersion) {
                return sessionVersion;
            }
            return await database.get(APP_VERSION_KEY);
        },

        async set(version) {
            await database.set(APP_VERSION_KEY, version);

            // Also set session version if not already set
            const sessionVersion = await database.get(SESSION_APP_VERSION_KEY);
            if (!sessionVersion) {
                await database.set(SESSION_APP_VERSION_KEY, version);
            }
        },

        async clearSession() {
            await database.delete(SESSION_APP_VERSION_KEY);
        },
    };

    /**
     * Configuration database Operations
     */
    const configStore = {
        async get() {
            const defaultConfig = {
                includeExternalDomains: true,
                allowedExternalDomains: [],
                blockedExternalDomains: [],
            };
            const config = await database.get(MANIFEST_CONFIG_KEY);
            return { ...defaultConfig, ...config };
        },

        async set(config) {
            await database.set(MANIFEST_CONFIG_KEY, config);
        },
    };

    /**
     * Trusted Manifest database Operations
     */
    const trustedManifestStore = {
        async get(appVersion) {
            const allManifests = (await database.get(TRUSTED_MANIFEST_KEY)) || {};
            const manifest = allManifests[appVersion] || {};
            return { files: manifest };
        },

        async set(appVersion, manifest) {
            const allManifests = (await database.get(TRUSTED_MANIFEST_KEY)) || {};
            allManifests[appVersion] = manifest.files;
            await database.set(TRUSTED_MANIFEST_KEY, allManifests);
        },

        async getAllVersions() {
            const allManifests = (await database.get(TRUSTED_MANIFEST_KEY)) || {};
            return Object.keys(allManifests);
        },

        async getAll() {
            const allManifests = (await database.get(TRUSTED_MANIFEST_KEY)) || {};
            const result = {};
            for (const [version, files] of Object.entries(allManifests)) {
                result[version] = { files };
            }
            return result;
        },
    };

    /**
     * Verification Results database Operations
     */
    const verificationResultsStore = {
        async get(appVersion) {
            const allResults = (await database.get(VERIFICATION_RESULTS_KEY)) || {};
            return allResults[appVersion] || [];
        },

        async add(appVersion, result) {
            const allResults = (await database.get(VERIFICATION_RESULTS_KEY)) || {};
            if (!allResults[appVersion]) {
                allResults[appVersion] = [];
            }

            allResults[appVersion].push(result);

            // Keep only last 100 results per app version to avoid unbounded growth
            if (allResults[appVersion].length > 100) {
                allResults[appVersion] = allResults[appVersion].slice(-100);
            }

            await database.set(VERIFICATION_RESULTS_KEY, allResults);
        },
    };

    return {
        appVersionStore,
        configStore,
        trustedManifestStore,
        verificationResultsStore,
    };
}
