import { describe, expect, it, vi } from 'vitest';
import securityWarningHtml from '../../templates/security-warning.html?raw';
import { createBlockResponse, createRedirectResponse, injectResponseHeaders } from '../response.js';

// `isFeatureEnabled` reads the Vite-injected `__FEATURES__` define, which
// isn't populated in the vitest runtime — stub it so `response.js`'s
// module-load evaluation of the feature flag doesn't throw.
vi.mock('../../core/utils.js', () => ({
    isFeatureEnabled: vi.fn(() => false),
}));

describe('createBlockResponse', () => {
    it('returns JS redirect when request targets the SW script', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://example.com/sw.js' },
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('javascript');
    });

    it('returns 302 redirect to the warning page for navigation requests', () => {
        const response = createBlockResponse(
            { mode: 'navigate', url: 'https://example.com/app.js' },
            'https://example.com/sw.js'
        );
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/sw-api/security-warning');
    });

    it('returns plain text warning for non-navigation subresource requests', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://example.com/app.js' },
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });

    it('does not treat a cross-origin same-pathname URL as the SW script', () => {
        const response = createBlockResponse(
            { mode: 'no-cors', url: 'https://evil.com/sw.js' },
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });
});

describe('createRedirectResponse', () => {
    it('returns a 302 redirect with no-cache headers', () => {
        const response = createRedirectResponse('/some/path');
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/some/path');
        expect(response.headers.get('Cache-Control')).toContain('no-cache');
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
            { mode: 'no-cors', url: 'https://example.com/app.js' },
            'not-a-valid-url'
        );
        expect(response.status).toBe(403);
    });
});

describe('injectResponseHeaders', () => {
    function makeResponse(headers = {}, status = 200) {
        return new Response('body', { status, headers });
    }

    it('sets new headers on the response', async () => {
        const base = makeResponse();
        const result = injectResponseHeaders(base, { 'X-Custom': 'value' });
        expect(result.headers.get('X-Custom')).toBe('value');
    });

    it('preserves existing headers from the original response', async () => {
        const base = makeResponse({ 'Content-Type': 'text/html' });
        const result = injectResponseHeaders(base, { 'X-Custom': 'added' });
        expect(result.headers.get('Content-Type')).toBe('text/html');
        expect(result.headers.get('X-Custom')).toBe('added');
    });

    it('appends CSP headers rather than overwriting', async () => {
        const base = makeResponse({ 'Content-Security-Policy': "default-src 'self'" });
        const result = injectResponseHeaders(base, {
            'Content-Security-Policy': "script-src 'none'",
        });
        const values = result.headers.getSetCookie
            ? result.headers.get('Content-Security-Policy')
            : result.headers.get('Content-Security-Policy');
        // Headers.append produces a comma-joined string when retrieved via .get()
        expect(values).toContain("default-src 'self'");
        expect(values).toContain("script-src 'none'");
    });

    it('overwrites non-CSP headers with set', async () => {
        const base = makeResponse({ 'X-Frame-Options': 'SAMEORIGIN' });
        const result = injectResponseHeaders(base, { 'X-Frame-Options': 'DENY' });
        expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('preserves status and statusText from the original response', async () => {
        const base = new Response('body', { status: 404, statusText: 'Not Found' });
        const result = injectResponseHeaders(base, { 'X-Custom': 'v' });
        expect(result.status).toBe(404);
        expect(result.statusText).toBe('Not Found');
    });

    it('handles uppercase CSP header name the same as lowercase', async () => {
        const base = makeResponse({ 'Content-Security-Policy': "default-src 'self'" });
        const result = injectResponseHeaders(base, {
            'CONTENT-SECURITY-POLICY': "script-src 'none'",
        });
        const csp = result.headers.get('Content-Security-Policy');
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'none'");
    });

    it.each([
        'Content-Security-Policy-Report-Only',
        'Permissions-Policy',
        'Reporting-Endpoints',
        'Report-To',
    ])('appends %s rather than overwriting', async (headerName) => {
        const base = makeResponse({ [headerName]: 'existing-value' });
        const result = injectResponseHeaders(base, { [headerName]: 'injected-value' });
        const value = result.headers.get(headerName);
        expect(value).toContain('existing-value');
        expect(value).toContain('injected-value');
    });
});
