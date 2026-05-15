import { describe, it, expect } from 'vitest';
import { applyStrips } from '../manifest/strips.js';

const encode = (str) => new TextEncoder().encode(str);
const decode = (buf) => new TextDecoder().decode(buf);

const NETLIFY_SNIPPET = (deployId = 'aabbccdd', siteId = '00000000-0000-0000-0000-000000000000') =>
    `<div data-netlify-deploy-id="${deployId}" data-netlify-site-id="${siteId}" data-vcs="github" style="position:fixed">\n  \n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;

const HTML = (extra = '') => `<!DOCTYPE html><html><body><p>Hello</p>${extra}</body></html>`;

describe('applyStrips', () => {
    describe('no-op cases', () => {
        it('returns the original buffer when ruleNames is empty', () => {
            const buf = encode(HTML());
            expect(applyStrips(buf, [], '/index.html')).toBe(buf);
        });

        it('returns the original buffer when ruleNames is null', () => {
            const buf = encode(HTML());
            expect(applyStrips(buf, null, '/index.html')).toBe(buf);
        });

        it('returns the original buffer for unknown rule names', () => {
            const buf = encode(HTML());
            expect(applyStrips(buf, ['unknown-cdn'], '/index.html')).toBe(buf);
        });

        it('does not apply html rules to non-html files', () => {
            const buf = encode('body { color: red; }');
            expect(applyStrips(buf, ['netlify-cdp'], '/styles.css')).toBe(buf);
        });

        it('does not apply html rules to js files', () => {
            const buf = encode('console.log("hello")');
            expect(applyStrips(buf, ['netlify-cdp'], '/app.js')).toBe(buf);
        });

        it('does not apply html rules to extensionless path when not a navigation request', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            expect(applyStrips(buf, ['netlify-cdp'], '/')).toBe(buf);
        });
    });

    describe('navigation remapping', () => {
        it('applies html rules to "/" when isNavigation is true', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/', true));
            expect(result).toBe(HTML());
        });

        it('applies html rules to extensionless "/docs" when isNavigation is true', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/docs', true));
            expect(result).toBe(HTML());
        });

        it('applies html rules to trailing-slash "/docs/" when isNavigation is true', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/docs/', true));
            expect(result).toBe(HTML());
        });

        it('does not remap "/index.html" even when isNavigation is true', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html', true));
            expect(result).toBe(HTML());
        });
    });

    describe('netlify-cdp rule', () => {
        it('strips the Netlify CDP snippet from an html file', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toBe(HTML());
        });

        it('applies to .htm files as well', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET()));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/page.htm'));
            expect(result).toBe(HTML());
        });

        it('strips with any valid hex deploy id', () => {
            const buf = encode(HTML(NETLIFY_SNIPPET('deadbeef0123456789abcdef')));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toBe(HTML());
        });

        it('handles the snippet anywhere in the document', () => {
            const html = `<!DOCTYPE html><html><head></head><body>${NETLIFY_SNIPPET()}<p>content</p></body></html>`;
            const result = decode(applyStrips(encode(html), ['netlify-cdp'], '/index.html'));
            expect(result).not.toContain('data-netlify-deploy-id');
            expect(result).toContain('<p>content</p>');
        });

        it('does not strip when deploy id contains non-hex characters', () => {
            const snippet = `<div data-netlify-deploy-id="gg-invalid!!" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when site id is not a valid UUID', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="not-a-uuid" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when data-vcs is not "github"', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="malicious" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when style attribute differs', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:absolute">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when extra content is hidden inside the div', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><script>evil()</script><script async src="/.netlify/scripts/cdp"></script></div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when the cdp script src differs', () => {
            const snippet = `<div data-netlify-deploy-id="aabbccdd" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  <script async src="/evil/script.js"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });

        it('does not strip when attribute order differs', () => {
            const snippet = `<div data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-netlify-deploy-id="aabbccdd" data-vcs="github" style="position:fixed">\n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
            const buf = encode(HTML(snippet));
            const result = decode(applyStrips(buf, ['netlify-cdp'], '/index.html'));
            expect(result).toContain('data-netlify-deploy-id');
        });
    });
});
