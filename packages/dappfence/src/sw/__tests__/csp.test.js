import { describe, it, expect } from 'vitest';
import { buildCspHeader } from '../manifest/csp.js';
import { API } from '../../core/constants.js';

const REPORT_URI = `report-uri ${API.CSP_VIOLATION}`;

describe('buildCspHeader', () => {
    it('produces a minimal CSP when the manifest has no csp section', () => {
        const header = buildCspHeader({}, '/');
        expect(header).toContain("script-src 'self'");
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
        expect(header).toContain("script-src 'self'");
        expect(header).not.toContain('sha256-');
    });

    it('appends scriptOrigins to script-src', () => {
        const manifest = {
            csp: { scriptOrigins: ['https://cdn.example.com', 'https://scripts.example.com'] },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain('https://cdn.example.com');
        expect(header).toContain('https://scripts.example.com');
        expect(header).toMatch(
            /script-src 'self' https:\/\/cdn\.example\.com https:\/\/scripts\.example\.com/
        );
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

    it('adds hashes and strict-dynamic when the pageKey has inline hashes', () => {
        const manifest = {
            csp: { pages: { '/': ['sha256-abc123', 'sha256-def456'] } },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).toContain("'sha256-abc123'");
        expect(header).toContain("'sha256-def456'");
        expect(header).toContain("'strict-dynamic'");
    });

    it('does not add strict-dynamic when the pageKey has no inline hashes', () => {
        const manifest = {
            csp: { pages: { '/other': ['sha256-abc123'] } },
        };
        const header = buildCspHeader(manifest, '/');
        expect(header).not.toContain('sha256-');
        expect(header).not.toContain('strict-dynamic');
    });

    it('combines scriptOrigins and inline hashes in script-src', () => {
        const manifest = {
            csp: {
                scriptOrigins: ['https://cdn.example.com'],
                pages: { '/app': ['sha256-hashval'] },
            },
        };
        const header = buildCspHeader(manifest, '/app');
        expect(header).toContain('https://cdn.example.com');
        expect(header).toContain("'sha256-hashval'");
        expect(header).toContain("'strict-dynamic'");
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
        expect(buildCspHeader({ csp: { pages: { '/': ['sha256-h'] } } }, '/')).toContain(REPORT_URI);
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
