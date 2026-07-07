import { describe, it, expect } from 'vitest';
import { buildCspHeader } from '../manifest/csp.js';
import { API } from '../../core/constants.js';

const REPORT_URI = `report-uri ${API.CSP_VIOLATION}`;

describe('buildCspHeader', () => {
    it('produces a minimal CSP when the manifest has no csp section', () => {
        const header = buildCspHeader({}, '/');
        expect(header).toContain('script-src-elem *');
        expect(header).toContain("connect-src 'self'");
        expect(header).toContain("default-src 'none'");
        expect(header).toContain("object-src 'none'");
        expect(header).toContain("base-uri 'self'");
        expect(header).toContain("frame-ancestors 'none'");
        expect(header).toContain(REPORT_URI);
        expect(header).not.toContain('sha256-');
        expect(header).not.toContain('strict-dynamic');
    });

    it('produces the same minimal CSP when manifest is null', () => {
        const header = buildCspHeader(null, '/');
        expect(header).toContain('script-src-elem *');
        expect(header).not.toContain('sha256-');
    });

    it('appends connectOrigins to connect-src', () => {
        const manifest = {
            csp: { connectOrigins: ['https://api.example.com', 'wss://ws.example.com'] },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain('https://api.example.com');
        expect(header).toContain('wss://ws.example.com');
        expect(header).toMatch(
            /connect-src 'self' https:\/\/api\.example\.com wss:\/\/ws\.example\.com/
        );
    });

    it('adds hashes before * in script-src-elem when the pageKey has inline hashes', () => {
        const manifest = {
            csp: { pages: { '/': ['sha256-abc123', 'sha256-def456'] } },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain("'sha256-abc123'");
        expect(header).toContain("'sha256-def456'");
        expect(header).toContain('*');
        expect(header).not.toContain('strict-dynamic');
    });

    it('uses * without hashes when the pageKey has no inline hashes', () => {
        const manifest = {
            csp: { pages: { '/other': ['sha256-abc123'] } },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain('script-src-elem *');
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
        const headerA = buildCspHeader(manifest, '/page-a');
        const headerB = buildCspHeader(manifest, '/page-b');
        expect(headerA).toContain("'sha256-hash-a'");
        expect(headerA).not.toContain("'sha256-hash-b'");
        expect(headerB).toContain("'sha256-hash-b'");
        expect(headerB).not.toContain("'sha256-hash-a'");
    });

    it('always includes the report-uri directive', () => {
        expect(buildCspHeader({}, '/')).toContain(REPORT_URI);
        expect(buildCspHeader(null, '/')).toContain(REPORT_URI);
        expect(buildCspHeader({ csp: { pages: { '/': ['sha256-h'] } } }, '/')).toContain(
            REPORT_URI
        );
    });

    it('appends token as query param on report-uri when provided', () => {
        const header = buildCspHeader({}, '/', 'my-secret-token');
        expect(header).toContain(`${API.CSP_VIOLATION}?token=my-secret-token`);
    });

    it('uses bare report-uri when no token is provided', () => {
        const header = buildCspHeader({}, '/');
        expect(header).toContain(`report-uri ${API.CSP_VIOLATION}`);
        expect(header).not.toContain('?token=');
    });

    it('encodes special characters in the token', () => {
        const header = buildCspHeader({}, '/', 'tok en+special=chars');
        expect(header).toContain('token=tok%20en%2Bspecial%3Dchars');
    });
});

describe('buildCspHeader — script-src-attr (on* attribute hashes)', () => {
    it('omits script-src-attr when the page entry is an array (legacy format)', () => {
        const manifest = { csp: { pages: { '/': ['sha256-abc'] } } };
        const header = buildCspHeader(manifest, '/');
        expect(header).not.toContain('script-src-attr');
    });

    it('omits script-src-attr when the page entry has no attrs', () => {
        const manifest = { csp: { pages: { '/': { scripts: ['sha256-abc'], attrs: [] } } } };
        const header = buildCspHeader(manifest, '/');
        expect(header).not.toContain('script-src-attr');
    });

    it('omits script-src-attr when there is no page entry', () => {
        const header = buildCspHeader({}, '/');
        expect(header).not.toContain('script-src-attr');
    });

    it('emits script-src-attr with unsafe-hashes when attrs are present', () => {
        const manifest = {
            csp: { pages: { '/': { scripts: [], attrs: ['sha256-h1', 'sha256-h2'] } } },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain("script-src-attr 'unsafe-hashes' 'sha256-h1' 'sha256-h2'");
    });

    it('script-src-elem still uses scripts from object format', () => {
        const manifest = {
            csp: {
                pages: { '/': { scripts: ['sha256-script'], attrs: ['sha256-attr'] } },
            },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain("'sha256-script'");
        expect(header).toContain('script-src-elem');
        expect(header).toContain("script-src-attr 'unsafe-hashes' 'sha256-attr'");
    });

    it('script-src-attr appears between script-src-elem and style-src', () => {
        const manifest = {
            csp: { pages: { '/': { scripts: [], attrs: ['sha256-h'] } } },
        };
        const directives = buildCspHeader(manifest, '/').split('; ');
        const elemIdx = directives.findIndex((d) => d.startsWith('script-src-elem'));
        const attrIdx = directives.findIndex((d) => d.startsWith('script-src-attr'));
        const styleIdx = directives.findIndex((d) => d.startsWith('style-src'));
        expect(attrIdx).toBeGreaterThan(elemIdx);
        expect(attrIdx).toBeLessThan(styleIdx);
    });
});
