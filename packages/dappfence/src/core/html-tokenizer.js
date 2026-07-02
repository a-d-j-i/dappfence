// Byte values for HTML structural characters — all ASCII, byte-safe in UTF-8
// (multi-byte UTF-8 sequences always have the high bit set, never collide with these)
const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const DASH = 0x2d;
const EQ = 0x3d;
const DQ = 0x22;
const SQ = 0x27;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const A_UPPER = 0x41;
const Z_UPPER = 0x5a;

// States
const S_DATA = 0;
const S_TAG_OPEN = 1;
const S_BANG_OPEN = 2;
const S_COMMENT_PRE = 3;
const S_COMMENT = 4;
const S_COMMENT_DASH1 = 5;
const S_COMMENT_DASH2 = 6;
const S_DOCTYPE = 7;
const S_TAG_NAME = 8;
const S_END_TAG_OPEN = 9;
const S_END_TAG_NAME = 10;
const S_END_TAG_WS = 11;
const S_ATTR_BEFORE = 12;
const S_ATTR_NAME = 13;
const S_ATTR_AFTER_NAME = 14;
const S_ATTR_VALUE_START = 15;
const S_ATTR_VALUE_DQ = 16;
const S_ATTR_VALUE_SQ = 17;
const S_ATTR_VALUE_UQ = 18;
const S_SELF_CLOSE = 19;
const S_SCRIPT_DATA = 20;
const S_SCRIPT_LT = 21;
const S_SCRIPT_SLASH = 22;
const S_SCRIPT_END = 23;
const S_SCRIPT_END_WAIT = 24;
// Hazard detection inside script content: <!--
const S_SCRIPT_BANG = 25;
const S_SCRIPT_BANG_DASH = 26;
// Raw text elements (textarea, title, style, …): consume until the matching close tag,
// emitting no script or inner-element events.
const S_RAW_DATA = 27;
const S_RAW_LT = 28;
const S_RAW_SLASH = 29;
const S_RAW_END = 30;
const S_RAW_END_WAIT = 31;

// Raw text elements: content is treated as opaque text by the browser.
// <script> tags inside them are NOT parsed as elements and do NOT execute.
// The tokenizer enters S_RAW_DATA for these, suppressing all inner events.
// <noscript> is included because when scripting is enabled (our context) its
// content is also raw text; treating it otherwise would create false positives.
const RAW_TEXT_ELEMENTS = new Set([
    'textarea',
    'title',
    'style',
    'xmp',
    'noembed',
    'noscript',
    'listing',
    'plaintext',
]);

// Void elements never have a closing tag (HTML5 spec)
const VOID_ELEMENTS = new Set([
    'area',
    'base',
    'br',
    'col',
    'embed',
    'hr',
    'img',
    'input',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr',
]);

const isWS = (b) => b === SPACE || b === TAB || b === LF || b === CR;
const toLower = (b) => (b >= A_UPPER && b <= Z_UPPER ? b + 0x20 : b);
// Valid in a tag name or attribute name: anything that isn't structural whitespace or delimiters
const isNameChar = (b) =>
    b > SPACE && b !== GT && b !== SLASH && b !== EQ && b !== DQ && b !== SQ && b !== LT;

// ── Adapters ──────────────────────────────────────────────────────────────────
// Each adapter specialises createTokenizer for a specific input type.
//
// read(chunk, i)           → number  — char code at position i
// toLowerChar(chunk, i, b) → string  — lowercase char at position i (b = read result)
// rawChar(chunk, i, b)     → string  — raw char at position i (no case change)
// merge(existing, chunk)   → buffer  — accumulate chunk into the input buffer
// slice(buf, start, end)   → content — extract content from the accumulated buffer

const BYTE_ADAPTER = {
    read: (chunk, i) => chunk[i],
    toLowerChar: (_chunk, _i, b) => String.fromCharCode(toLower(b)),
    rawChar: (_chunk, _i, b) => String.fromCharCode(b),
    merge(existing, chunk) {
        if (existing === null) return chunk;
        const merged = new Uint8Array(existing.length + chunk.length);
        merged.set(existing);
        merged.set(chunk, existing.length);
        return merged;
    },
    slice: (buf, start, end) => buf.subarray(start, end),
};

// Chunk boundaries mid-surrogate-pair are safe: surrogates (0xD800–0xDFFF) are
// never ASCII structural characters, so they pass through the state machine as
// content and are reunited by string concatenation in merge().
const STRING_ADAPTER = {
    read: (chunk, i) => chunk.charCodeAt(i),
    toLowerChar: (chunk, i, b) =>
        b >= A_UPPER && b <= Z_UPPER ? chunk[i].toLowerCase() : chunk[i],
    rawChar: (chunk, i, _b) => chunk[i],
    merge: (existing, chunk) => (existing === null ? chunk : existing + chunk),
    slice: (buf, start, end) => buf.slice(start, end),
};

/**
 * Shared HTML tokenizer state machine. Parameterised by an adapter so the same
 * logic handles both Uint8Array chunks (byte mode) and string chunks (string mode).
 *
 * See createUint8Tokenizer / createUtf8Tokenizer for the public API documentation.
 */
function createTokenizer(
    { onScriptOpen, onScript, onElementOpen, onElementClose, onHazard } = {},
    adapter
) {
    let state = S_DATA;
    let pos = 0;
    let cancelled = false;
    const ctl = {
        cancel() {
            cancelled = true;
        },
    };

    // Absolute position of the most recent `<` seen while in DATA state.
    let ltPos = 0;

    // Current opening tag
    let tagStart = 0;
    let tagName = '';
    let attrs = {};
    let curAttrName = '';
    let curAttrValue = '';

    // Input buffer — all pushed chunks accumulated, used for zero-copy content slicing
    let inputBuffer = null;

    // Current script element
    let scriptStart = 0;
    let scriptContentStart = 0;
    let scriptAttrs = {};
    let endTagBuf = '';
    let endTagStart = 0;

    // Raw text element tracking
    let rawCloseTag = '';
    let rawEndBuf = '';

    function finalizeAttr() {
        if (curAttrName) {
            attrs[curAttrName] = curAttrValue;
        }
        curAttrName = '';
        curAttrValue = '';
    }

    function openingTagDone(gtPos) {
        finalizeAttr();
        const name = tagName;
        const savedAttrs = attrs;
        const start = tagStart;
        const end = gtPos + 1;
        tagName = '';
        attrs = {};

        // Hazard: srcdoc attribute — the browser parses its value as a full HTML document,
        // executing any scripts inside. The tokenizer cannot see into that embedded document.
        if ('srcdoc' in savedAttrs) {
            if (onHazard) onHazard({ type: 'srcdoc', tagName: name, pos: gtPos }, ctl);
            return;
        }

        if (name === 'script') {
            scriptStart = start;
            scriptContentStart = end;
            scriptAttrs = savedAttrs;
            endTagBuf = '';
            state = S_SCRIPT_DATA;
            if (onScriptOpen) {
                onScriptOpen({ startIndex: start, contentStart: end }, ctl);
            }
            return;
        }

        // Raw text elements: suppress all inner element and script events.
        // Fire onElementOpen for the element itself, then enter raw text mode.
        if (RAW_TEXT_ELEMENTS.has(name)) {
            if (onElementOpen) {
                onElementOpen(
                    { tagName: name, startIndex: start, attrEnd: end, attrs: savedAttrs },
                    ctl
                );
            }
            rawCloseTag = name;
            rawEndBuf = '';
            state = S_RAW_DATA;
            return;
        }

        if (onElementOpen) {
            onElementOpen(
                { tagName: name, startIndex: start, attrEnd: end, attrs: savedAttrs },
                ctl
            );
        }
        if (VOID_ELEMENTS.has(name) && onElementClose) {
            onElementClose({ tagName: name, endIndex: end }, ctl);
        }
        state = S_DATA;
    }

    function selfClosingTagDone(gtPos) {
        finalizeAttr();
        const name = tagName;
        const savedAttrs = attrs;
        const start = tagStart;
        const end = gtPos + 1;
        tagName = '';
        attrs = {};

        if (onElementOpen) {
            onElementOpen(
                { tagName: name, startIndex: start, attrEnd: end, attrs: savedAttrs },
                ctl
            );
        }
        if (onElementClose) {
            onElementClose({ tagName: name, endIndex: end }, ctl);
        }
        state = S_DATA;
    }

    function closingTagDone(gtPos) {
        const name = tagName;
        tagName = '';
        if (onElementClose) {
            onElementClose({ tagName: name, endIndex: gtPos + 1 }, ctl);
        }
        state = S_DATA;
    }

    function scriptDone(gtPos) {
        const content = adapter.slice(inputBuffer, scriptContentStart, endTagStart);
        if (onScript) {
            onScript(
                {
                    startIndex: scriptStart,
                    endIndex: gtPos + 1,
                    contentStart: scriptContentStart,
                    contentEnd: endTagStart,
                    content,
                    attrs: scriptAttrs,
                },
                ctl
            );
        }
        endTagBuf = '';
        state = S_DATA;
    }

    function push(chunk) {
        inputBuffer = adapter.merge(inputBuffer, chunk);
        for (let i = 0; i < chunk.length && !cancelled; i++, pos++) {
            const b = adapter.read(chunk, i);

            switch (state) {
                case S_DATA:
                    if (b === LT) {
                        ltPos = pos;
                        state = S_TAG_OPEN;
                    }
                    break;

                case S_TAG_OPEN:
                    if (b === SLASH) {
                        tagName = '';
                        state = S_END_TAG_OPEN;
                    } else if (b === BANG) {
                        state = S_BANG_OPEN;
                    } else if (isNameChar(b)) {
                        tagStart = pos - 1;
                        tagName = adapter.toLowerChar(chunk, i, b);
                        attrs = {};
                        state = S_TAG_NAME;
                    } else {
                        state = S_DATA;
                    }
                    break;

                case S_BANG_OPEN:
                    state = b === DASH ? S_COMMENT_PRE : S_DOCTYPE;
                    break;

                case S_COMMENT_PRE:
                    state = b === DASH ? S_COMMENT : S_DOCTYPE;
                    break;

                case S_COMMENT:
                    if (b === DASH) {
                        state = S_COMMENT_DASH1;
                    }
                    break;

                case S_COMMENT_DASH1:
                    if (b === DASH) {
                        state = S_COMMENT_DASH2;
                    } else if (b === GT) {
                        state = S_DATA;
                    } // abrupt close (HTML5 parse error, but closes)
                    else {
                        state = S_COMMENT;
                    }
                    break;

                case S_COMMENT_DASH2:
                    if (b === GT) {
                        state = S_DATA;
                    } else if (b !== DASH) {
                        state = S_COMMENT;
                    }
                    break;

                case S_DOCTYPE:
                    if (b === GT) {
                        state = S_DATA;
                    }
                    break;

                case S_TAG_NAME:
                    if (isWS(b)) {
                        state = S_ATTR_BEFORE;
                    } else if (b === GT) {
                        openingTagDone(pos);
                    } else if (b === SLASH) {
                        state = S_SELF_CLOSE;
                    } else if (isNameChar(b)) {
                        tagName += adapter.toLowerChar(chunk, i, b);
                    } else {
                        state = S_DATA;
                    }
                    break;

                case S_END_TAG_OPEN:
                    if (isNameChar(b)) {
                        tagName = adapter.toLowerChar(chunk, i, b);
                        state = S_END_TAG_NAME;
                    } else {
                        state = S_DATA;
                    }
                    break;

                case S_END_TAG_NAME:
                    if (b === GT) {
                        closingTagDone(pos);
                    } else if (isWS(b)) {
                        state = S_END_TAG_WS;
                    } else if (isNameChar(b)) {
                        tagName += adapter.toLowerChar(chunk, i, b);
                    } else {
                        state = S_DATA;
                    }
                    break;

                case S_END_TAG_WS:
                    if (b === GT) {
                        closingTagDone(pos);
                    }
                    break;

                case S_ATTR_BEFORE:
                    if (b === GT) {
                        openingTagDone(pos);
                    } else if (b === SLASH) {
                        state = S_SELF_CLOSE;
                    } else if (!isWS(b) && isNameChar(b)) {
                        curAttrName = adapter.toLowerChar(chunk, i, b);
                        state = S_ATTR_NAME;
                    }
                    break;

                case S_ATTR_NAME:
                    if (b === EQ) {
                        state = S_ATTR_VALUE_START;
                    } else if (isWS(b)) {
                        state = S_ATTR_AFTER_NAME;
                    } else if (b === GT) {
                        finalizeAttr();
                        openingTagDone(pos);
                    } else if (b === SLASH) {
                        finalizeAttr();
                        state = S_SELF_CLOSE;
                    } else if (isNameChar(b)) {
                        curAttrName += adapter.toLowerChar(chunk, i, b);
                    }
                    break;

                case S_ATTR_AFTER_NAME:
                    if (b === EQ) {
                        state = S_ATTR_VALUE_START;
                    } else if (b === GT) {
                        finalizeAttr();
                        openingTagDone(pos);
                    } else if (b === SLASH) {
                        finalizeAttr();
                        state = S_SELF_CLOSE;
                    } else if (!isWS(b) && isNameChar(b)) {
                        finalizeAttr();
                        curAttrName = adapter.toLowerChar(chunk, i, b);
                        state = S_ATTR_NAME;
                    }
                    break;

                case S_ATTR_VALUE_START:
                    if (b === DQ) {
                        curAttrValue = '';
                        state = S_ATTR_VALUE_DQ;
                    } else if (b === SQ) {
                        curAttrValue = '';
                        state = S_ATTR_VALUE_SQ;
                    } else if (!isWS(b) && b !== GT) {
                        curAttrValue = adapter.rawChar(chunk, i, b);
                        state = S_ATTR_VALUE_UQ;
                    }
                    break;

                case S_ATTR_VALUE_DQ:
                    if (b === DQ) {
                        finalizeAttr();
                        state = S_ATTR_BEFORE;
                    } else {
                        curAttrValue += adapter.rawChar(chunk, i, b);
                    }
                    break;

                case S_ATTR_VALUE_SQ:
                    if (b === SQ) {
                        finalizeAttr();
                        state = S_ATTR_BEFORE;
                    } else {
                        curAttrValue += adapter.rawChar(chunk, i, b);
                    }
                    break;

                case S_ATTR_VALUE_UQ:
                    if (isWS(b)) {
                        finalizeAttr();
                        state = S_ATTR_BEFORE;
                    } else if (b === GT) {
                        finalizeAttr();
                        openingTagDone(pos);
                    } else if (b === LT) {
                        // Hazard: < in an unquoted attribute value. Some browsers exit
                        // attribute mode here and parse the following bytes as markup,
                        // creating a parse differential with our tokenizer.
                        if (onHazard) onHazard({ type: 'unquoted-attr-lt', pos }, ctl);
                        state = S_DATA;
                    } else {
                        curAttrValue += adapter.rawChar(chunk, i, b);
                    }
                    break;

                case S_SELF_CLOSE:
                    if (b === GT) {
                        selfClosingTagDone(pos);
                    } else if (!isWS(b)) {
                        state = S_ATTR_BEFORE;
                    }
                    break;

                case S_SCRIPT_DATA:
                    if (b === LT) {
                        endTagStart = pos;
                        state = S_SCRIPT_LT;
                    }
                    break;

                case S_SCRIPT_LT:
                    if (b === SLASH) {
                        state = S_SCRIPT_SLASH;
                    } else if (b === LT) {
                        endTagStart = pos;
                        // state stays S_SCRIPT_LT
                    } else if (b === BANG) {
                        state = S_SCRIPT_BANG;
                    } else {
                        state = S_SCRIPT_DATA;
                    }
                    break;

                // Hazard: <!-- inside script content triggers HTML5 "Script Data Double
                // Escaped" state in the browser, causing the first </script> to be ignored.
                // We fire onHazard at the point where the third character of <!-- is seen.
                case S_SCRIPT_BANG:
                    if (b === DASH) {
                        state = S_SCRIPT_BANG_DASH;
                    } else if (b === LT) {
                        endTagStart = pos;
                        state = S_SCRIPT_LT;
                    } else {
                        state = S_SCRIPT_DATA;
                    }
                    break;

                case S_SCRIPT_BANG_DASH:
                    if (b === DASH) {
                        if (onHazard) onHazard({ type: 'script-html-comment', pos }, ctl);
                        state = S_SCRIPT_DATA;
                    } else if (b === LT) {
                        endTagStart = pos;
                        state = S_SCRIPT_LT;
                    } else {
                        state = S_SCRIPT_DATA;
                    }
                    break;

                case S_SCRIPT_SLASH:
                    if (isNameChar(b)) {
                        endTagBuf = adapter.toLowerChar(chunk, i, b);
                        state = S_SCRIPT_END;
                    } else if (b === LT) {
                        endTagBuf = '';
                        endTagStart = pos;
                        state = S_SCRIPT_LT;
                    } else {
                        endTagBuf = '';
                        state = S_SCRIPT_DATA;
                    }
                    break;

                case S_SCRIPT_END:
                    if (b === GT) {
                        if (endTagBuf === 'script') {
                            scriptDone(pos);
                        } else {
                            endTagBuf = '';
                            state = S_SCRIPT_DATA;
                        }
                    } else if (isWS(b)) {
                        if (endTagBuf === 'script') {
                            state = S_SCRIPT_END_WAIT;
                        } else {
                            endTagBuf = '';
                            state = S_SCRIPT_DATA;
                        }
                    } else if (isNameChar(b)) {
                        endTagBuf += adapter.toLowerChar(chunk, i, b);
                    } else if (b === LT) {
                        endTagBuf = '';
                        endTagStart = pos;
                        state = S_SCRIPT_LT;
                    } else {
                        endTagBuf = '';
                        state = S_SCRIPT_DATA;
                    }
                    break;

                case S_SCRIPT_END_WAIT:
                    if (b === GT) {
                        scriptDone(pos);
                    }
                    break;

                // Raw text element states: consume content without emitting any events,
                // exit only on the exact matching close tag.
                case S_RAW_DATA:
                    if (b === LT) {
                        state = S_RAW_LT;
                    }
                    break;

                case S_RAW_LT:
                    if (b === SLASH) {
                        state = S_RAW_SLASH;
                    } else if (b === LT) {
                        // stay — a new < resets the potential tag start
                    } else {
                        state = S_RAW_DATA;
                    }
                    break;

                case S_RAW_SLASH:
                    if (isNameChar(b)) {
                        rawEndBuf = adapter.toLowerChar(chunk, i, b);
                        state = S_RAW_END;
                    } else if (b === LT) {
                        state = S_RAW_LT;
                    } else {
                        state = S_RAW_DATA;
                    }
                    break;

                case S_RAW_END:
                    if (b === GT) {
                        if (rawEndBuf === rawCloseTag) {
                            const closed = rawCloseTag;
                            rawCloseTag = '';
                            rawEndBuf = '';
                            if (onElementClose)
                                onElementClose({ tagName: closed, endIndex: pos + 1 }, ctl);
                            state = S_DATA;
                        } else {
                            rawEndBuf = '';
                            state = S_RAW_DATA;
                        }
                    } else if (isWS(b)) {
                        if (rawEndBuf === rawCloseTag) {
                            state = S_RAW_END_WAIT;
                        } else {
                            rawEndBuf = '';
                            state = S_RAW_DATA;
                        }
                    } else if (isNameChar(b)) {
                        rawEndBuf += adapter.toLowerChar(chunk, i, b);
                    } else if (b === LT) {
                        rawEndBuf = '';
                        state = S_RAW_LT;
                    } else {
                        rawEndBuf = '';
                        state = S_RAW_DATA;
                    }
                    break;

                case S_RAW_END_WAIT:
                    if (b === GT) {
                        const closed = rawCloseTag;
                        rawCloseTag = '';
                        rawEndBuf = '';
                        if (onElementClose)
                            onElementClose({ tagName: closed, endIndex: pos + 1 }, ctl);
                        state = S_DATA;
                    }
                    break;
            }
        }
    }

    function finish() {
        if (cancelled) return;
        if (
            state === S_SCRIPT_DATA ||
            state === S_SCRIPT_LT ||
            state === S_SCRIPT_SLASH ||
            state === S_SCRIPT_END ||
            state === S_SCRIPT_END_WAIT ||
            state === S_SCRIPT_BANG ||
            state === S_SCRIPT_BANG_DASH
        ) {
            if (onScript) {
                const contentEnd = state === S_SCRIPT_END_WAIT ? endTagStart : pos;
                const content = adapter.slice(inputBuffer, scriptContentStart, contentEnd);
                onScript(
                    {
                        startIndex: scriptStart,
                        endIndex: pos,
                        contentStart: scriptContentStart,
                        contentEnd,
                        content,
                        attrs: scriptAttrs,
                        truncated: true,
                    },
                    ctl
                );
            }
        }
    }

    return {
        push,
        finish,
        cancel() {
            cancelled = true;
        },
        get holdPos() {
            if (state === S_DATA) return null;
            // Raw text states consume content without buffering anything actionable.
            if (
                state === S_RAW_DATA ||
                state === S_RAW_LT ||
                state === S_RAW_SLASH ||
                state === S_RAW_END ||
                state === S_RAW_END_WAIT
            )
                return null;
            return ltPos;
        },
    };
}

/**
 * Create a streaming HTML tokenizer that accepts Uint8Array chunks.
 * `onScript.content` is a Uint8Array of the raw UTF-8 bytes.
 * Positions (startIndex, endIndex, etc.) are byte offsets.
 *
 * Chunk boundaries mid-UTF-8-sequence are safe: continuation bytes (0x80–0xFF)
 * never overlap with ASCII structural characters.
 *
 * @param {{ onScriptOpen?, onScript?, onElementOpen?, onElementClose? }} callbacks
 * @returns {{ push(chunk: Uint8Array): void, finish(): void, cancel(): void }}
 */
export function createUint8Tokenizer(callbacks) {
    return createTokenizer(callbacks, BYTE_ADAPTER);
}

/**
 * Create a streaming HTML tokenizer that accepts string chunks.
 * `onScript.content` is a string — no TextDecoder needed on the caller side.
 * Positions (startIndex, endIndex, etc.) are UTF-16 code-unit offsets.
 *
 * Chunk boundaries mid-surrogate-pair are safe: surrogates (0xD800–0xDFFF)
 * never overlap with ASCII structural characters and are reunited by string
 * concatenation in the internal buffer.
 *
 * @param {{ onScriptOpen?, onScript?, onElementOpen?, onElementClose? }} callbacks
 * @returns {{ push(chunk: string): void, finish(): void, cancel(): void }}
 */
export function createUtf8Tokenizer(callbacks) {
    return createTokenizer(callbacks, STRING_ADAPTER);
}

/**
 * Returns a WritableStream that feeds incoming Uint8Array chunks into a
 * byte-mode tokenizer. Closing the stream calls finish(); aborting calls cancel().
 *
 * @param {{ onScriptOpen?, onScript?, onElementOpen?, onElementClose? }} callbacks
 * @returns {WritableStream}
 */
export function createUint8TokenizerSink(callbacks) {
    const tok = createUint8Tokenizer(callbacks);
    return new WritableStream({
        write(chunk) {
            tok.push(chunk);
        },
        close() {
            tok.finish();
        },
        abort() {
            tok.cancel();
        },
    });
}

/**
 * Returns a WritableStream that feeds incoming string chunks into a
 * string-mode tokenizer. Closing the stream calls finish(); aborting calls cancel().
 *
 * @param {{ onScriptOpen?, onScript?, onElementOpen?, onElementClose? }} callbacks
 * @returns {WritableStream}
 */
export function createUtf8TokenizerSink(callbacks) {
    const tok = createUtf8Tokenizer(callbacks);
    return new WritableStream({
        write(chunk) {
            tok.push(chunk);
        },
        close() {
            tok.finish();
        },
        abort() {
            tok.cancel();
        },
    });
}

/**
 * Returns a TransformStream that passes Uint8Array chunks through unchanged
 * while simultaneously feeding them to a byte-mode tokenizer. Calling the
 * abort function errors the stream and silently drops subsequent enqueues.
 *
 * makeCallbacks(abort) is called once during construction. It receives an
 * abort(err?) function that errors the stream and must return the tokenizer
 * callback object ({ onScript?, onElementOpen?, … }).
 *
 * @param {(abort: (err?: Error) => void) => { onScriptOpen?, onScript?, onElementOpen?, onElementClose? }} makeCallbacks
 * @returns {TransformStream}
 */
export function createUint8VerifyingPassthrough(makeCallbacks) {
    let tsController;
    let aborted = false;
    const abort = (err) => {
        if (aborted) return;
        aborted = true;
        tsController?.error(err ?? new Error('security violation'));
    };
    const tok = createUint8Tokenizer(makeCallbacks(abort));
    return new TransformStream({
        start(controller) {
            tsController = controller;
        },
        transform(chunk, controller) {
            tok.push(chunk);
            if (!aborted) controller.enqueue(chunk);
        },
        flush() {
            tok.finish();
        },
    });
}
