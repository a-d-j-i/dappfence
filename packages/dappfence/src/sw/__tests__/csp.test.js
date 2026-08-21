import { describe, it, expect } from 'vitest';
import { buildCspHeader } from '../manifest/csp.js';
import { API } from '../../core/constants.js';

const REPORT_URI = `report-uri ${API.CSP_VIOLATION}`;
const NONCE = 'test-nonce-value';

// buildCspHeader now takes (fileKey, response, manifest, apiToken, nonce) and
// returns a Headers instance. `csp()` calls the helper with an empty-body
// response and returns the composed CSP header value so the existing
// string-oriented assertions still read cleanly.
const emptyResponse = () => new Response(null, { headers: new Headers() });
const csp = (manifest, fileKey = '/', apiToken, nonce = NONCE) =>
    buildCspHeader(fileKey, emptyResponse(), manifest, apiToken, nonce).get(
        'Content-Security-Policy'
    );

describe('buildCspHeader', () => {
    it('produces a minimal CSP when the manifest has no csp section', () => {
        const header = csp({});
        expect(header).toContain('script-src-elem');
        expect(header).toContain(`'nonce-${NONCE}'`);
        expect(header).toContain('*');
        expect(header).toContain("connect-src 'self'");
        expect(header).toContain("default-src 'none'");
        expect(header).toContain("object-src 'none'");
        expect(header).toContain("base-uri 'none'");
        expect(header).toContain("frame-ancestors 'none'");
        expect(header).toContain(REPORT_URI);
        expect(header).not.toContain('sha256-');
        expect(header).not.toContain('strict-dynamic');
    });

    it('produces the same minimal CSP when manifest is null', () => {
        const header = csp(null);
        expect(header).toContain(`'nonce-${NONCE}'`);
        expect(header).toContain('*');
        expect(header).not.toContain('sha256-');
    });

    it('appends connectOrigins to connect-src', () => {
        const manifest = {
            csp: { connectOrigins: ['https://api.example.com', 'wss://ws.example.com'] },
        };
        const header = csp(manifest);
        expect(header).toContain('https://api.example.com');
        expect(header).toContain('wss://ws.example.com');
        expect(header).toMatch(
            /connect-src 'self' https:\/\/api\.example\.com wss:\/\/ws\.example\.com/
        );
    });

    it('adds nonce first, then hashes, then * in script-src-elem', () => {
        const manifest = {
            csp: { pages: { '/': ['sha256-abc123', 'sha256-def456'] } },
        };
        const header = csp(manifest);
        expect(header).toContain(
            `script-src-elem 'nonce-${NONCE}' 'sha256-abc123' 'sha256-def456' *`
        );
        expect(header).not.toContain('strict-dynamic');
    });

    it('emits only nonce + * when the pageKey has no inline hashes', () => {
        const manifest = {
            csp: { pages: { '/other': ['sha256-abc123'] } },
        };
        const header = csp(manifest);
        expect(header).toContain(`script-src-elem 'nonce-${NONCE}' *`);
        expect(header).not.toContain('sha256-');
    });

    it('uses the correct pageKey to look up inline hashes', () => {
        const manifest = {
            csp: {
                pages: {
                    '/page-a': ['sha256-hash-a'],
                    '/page-b': ['sha256-hash-b'],
                },
            },
        };
        const headerA = csp(manifest, '/page-a');
        const headerB = csp(manifest, '/page-b');
        expect(headerA).toContain("'sha256-hash-a'");
        expect(headerA).not.toContain("'sha256-hash-b'");
        expect(headerB).toContain("'sha256-hash-b'");
        expect(headerB).not.toContain("'sha256-hash-a'");
    });

    it('always includes the report-uri directive', () => {
        expect(csp({})).toContain(REPORT_URI);
        expect(csp(null)).toContain(REPORT_URI);
        expect(csp({ csp: { pages: { '/': ['sha256-h'] } } })).toContain(REPORT_URI);
    });

    it('appends token as query param on report-uri when provided', () => {
        const header = csp({}, '/', 'my-secret-token');
        expect(header).toContain(`${API.CSP_VIOLATION}?token=my-secret-token`);
    });

    it('uses bare report-uri when no token is provided', () => {
        const header = csp({});
        expect(header).toContain(`report-uri ${API.CSP_VIOLATION}`);
        expect(header).not.toContain('?token=');
    });

    it('encodes special characters in the token', () => {
        const header = csp({}, '/', 'tok en+special=chars');
        expect(header).toContain('token=tok%20en%2Bspecial%3Dchars');
    });
});

describe('buildCspHeader — script-src-attr (on* attribute hashes)', () => {
    it('omits script-src-attr when the page entry is an array (legacy format)', () => {
        const manifest = { csp: { pages: { '/': ['sha256-abc'] } } };
        expect(csp(manifest)).not.toContain('script-src-attr');
    });

    it('omits script-src-attr when the page entry has no attrs', () => {
        const manifest = { csp: { pages: { '/': { scripts: ['sha256-abc'], attrs: [] } } } };
        expect(csp(manifest)).not.toContain('script-src-attr');
    });

    it('omits script-src-attr when there is no page entry', () => {
        expect(csp({})).not.toContain('script-src-attr');
    });

    it('emits script-src-attr with unsafe-hashes when attrs are present', () => {
        const manifest = {
            csp: { pages: { '/': { scripts: [], attrs: ['sha256-h1', 'sha256-h2'] } } },
        };
        expect(csp(manifest)).toContain("script-src-attr 'unsafe-hashes' 'sha256-h1' 'sha256-h2'");
    });

    it('script-src-elem still uses scripts from object format', () => {
        const manifest = {
            csp: {
                pages: { '/': { scripts: ['sha256-script'], attrs: ['sha256-attr'] } },
            },
        };
        const header = csp(manifest);
        expect(header).toContain("'sha256-script'");
        expect(header).toContain('script-src-elem');
        expect(header).toContain("script-src-attr 'unsafe-hashes' 'sha256-attr'");
    });

    it('script-src-attr appears between script-src-elem and style-src', () => {
        const manifest = {
            csp: { pages: { '/': { scripts: [], attrs: ['sha256-h'] } } },
        };
        const directives = csp(manifest).split('; ');
        const elemIdx = directives.findIndex((d) => d.startsWith('script-src-elem'));
        const attrIdx = directives.findIndex((d) => d.startsWith('script-src-attr'));
        const styleIdx = directives.findIndex((d) => d.startsWith('style-src'));
        expect(attrIdx).toBeGreaterThan(elemIdx);
        expect(attrIdx).toBeLessThan(styleIdx);
    });
});

describe('buildCspHeader — origin CSP stripping', () => {
    it('strips origin Content-Security-Policy and replaces with the built policy', () => {
        // Origin sends attacker-controlled directives; DappFence must replace,
        // not merge. Note: DappFence's own policy has `style-src 'unsafe-inline'`
        // (comment in csp.js explains why it's safe for styles), so we assert
        // on specific origin fragments that must not survive rather than a
        // blanket "no 'unsafe-inline'".
        const response = new Response(null, {
            headers: new Headers({
                'Content-Security-Policy':
                    "script-src 'unsafe-inline' 'unsafe-eval'; frame-ancestors *",
            }),
        });
        const headers = buildCspHeader('/', response, {}, undefined, NONCE);
        const csp = headers.get('Content-Security-Policy');
        expect(csp).not.toContain("'unsafe-eval'"); // origin used, DappFence never does
        expect(csp).not.toContain("script-src '"); // DappFence emits script-src-elem, not script-src
        expect(csp).not.toContain('frame-ancestors *'); // origin's permissive frame-ancestors gone
        expect(csp).toContain(`'nonce-${NONCE}'`);
        expect(csp).toContain("frame-ancestors 'none'"); // DappFence's replacement
    });

    it('strips origin Content-Security-Policy-Report-Only', () => {
        const response = new Response(null, {
            headers: new Headers({
                'Content-Security-Policy-Report-Only': "script-src 'unsafe-inline'",
            }),
        });
        const headers = buildCspHeader('/', response, {}, undefined, NONCE);
        expect(headers.get('Content-Security-Policy-Report-Only')).toBeNull();
    });

    it('preserves other origin headers', () => {
        const response = new Response(null, {
            headers: new Headers({
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': "script-src 'none'",
            }),
        });
        const headers = buildCspHeader('/', response, {}, undefined, NONCE);
        expect(headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        expect(headers.get('Cache-Control')).toBe('no-store');
    });
});
