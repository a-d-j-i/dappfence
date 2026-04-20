// XXX SW utility functions for testing importScripts verification
console.log('[SW Utils] Service worker utilities loaded');

// Example utility functions that might be imported by the app SW
function swLog(message) {
    console.log('[SW Utils]', message);
}

function swError(message) {
    console.error('[SW Utils]', message);
}

// Make functions globally available in SW scope
self.swLog = swLog;
self.swError = swError;
self.simpleAppStatus = () => 'simple app ready';
console.log('[SW Utils] Utility functions registered globally');
