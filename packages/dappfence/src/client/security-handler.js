import { createLogger } from '../core/logger.js';
import { MSG } from '../core/constants.js';

const logger = createLogger();

export function setupSecurityMessageListener() {
    navigator.serviceWorker.addEventListener('message', handleSecurityMessage);
    logger.log('Security message listener installed');
}

let redirectAttempted = false;
/**
 * Handle security messages from a service worker
 */
function handleSecurityMessage(event) {
    const { data } = event;
    if (data.type === MSG.SECURITY_BLOCK && !redirectAttempted) {
        logger.error('Security violation detected');
        redirectAttempted = true;
        redirectToSecurityWarning(data.warningUrl).catch((error) => {
            logger.error('Redirect failed:', error);
        });
    }
}

/**
 * Redirect to security warning page
 */
async function redirectToSecurityWarning(warningUrl) {
    try {
        logger.log('Redirecting to security warning:', warningUrl);
        window.location.href = warningUrl;
    } catch (error) {
        logger.error('Failed to redirect to security warning:', error);

        // Fallback: try to open in a new tab
        try {
            window.open(warningUrl, '_blank');
        } catch (fallbackError) {
            logger.error('Fallback redirect also failed:', fallbackError);
            alert('Security violation detected. Please navigate to: ' + warningUrl);
        }
    }
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
