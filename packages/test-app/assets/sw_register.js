///////////////// MAIN
function log(...args) {
    // window.pageId is injected by playwright fixtures
    console.log('%c[Simple App SW APP Client]', 'color:yellow', `(${window.pageId})`, ...args);
}
log('Main, client app loaded start');

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        log('The service worker sent me a message:', event.data);
    });

    navigator.serviceWorker.ready.then((registration) => {
        log('service worker ready event', registration);
        registration.active.postMessage('Hi service worker');
    });

    // Add some id to be able to track the SW registration
    const script = document.currentScript;
    const scriptUrl = 'sw_app.js' + (script.dataset.id ? `?data=${script.dataset.id}` : '');
    navigator.serviceWorker
        .register(scriptUrl, {
            updateViaCache: 'none',
        })
        .then((registration) => {
            let serviceWorker;
            if (registration.installing) {
                serviceWorker = registration.installing;
                log('Service worker registered installing', serviceWorker.scriptURL);
            } else if (registration.waiting) {
                serviceWorker = registration.waiting;
                log('Service worker registered waiting', serviceWorker.scriptURL);
            } else if (registration.active) {
                serviceWorker = registration.active;
                log('Service worker registered active', serviceWorker.scriptURL);
            } else {
                log('Service worker registered but no active worker found.');
            }
            if (serviceWorker) {
                serviceWorker.addEventListener('statechange', (e) => {
                    log('statechange', e.target.state, e.target.scriptURL);
                });
            } else {
                log('No service worker found');
            }
        })
        .catch((err) => {
            console.error('[SW APP] Service worker registration failed:', err);
        });
} else {
    console.warn('Service Worker api unsupported');
}

log('Main, client app loaded done');
