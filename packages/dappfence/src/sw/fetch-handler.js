/**
 * Security Fetch Handler Module
 * Orchestrates security checks and app service worker integration
 */

import { createBlockResponse, createRewriteResponse } from './response.js';
import { createLogger } from '../core/logger.js';
import { API_PREFIX, MODE, VERIFICATION_STATUS } from '../core/constants.js';
import { isFeatureEnabled } from '../core/utils.js';

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
    const { activeBlocksStore } = appStore;
    const locationOrigin = swContext.getLocationOrigin();
    const locationHref = swContext.getLocationHref();

    /**
     * Add DappFence tracking markers to the request.
     * Pure function — takes originUrl as a string so it can be tested without swContext.
     */
    function addMarkToRequest(event, request) {
        const requestUrl = new URL(request.url);
        const isSameOrigin = requestUrl.origin === locationOrigin;

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
            if (request.mode === 'navigate') {
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

    async function applyIntegrityPolicy(ctx, request, response, clientId) {
        logger.log('Verifying security-critical asset:', request.url);
        const verificationResult = await ctx.verifyFile(request, response.clone(), clientId);
        let mustBlock = false;
        if (
            verificationResult.status !== VERIFICATION_STATUS.MATCH &&
            verificationResult.status !== VERIFICATION_STATUS.SKIPPED
        ) {
            mustBlock = await appStore.recordSecurityViolation({
                ...verificationResult,
                url: request.url,
                httpStatus: response.status,
            });
        }

        if (verificationResult.status === VERIFICATION_STATUS.REWRITE) {
            return createRewriteResponse(response);
        }
        if (ctx.mode === MODE.PROTECTED && mustBlock) {
            // Navigation requests get the warning inline via createBlockResponse;
            // so broadcasting to the client would double-notify.
            if (request.mode !== 'navigate') {
                await onSecurityViolation();
            }
            return createBlockResponse(request, locationHref);
        }
        return response;
    }

    async function handleRequest(event, callChildHandlers) {
        const request = event.request;
        const url = new URL(request.url);
        const clientId = request.mode === 'navigate' ? event.resultingClientId : event.clientId;

        logger.log(
            `%cFetch: ${request.method} ${request.url} mode: ${request.mode} clientId: ${clientId} `,
            'color:cyan'
        );

        // Handle internal API endpoints. Served in every mode so client-side
        // dappfence.js can always talk to the SW. If the handler declines
        // (undefined), fall through to the normal child-SW pipeline — API
        // probes behave like any other asset request and don't reveal
        // DappFence via the warning redirect.
        if (url.pathname.startsWith(API_PREFIX)) {
            logger.log('Handling API endpoint:', url.pathname);
            const response = await handleApiEndpoint(url.pathname, request);
            if (response) {
                return response;
            }
        }

        // Resolve the manifest context once per request — mode and verifyFile
        // share the single IndexedDB lookup done here.
        const ctx = await manifestService.resolveManifest();
        logger.log(`Client mode: ${clientId} ${ctx.mode}`);

        // Site-wide block gate only fires in protected mode. In other modes we
        // still let the request flow so the child SW's response is returned
        // untouched.
        if (ctx.mode === MODE.PROTECTED && (await activeBlocksStore.isBlocked())) {
            return createBlockResponse(request, locationHref);
        }

        // Add tracking markers to request BEFORE any handlers to see it
        const markedRequest = isFeatureEnabled('mark_request')
            ? addMarkToRequest(event, request)
            : request;

        // Try the child SW first; if its delegation or internal fetch fails,
        // fall back to a direct fetch so applyIntegrityPolicy still runs.
        let response;
        try {
            response = await handleAppServiceWorkerFetch(event, callChildHandlers, markedRequest);
        } catch (error) {
            logger.warn('Child SW fetch failed, retrying direct:', request.url, error);
            response = await swContext.fetch(request);
        }

        return await applyIntegrityPolicy(ctx, markedRequest, response, clientId);
    }

    return async (event, callChildHandlers) => {
        try {
            return await handleRequest(event, callChildHandlers);
        } catch (error) {
            logger.error('Fatal error processing request:', event.request.url, error);
            // Rethrow fetch()-level errors (TypeError = network/CORS, AbortError = aborted)
            // so the browser sees the real failure
            if (
                error instanceof TypeError ||
                (error instanceof DOMException && error.name === 'AbortError')
            ) {
                throw error;
            }
            return new Response('Service unavailable', { status: 503 });
        }
    };
}
