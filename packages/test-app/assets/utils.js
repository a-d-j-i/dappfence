// Utility functions for the simple app
console.log('[SimpleApp Utils] Utility module loaded');

// Time formatting utility
export function formatTimestamp(date = new Date()) {
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

// Security info helper
export function getSecurityInfo() {
    return {
        timestamp: formatTimestamp(),
        userAgent: navigator.userAgent.substring(0, 50) + '...',
        origin: window.location.origin,
        protocol: window.location.protocol,
        serviceWorkerSupported: 'serviceWorker' in navigator,
    };
}

// DOM helper functions
export function createStatusElement(title, content, type = 'info') {
    const colors = {
        success: '#d4edda',
        warning: '#fff3cd',
        error: '#f8d7da',
        info: '#d1ecf1',
    };

    const div = document.createElement('div');
    div.style.cssText = `
        background: ${colors[type] || colors.info};
        border: 1px solid ${type === 'success' ? '#c3e6cb' : type === 'warning' ? '#ffeaa7' : type === 'error' ? '#f5c6cb' : '#bee5eb'};
        border-radius: 4px;
        padding: 10px;
        margin: 10px 0;
    `;
    div.innerHTML = `<strong>${title}:</strong> ${content}`;
    return div;
}

console.log(
    '[SimpleApp Utils] Exported utilities: formatTimestamp, getSecurityInfo, createStatusElement'
);
