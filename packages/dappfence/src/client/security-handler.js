import { createLogger } from '../core/logger.js';
import { MSG } from '../core/constants.js';

const logger = createLogger();

export function setupSecurityMessageListener() {
    navigator.serviceWorker.addEventListener('message', handleSecurityMessage);
    logger.log('Security message listener installed');
}

let redirectAttempted = false;
/**
 * Handle security messages from a service worker.
 *
 * Uses `location.replace` (not `location.href`) so the blocked URL is NOT
 * added to history — pressing Back after dismissing the warning should not
 * return the user to the tampered page.
 */
function handleSecurityMessage(event) {
    const { data } = event;
    if (data?.type !== MSG.SECURITY_BLOCK || redirectAttempted) {
        return;
    }
    logger.error('Security violation detected');
    redirectAttempted = true;
    window.location.replace(data.warningUrl);
}

/**
 * Notify a service worker that the client is ready to receive security messages
 */
export function notifyServiceWorkerReady() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
        logger.warn('No SW controller available to notify of client ready');
        return;
    }

    navigator.serviceWorker.controller.postMessage({
        type: MSG.CLIENT_READY,
        timestamp: Date.now(),
    });
    logger.log('Notified SW that client is ready for security messages');
}
