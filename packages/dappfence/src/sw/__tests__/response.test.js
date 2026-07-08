import { describe, expect, it, vi } from 'vitest';
import securityWarningHtml from '../../templates/security-warning.html?raw';
import { createBlockResponse, createRedirectResponse, injectResponseHeaders } from '../response.js';
import { makeResponseWrapper } from '../manifest/html/response-wrapper.js';

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

// --- response-wrapper inject-at-head ---

function makeHtmlResponse(html, headers = {}) {
    return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
    });
}

async function readBody(response) {
    return new TextDecoder().decode(await response.arrayBuffer());
}

async function injectAndRead(html, injectionBytes, extraHeaders = {}) {
    const wrapper = makeResponseWrapper(makeHtmlResponse(html, extraHeaders));
    const violation = await wrapper.scanPreamble();
    if (violation) {
        return violation;
    }
    wrapper.injectAtHead(injectionBytes);
    return { response: wrapper.asResponse() };
}

describe('makeResponseWrapper — injectAtHead', () => {
    const injection = new TextEncoder().encode('<script id="injected"></script>');

    it('injects immediately after <head>', async () => {
        const html = '<!DOCTYPE html><html><head><title>App</title></head><body></body>';
        const { response } = await injectAndRead(html, injection);
        const body = await readBody(response);
        expect(body).toBe(
            '<!DOCTYPE html><html><head><script id="injected"></script><title>App</title></head><body></body>'
        );
    });

    it('injects after <head> with attributes', async () => {
        const html = '<!DOCTYPE html><head prefix="og: ...">';
        const { response } = await injectAndRead(html, injection);
        const body = await readBody(response);
        expect(body).toContain(
            '<!DOCTYPE html><head prefix="og: ..."><script id="injected"></script>'
        );
    });

    it('preserves response status and non-length headers', async () => {
        const html = '<!DOCTYPE html><head></head>';
        const wrapper = makeResponseWrapper(
            new Response(html, {
                status: 200,
                headers: { 'Content-Type': 'text/html', 'X-Custom': 'keep-me' },
            })
        );
        await wrapper.scanPreamble();
        wrapper.injectAtHead(injection);
        const response = wrapper.asResponse();
        expect(response.status).toBe(200);
        expect(response.headers.get('X-Custom')).toBe('keep-me');
    });

    it('adjusts Content-Length by the size of the injection', async () => {
        const html = '<!DOCTYPE html><head></head>';
        const { response } = await injectAndRead(html, injection, {
            'Content-Length': String(html.length),
        });
        expect(response.headers.get('Content-Length')).toBe(String(html.length + injection.length));
    });

    it('leaves Content-Length absent when the original response had none', async () => {
        const html = '<!DOCTYPE html><head></head>';
        const { response } = await injectAndRead(html, injection);
        expect(response.headers.get('Content-Length')).toBeNull();
    });

    it('works when the preamble spans multiple chunks', async () => {
        const full = '<!DOCTYPE html><html lang="en"><head><title>T</title></head>';
        const chunks = [];
        for (let i = 0; i < full.length; i += 10) {
            chunks.push(new TextEncoder().encode(full.slice(i, i + 10)));
        }
        const stream = new ReadableStream({
            start(controller) {
                for (const c of chunks) {
                    controller.enqueue(c);
                }
                controller.close();
            },
        });
        const wrapper = makeResponseWrapper(new Response(stream, { status: 200 }));
        await wrapper.scanPreamble();
        wrapper.injectAtHead(injection);
        const body = await readBody(wrapper.asResponse());
        expect(body).toContain('<head><script id="injected"></script><title>T</title>');
    });

    it('returns violation for a missing DOCTYPE', async () => {
        const html = '<html><head></head></html>';
        const result = await injectAndRead(html, injection);
        expect(result.status).toBeDefined();
        expect(result.response).toBeUndefined();
    });

    it('returns violation when the stream ends before <head>', async () => {
        const html = '<!DOCTYPE html><html lang="en">';
        const result = await injectAndRead(html, injection);
        expect(result.status).toBeDefined();
        expect(result.response).toBeUndefined();
    });
});
