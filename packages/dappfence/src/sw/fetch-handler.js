/**
 * Security Fetch Handler Module
 * Orchestrates security checks and app service worker integration
 */

import { createBlockResponse, createNavigationWarningResponse } from './response.js';
import { createLogger } from '../core/logger.js';
import { API_PREFIX } from '../core/constants.js';
import {
    ASSET_TYPE,
    shouldVerifyAsset,
    VERIFICATION_STATUS,
} from './manifest/verification-helpers.js';

const logger = createLogger();

/**
 * @param {object} deps
 * @param {object} deps.swContext - Service worker context wrapper
 * @param {object} deps.manifestService - Manifest verification service
 * @param {function} deps.onSecurityViolation - Called to broadcast the block condition
 * @param {object} deps.appStore - App store facade
 * @returns {function} Fetch event handler (event, callChildHandlers) => Promise<Response>
 */
export function createSecurityFetchHandler({
    swContext,
    manifestService,
    onSecurityViolation,
    appStore,
    handleApiEndpoint,
}) {
    const { activeBlocksStore, appVersionStore, trustedManifestStore } = appStore;
    const locationOrigin = swContext.getLocationOrigin();

    /**
     * Add DappFence tracking markers to the request.
     * Pure function — takes originUrl as a string so it can be tested without swContext.
     */
    function addMarkToRequest(event, request, isNavigation, originUrl = locationOrigin) {
        const requestUrl = new URL(request.url);
        const isSameOrigin = requestUrl.origin === originUrl;

        if (!isSameOrigin) {
            logger.log(`[SW-X-ORIGIN] Cross-origin (no tracking): ${request.url}`);
            return request; // Can't modify cross-origin requests
        }

        try {
            // Create URL with SW tracking parameter
            const modifiedUrl = new URL(request.url);
            // modifiedUrl.searchParams.set('sw', '1');

            let modifiedRequest;

            // Handle navigation requests differently (they can't be fully cloned)
            if (isNavigation) {
                logger.log(
                    `[DFSW-NAVIGATE] Navigation request (URL tracking only): ${request.url}`
                );
                modifiedRequest = new Request(modifiedUrl.href, {
                    method: request.method,
                    headers: new Headers({
                        ...Object.fromEntries(request.headers),
                        'x-dappfence': 'processed',
                    }),
                    credentials: request.credentials,
                    redirect: request.redirect,
                    referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy,
                    cache: request.cache,
                    integrity: request.integrity,
                });
            } else {
                // For non-navigation requests, add both URL param and header
                modifiedRequest = new Request(modifiedUrl.href, {
                    headers: new Headers({
                        ...Object.fromEntries(request.headers),
                        'x-dappfence': 'processed',
                    }),
                    method: request.method,
                    mode: request.mode,
                    credentials: request.credentials,
                    redirect: request.redirect,
                    referrer: request.referrer,
                    referrerPolicy: request.referrerPolicy,
                    cache: request.cache,
                    integrity: request.integrity,
                    keepalive: request.keepalive,
                    signal: request.signal,
                    body: request.body,
                });
                logger.log(`[DFSW-HEADER+URL] Added header to: ${modifiedUrl.href}`);
            }

            // IMPORTANT: Replace the request in the event so ALL handlers see the modified version
            Object.defineProperty(event, 'request', {
                value: modifiedRequest,
                writable: false,
                configurable: false,
            });

            return modifiedRequest;
        } catch (error) {
            logger.warn(`Failed to modify request: ${request.url}`, error);
            return request; // Fallback to the original
        }
    }
    /**
     * Handle app service worker fetch event delegation
     */
    async function handleAppServiceWorkerFetch(event, callChildHandlers, request) {
        let appResponse = null;
        let appRespondedWith = false;

        // Store what the app's handler responds with
        const originalRespondWith = event.respondWith.bind(event);

        // Temporarily replace event.respondWith to intercept calls
        event.respondWith = function (responsePromise) {
            appRespondedWith = true;
            appResponse = responsePromise;
            // Don't actually call the original yet
        };

        // Let other handlers run with the REAL event object
        callChildHandlers(event);

        // Restore original respondWith
        event.respondWith = originalRespondWith;

        // Check if any handler called respondWith
        if (!appRespondedWith) {
            logger.log('No handler responded, fetching directly:', request.url);
            return await swContext.fetch(request);
        }

        try {
            return await appResponse;
        } catch (error) {
            logger.warn('App handler promise rejected, falling back to fetch:', error);
        }
        return await swContext.fetch(request);
    }

    /**
     * Process any security-critical asset (JS, CSS, JSON, HTML, SVG)
     */
    async function processSecurityAsset(request, isNavigation, response) {
        logger.log('Processing security-critical asset:', request.url);

        // Get file content for verification
        const assetClone = response.clone();
        const assetContent = await assetClone.text();

        // Verification mode: check against trusted manifest
        const verificationResult = await manifestService.verifyFile(
            request.url,
            assetContent,
            true
        );
        if (verificationResult && verificationResult.status !== VERIFICATION_STATUS.MATCH) {
            const blockDetails = {
                ...verificationResult,
                assetType: ASSET_TYPE.ASSET,
                url: request.url,
            };

            // File hash mismatch - SECURITY VIOLATION
            const mustBlock = await appStore.recordSecurityViolation(blockDetails);
            if (mustBlock) {
                if (!isNavigation) {
                    await onSecurityViolation();
                }
                return createBlockResponse(isNavigation, request.url, swContext.getLocationHref());
            }
        }
        return response;
    }

    return async (event, callChildHandlers) => {
        const originalRequest = event.request;
        try {
            const url = new URL(originalRequest.url);

            // Log all fetch requests for debugging
            logger.log(`%cFetch: ${originalRequest.method} ${originalRequest.url}`, 'color:cyan');

            const isNavigation = originalRequest.mode === 'navigate';

            // Handle internal API endpoints. If the handler declines (undefined),
            // skip the site-wide isBlocked gate and fall through to the normal
            // child-SW pipeline — so API probes behave like any other asset
            // request and don't reveal DappFence via the warning redirect.
            if (url.pathname.startsWith(API_PREFIX)) {
                logger.log('Handling API endpoint:', url.pathname);
                const apiResponse = await handleApiEndpoint(url.pathname, originalRequest);
                if (apiResponse) {
                    return apiResponse;
                }
            } else if (await activeBlocksStore.isBlocked()) {
                if (isNavigation) {
                    return createNavigationWarningResponse();
                }
                return createBlockResponse(
                    isNavigation,
                    originalRequest.url,
                    swContext.getLocationHref()
                );
            }

            // CRITICAL: Add tracking markers to request BEFORE any handlers to see it
            const markedRequest = addMarkToRequest(event, originalRequest, isNavigation);

            const response = await handleAppServiceWorkerFetch(
                event,
                callChildHandlers,
                markedRequest
            );
            if (!response || !response.ok) {
                return response;
            }

            // Smart asset verification based on manifest metadata
            const appVersion = await appVersionStore.get();
            const trustedManifest = await trustedManifestStore.get(appVersion);
            if (shouldVerifyAsset(markedRequest.url, isNavigation, trustedManifest)) {
                return await processSecurityAsset(markedRequest, isNavigation, response);
            }
            return response;
        } catch (error) {
            logger.error('Error processing:', originalRequest.url, error);
            // On error, fallback to regular fetch to avoid breaking the app
            try {
                return await swContext.fetch(originalRequest);
            } catch (fetchError) {
                logger.error('Fallback fetch also failed:', originalRequest.url, fetchError);
                // Return undefined to let the browser handle the error
                return undefined;
            }
        }
    };
}
