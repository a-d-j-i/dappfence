/**
 * DappFence Main Entry Point
 * Detects context and initializes appropriate functionality
 */

import { initializeClient } from './client/sw-registration.js';
import { initializeServiceWorker } from './sw/main.js';

const isClient = typeof window !== 'undefined';
const isServiceWorker = !isClient;
// Initialize based on execution context
if (isClient) {
    // Start immediate SW initialization - no blocking
    console.log('%c[DappFence] Starting optimized SW registration', 'color:green');
    initializeClient().catch((err) => {
        console.error('[DappFence] SW initialization failed:', err);
    });
} else if (isServiceWorker) {
    initializeServiceWorker();
}
