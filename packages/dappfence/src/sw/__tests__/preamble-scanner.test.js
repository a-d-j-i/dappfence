import { describe, it, expect } from 'vitest';
import { createPreambleScanner } from '../manifest/html/preamble-scanner.js';

function enc(str) {
    return new TextEncoder().encode(str);
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const UTF16_LE_BOM = new Uint8Array([0xff, 0xfe]);
const UTF16_BE_BOM = new Uint8Array([0xfe, 0xff]);

// Returns the offset right after '>' in the input string (the injection point).
function offsetAfter(str, tag = '<head>') {
    const idx = str.indexOf(tag);
    return idx + tag.length;
}

// One-shot helper: push a single chunk into a fresh scanner.
function scan(buf) {
    return createPreambleScanner().push(buf);
}

// --- Happy path ---

describe('scanPreamble — happy path', () => {
    it('minimal valid preamble: DOCTYPE + head', () => {
        const input = '<!DOCTYPE html><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('DOCTYPE + html + head', () => {
        const input = '<!DOCTYPE html><html><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('html tag with attributes', () => {
        const input = '<!DOCTYPE html><html lang="en" dir="ltr"><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('head tag with attributes', () => {
        const input = '<!DOCTYPE html><head prefix="og: http://ogp.me/ns#">';
        expect(scan(enc(input))).toBe(input.length);
    });

    it('whitespace between tokens', () => {
        const input = '<!DOCTYPE html>\n\n<html lang="en">\n  <head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('comment before DOCTYPE', () => {
        const input = '<!-- site comment --><!DOCTYPE html><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('comment between DOCTYPE and head', () => {
        const input = '<!DOCTYPE html><!-- build: 2026-07-07 --><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('comment between html and head', () => {
        const input = '<!DOCTYPE html><html><!-- comment --><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('processing instruction', () => {
        const input = '<?xml version="1.0"?><!DOCTYPE html><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('bogus comment', () => {
        const input = '<!CDATA bogus><!DOCTYPE html><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('UTF-8 BOM', () => {
        const rest = enc('<!DOCTYPE html><head>');
        const buf = new Uint8Array(UTF8_BOM.length + rest.length);
        buf.set(UTF8_BOM);
        buf.set(rest, UTF8_BOM.length);
        expect(scan(buf)).toBe(UTF8_BOM.length + rest.length);
    });

    it('uppercase DOCTYPE and HEAD tags', () => {
        const input = '<!DOCTYPE HTML><HTML><HEAD>';
        expect(scan(enc(input))).toBe(input.length);
    });

    it('mixed-case DOCTYPE', () => {
        const input = '<!doctype html><head>';
        expect(scan(enc(input))).toBe(input.length);
    });

    it('html tag with single-quoted attribute', () => {
        const input = "<!DOCTYPE html><html lang='en'><head>";
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('> inside a quoted attribute does not end the tag early', () => {
        const input = '<!DOCTYPE html><html data-x="a>b"><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('self-closing slash on html tag is ignored', () => {
        const input = '<!DOCTYPE html><html /><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('legacy DOCTYPE string', () => {
        const input =
            '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><head>';
        expect(scan(enc(input))).toBe(offsetAfter(input));
    });

    it('returns offset into the middle of a larger buffer', () => {
        const head = '<!DOCTYPE html><head>';
        const body = '<meta charset="utf-8"><title>App</title></head><body>';
        const buf = enc(head + body);
        expect(scan(buf)).toBe(head.length);
    });
});

// --- Partial data (returns null) ---

describe('scanPreamble — partial data returns null', () => {
    it('empty buffer', () => {
        expect(scan(enc(''))).toBeNull();
    });

    it('only UTF-8 BOM (1 or 2 bytes)', () => {
        expect(scan(UTF8_BOM.slice(0, 1))).toBeNull();
        expect(scan(UTF8_BOM.slice(0, 2))).toBeNull();
    });

    it('incomplete DOCTYPE: <!DOC', () => {
        expect(scan(enc('<!DOC'))).toBeNull();
    });

    it('DOCTYPE with no closing >', () => {
        expect(scan(enc('<!DOCTYPE html'))).toBeNull();
    });

    it('DOCTYPE complete but nothing after it yet', () => {
        expect(scan(enc('<!DOCTYPE html>'))).toBeNull();
    });

    it('incomplete html tag name: <htm', () => {
        expect(scan(enc('<!DOCTYPE html><htm'))).toBeNull();
    });

    it('html tag without closing >', () => {
        expect(scan(enc('<!DOCTYPE html><html lang="en"'))).toBeNull();
    });

    it('incomplete head tag name: <hea', () => {
        expect(scan(enc('<!DOCTYPE html><hea'))).toBeNull();
    });

    it('head tag without closing >', () => {
        expect(scan(enc('<!DOCTYPE html><head'))).toBeNull();
    });

    it('buffer ends with < (start of unknown token)', () => {
        expect(scan(enc('<!DOCTYPE html><'))).toBeNull();
    });

    it('unclosed comment (no --> yet)', () => {
        expect(scan(enc('<!DOCTYPE html><!-- in progress'))).toBeNull();
    });

    it('comment with -- but no > yet', () => {
        expect(scan(enc('<!DOCTYPE html><!-- almost --'))).toBeNull();
    });

    it('incomplete PI: <?xml', () => {
        expect(scan(enc('<?xml'))).toBeNull();
    });

    it('incomplete bang token: <!', () => {
        expect(scan(enc('<!DOCTYPE html><!'))).toBeNull();
    });
});

// --- Violations ---

describe('scanPreamble — violations', () => {
    it('UTF-16 LE BOM', () => {
        const buf = new Uint8Array(UTF16_LE_BOM.length + enc('<!DOCTYPE html><head>').length);
        buf.set(UTF16_LE_BOM);
        buf.set(enc('<!DOCTYPE html><head>'), UTF16_LE_BOM.length);
        expect(scan(buf)).toHaveProperty('violation');
    });

    it('UTF-16 BE BOM', () => {
        const buf = new Uint8Array(UTF16_BE_BOM.length + enc('<!DOCTYPE html><head>').length);
        buf.set(UTF16_BE_BOM);
        buf.set(enc('<!DOCTYPE html><head>'), UTF16_BE_BOM.length);
        expect(scan(buf)).toHaveProperty('violation');
    });

    it('null byte between tokens', () => {
        const nul = new Uint8Array([0x00]);
        const buf = new Uint8Array(enc('<!DOCTYPE html>').length + 1 + enc('<head>').length);
        buf.set(enc('<!DOCTYPE html>'));
        buf.set(nul, enc('<!DOCTYPE html>').length);
        buf.set(enc('<head>'), enc('<!DOCTYPE html>').length + 1);
        expect(scan(buf)).toHaveProperty('violation');
    });

    it('null byte inside a comment', () => {
        const before = enc('<!DOCTYPE html><!-- ');
        const nul = new Uint8Array([0x00]);
        const after = enc(' --><head>');
        const buf = new Uint8Array(before.length + 1 + after.length);
        buf.set(before);
        buf.set(nul, before.length);
        buf.set(after, before.length + 1);
        expect(scan(buf)).toHaveProperty('violation');
    });

    it('null byte inside a tag', () => {
        const before = enc('<!DOCTYPE html><html ');
        const nul = new Uint8Array([0x00]);
        const after = enc('><head>');
        const buf = new Uint8Array(before.length + 1 + after.length);
        buf.set(before);
        buf.set(nul, before.length);
        buf.set(after, before.length + 1);
        expect(scan(buf)).toHaveProperty('violation');
    });

    it('missing DOCTYPE — bare <head>', () => {
        expect(scan(enc('<head>'))).toHaveProperty('violation');
    });

    it('missing DOCTYPE — html then head', () => {
        expect(scan(enc('<html><head>'))).toHaveProperty('violation');
    });

    it('unexpected element before head: <body>', () => {
        expect(scan(enc('<!DOCTYPE html><body>'))).toHaveProperty('violation');
    });

    it('unexpected element before head: <script>', () => {
        expect(scan(enc('<!DOCTYPE html><script>'))).toHaveProperty('violation');
    });

    it('unexpected element before head: <meta>', () => {
        expect(scan(enc('<!DOCTYPE html><meta>'))).toHaveProperty('violation');
    });

    it('closing tag before head', () => {
        expect(scan(enc('<!DOCTYPE html></html><head>'))).toHaveProperty('violation');
    });

    it('duplicate html tag', () => {
        expect(scan(enc('<!DOCTYPE html><html><html><head>'))).toHaveProperty('violation');
    });

    it('duplicate DOCTYPE', () => {
        expect(scan(enc('<!DOCTYPE html><!DOCTYPE html><head>'))).toHaveProperty('violation');
    });

    it('exceeds 8 KB limit without finding head', () => {
        const padding = new Uint8Array(8 * 1024).fill(0x20); // 8 KB of spaces
        expect(scan(padding)).toHaveProperty('violation');
    });
});

// --- Incremental scanning with shared state ---

describe('scanPreamble — incremental scanning', () => {
    // Feed the full input one byte at a time using a shared scanner.
    function scanByteByByte(input) {
        const full = enc(input);
        const scanner = createPreambleScanner();
        for (let i = 0; i < full.length; i++) {
            const result = scanner.push(full.slice(i, i + 1));
            if (result !== null) {
                return result;
            }
        }
        return null;
    }

    it('finds injection point feeding one byte at a time', () => {
        const input = '<!DOCTYPE html><head>';
        expect(scanByteByByte(input)).toBe(1); // last chunk is 1 byte
    });

    it('handles comment split across chunk boundary', () => {
        const input = '<!DOCTYPE html><!-- split -->  <head>';
        expect(scanByteByByte(input)).toBe(1);
    });

    it('handles html tag with attributes split across chunks', () => {
        const input = '<!DOCTYPE html><html lang="en" dir="ltr"><head>';
        expect(scanByteByByte(input)).toBe(1);
    });

    it('scanner.totalPos equals bytes seen so far after each call', () => {
        const full = enc('<!DOCTYPE html><html><head>');
        const scanner = createPreambleScanner();
        for (let i = 0; i < full.length - 1; i++) {
            scanner.push(full.slice(i, i + 1));
            expect(scanner.totalPos).toBe(i + 1);
        }
    });

    it('violation mid-stream returns violation immediately', () => {
        const full = enc('<!DOCTYPE html><body>');
        const scanner = createPreambleScanner();
        let violation = null;
        for (let i = 0; i < full.length; i++) {
            const result = scanner.push(full.slice(i, i + 1));
            if (result?.violation) {
                violation = result.violation;
                break;
            }
        }
        expect(violation).toBeDefined();
    });
});
