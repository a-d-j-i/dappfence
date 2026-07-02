import { describe, it, expect } from 'vitest';
import { TRANSFORMS } from '../manifest/html/transforms.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Apply a named transform to a plain HTML string and return the stripped string.
function applyPattern(name, text) {
    const bytes = enc.encode(text);
    const ranges = TRANSFORMS[name].findStripRanges(bytes);
    if (ranges.length === 0) return text;
    const parts = [];
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (cursor < start) parts.push(bytes.subarray(cursor, start));
        cursor = end;
    }
    if (cursor < bytes.length) parts.push(bytes.subarray(cursor));
    const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return dec.decode(result);
}

const NETLIFY_SNIPPET = (deployId = 'aabbccdd', siteId = '00000000-0000-0000-0000-000000000000') =>
    `<div data-netlify-deploy-id="${deployId}" data-netlify-site-id="${siteId}" data-vcs="github" style="position:fixed">\n  \n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;

const HTML = (extra = '') => `<!DOCTYPE html><html><body><p>Hello</p>${extra}</body></html>`;

// ── TRANSFORMS ────────────────────────────────────────────────────────────────

describe('TRANSFORMS', () => {
    describe('unknown transform', () => {
        it('is undefined for unknown transform names', () => {
            expect(TRANSFORMS['unknown-cdn']).toBeUndefined();
        });
    });

    describe('netlify-cdp transform', () => {
        it('strips the Netlify CDP snippet from an HTML document', () => {
            expect(applyPattern('netlify-cdp', HTML(NETLIFY_SNIPPET()))).toBe(HTML());
        });

        it('applies to .htm content as well (content-agnostic)', () => {
            expect(applyPattern('netlify-cdp', HTML(NETLIFY_SNIPPET()))).toBe(HTML());
        });

        it('strips with any valid hex deploy id', () => {
            expect(
                applyPattern('netlify-cdp', HTML(NETLIFY_SNIPPET('deadbeef0123456789abcdef')))
            ).toBe(HTML());
        });

        it('handles the snippet anywhere in the document', () => {
            const html = `<!DOCTYPE html><html><head></head><body>${NETLIFY_SNIPPET()}<p>content</p></body></html>`;
            const result = applyPattern('netlify-cdp', html);
            expect(result).not.toContain('data-netlify-deploy-id');
            expect(result).toContain('<p>content</p>');
        });

        it('does not strip when deploy id contains non-hex characters', () => {
            const snippet = `<div data-netlify-deploy-id="gg-invalid!!" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when site id is not a valid UUID', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="not-a-uuid" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when data-vcs is not "github"', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="malicious" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when style attribute differs', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:absolute">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when the div contains an extra inline script', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><script>evil()</script><script async src="/.netlify/scripts/cdp"></script></div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when the cdp script has inline content', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><script async src="/.netlify/scripts/cdp">evil()</script></div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when the cdp script src differs', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/evil/script.js"></script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when the div contains extra elements', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><span>injected</span><script async src="/.netlify/scripts/cdp"></script></div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        // Attribute order does not matter — the tokenizer builds an attrs object
        // regardless of order, matching correct HTML semantics.
        it('strips correctly when attribute order differs', () => {
            const snippet = `<div data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-netlify-deploy-id="aabbccdd" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toBe(HTML());
        });

        it('does not strip when cdp script has inline content', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp">alert(1)</script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('does not strip when div contains extra elements after the cdp script', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n  <script>extra()</script>\n</div>`;
            expect(applyPattern('netlify-cdp', HTML(snippet))).toContain('data-netlify-deploy-id');
        });

        it('no-ops when snippet is absent (returns same content)', () => {
            expect(applyPattern('netlify-cdp', HTML())).toBe(HTML());
        });

        it('does not apply to non-HTML content (script bytes still processed)', () => {
            expect(applyPattern('netlify-cdp', 'console.log("hello")')).toBe(
                'console.log("hello")'
            );
        });
    });
});
