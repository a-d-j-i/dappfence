import { describe, it, expect, vi } from 'vitest';

// `isFeatureEnabled` reads the Vite-injected `__FEATURES__` define, which
// isn't populated in the vitest runtime — stub it so `response.js`'s
// module-load evaluation of the feature flag doesn't throw.
vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn(() => false),
}));

import securityWarningHtml from '../../templates/security-warning.html?raw';
import { createBlockResponse, createNavigationWarningResponse } from '../response.js';

describe('createBlockResponse', () => {
    it('returns JS redirect when request targets the SW script', () => {
        const response = createBlockResponse(
            false,
            'https://example.com/sw.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('javascript');
    });

    it('returns HTML redirect for navigation requests', () => {
        const response = createBlockResponse(
            true,
            'https://example.com/app.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/html');
    });

    it('returns plain text warning for non-navigation subresource requests', () => {
        const response = createBlockResponse(
            false,
            'https://example.com/app.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });

    it('does not treat a cross-origin same-pathname URL as the SW script', () => {
        const response = createBlockResponse(
            false,
            'https://evil.com/sw.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });
});

describe('createNavigationWarningResponse', () => {
    it('returns a 302 redirect to the static warning page', () => {
        const response = createNavigationWarningResponse();
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/sw-api/security-warning');
    });
});

describe('security-warning template', () => {
    // `response.js` pre-slices the bundled template around this tag at module
    // load. A rename or removal of the id would make `createSecurityPageResponse`
    // render a warning page with an empty `DAPPFENCE_CONFIG` — this test fails
    // fast at dev time instead.
    it('contains the <script id="dappfence-config"> placeholder', () => {
        expect(securityWarningHtml).toMatch(/<script id="dappfence-config">[\s\S]*?<\/script>/);
    });
});

describe('createBlockResponse edge cases', () => {
    it('handles invalid locationHref gracefully in SW path check', () => {
        const response = createBlockResponse(
            false,
            'https://example.com/app.js',
            'not-a-valid-url'
        );
        expect(response.status).toBe(403);
    });
});
