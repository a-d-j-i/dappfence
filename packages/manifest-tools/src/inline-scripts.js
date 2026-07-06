'use strict';

const { promises: fs } = require('fs');
const { calculateStringHash } = require('./build');

// Find `<script` (7 chars) followed by whitespace, >, or / — case-insensitive.
// Returns the index of `<`, or -1.
function indexOfOpenScript(html, from) {
    let i = from;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt === -1) return -1;
        const after = html[lt + 7];
        if (
            html.slice(lt, lt + 7).toLowerCase() === '<script' &&
            (after === undefined || /[\s>/]/.test(after))
        ) {
            return lt;
        }
        i = lt + 1;
    }
    return -1;
}

// Find `</script` (8 chars) followed by whitespace or > — case-insensitive.
// Returns the index of `<`, or -1.
function indexOfEndScript(html, from) {
    let i = from;
    while (i < html.length) {
        const lt = html.indexOf('</', i);
        if (lt === -1) return -1;
        const after = html[lt + 8];
        if (
            html.slice(lt, lt + 8).toLowerCase() === '</script' &&
            (after === undefined || /[\s>]/.test(after))
        ) {
            return lt;
        }
        i = lt + 2;
    }
    return -1;
}

// Find the `>` that closes a tag starting at `from`.
function findTagClose(html, from) {
    const idx = html.indexOf('>', from);
    return idx === -1 ? html.length - 1 : idx;
}

// Parse `<script` attributes starting at `attrStart` (the index right after `<script`).
// Returns { hasSrc, contentStart } where contentStart is the first char after '>'.
function parseScriptTag(html, attrStart) {
    let i = attrStart;
    let hasSrc = false;
    while (i < html.length) {
        while (i < html.length && /\s/.test(html[i])) i++;
        if (html[i] === '>') return { hasSrc, contentStart: i + 1 };
        if (html[i] === '/') {
            i++;
            continue;
        }
        if (i >= html.length) break;
        const nameStart = i;
        while (i < html.length && !/[\s=>/]/.test(html[i])) i++;
        const attrName = html.slice(nameStart, i).toLowerCase();
        while (i < html.length && /\s/.test(html[i])) i++;
        if (html[i] === '=') {
            i++;
            while (i < html.length && /\s/.test(html[i])) i++;
            if (html[i] === '"' || html[i] === "'") {
                const q = html[i++];
                const end = html.indexOf(q, i);
                if (end === -1) return { hasSrc, contentStart: html.length };
                if (attrName === 'src') hasSrc = true;
                i = end + 1;
            } else {
                while (i < html.length && !/[\s>]/.test(html[i])) i++;
                if (attrName === 'src') hasSrc = true;
            }
        }
    }
    return { hasSrc, contentStart: html.length };
}

// HTML5 script data state machine to find the closing `</script>`.
// States: NORMAL (script data), ESCAPED (after <!--), DOUBLE_ESCAPED (after <!--<script).
// In DOUBLE_ESCAPED state, `</script>` transitions back to ESCAPED — it does NOT end the element.
// Returns the index of `<` in the closing `</script>`, or -1 if unterminated.
function findScriptContentEnd(html, from) {
    const NORMAL = 0,
        ESCAPED = 1,
        DOUBLE_ESCAPED = 2;
    let state = NORMAL;
    let i = from;

    while (i < html.length) {
        if (state === NORMAL) {
            const commentOpen = html.indexOf('<!--', i);
            const endScript = indexOfEndScript(html, i);
            if (endScript === -1) return -1;
            if (commentOpen !== -1 && commentOpen < endScript) {
                state = ESCAPED;
                i = commentOpen + 4;
            } else {
                return endScript;
            }
        } else if (state === ESCAPED) {
            const commentClose = html.indexOf('-->', i);
            const scriptOpen = indexOfOpenScript(html, i);
            const endScript = indexOfEndScript(html, i);
            const cc = commentClose !== -1 ? commentClose : Infinity;
            const so = scriptOpen !== -1 ? scriptOpen : Infinity;
            const es = endScript !== -1 ? endScript : Infinity;
            const min = Math.min(cc, so, es);
            if (min === Infinity) return -1;
            if (es === min) return endScript;
            if (cc === min) {
                state = NORMAL;
                i = commentClose + 3;
            } else {
                state = DOUBLE_ESCAPED;
                i = findTagClose(html, scriptOpen) + 1;
            }
        } else {
            // DOUBLE_ESCAPED: </script> goes back to escaped, does not end the element
            const commentClose = html.indexOf('-->', i);
            const endScript = indexOfEndScript(html, i);
            const cc = commentClose !== -1 ? commentClose : Infinity;
            const es = endScript !== -1 ? endScript : Infinity;
            if (Math.min(cc, es) === Infinity) return -1;
            if (cc <= es) {
                state = ESCAPED;
                i = commentClose + 3;
            } else {
                state = ESCAPED;
                i = findTagClose(html, endScript) + 1;
            }
        }
    }
    return -1;
}

/**
 * Extract SHA-256 hashes of all inline <script> bodies in an HTML file.
 * Uses the HTML5 script data state machine to correctly handle `<!--<script>` double-escape
 * patterns where an intermediate `</script>` does not close the element.
 *
 * @param {string} htmlPath - absolute path to an HTML file
 * @returns {Promise<{ hashes: string[], warnings: string[] }>}
 *   hashes: bare base64 SHA-256 (no 'sha256-' prefix), one per inline <script> body
 *   warnings: non-fatal issues found during parsing
 */
async function extractInlineScriptHashes(htmlPath) {
    const raw = await fs.readFile(htmlPath);

    if ((raw[0] === 0xff && raw[1] === 0xfe) || (raw[0] === 0xfe && raw[1] === 0xff)) {
        throw new Error(`${htmlPath}: UTF-16 BOM detected; only UTF-8 is supported`);
    }
    const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
    const html = raw.slice(bom).toString('utf8');

    const metaMatch = html.match(/<meta[^>]+charset\s*=\s*["']?([^"'\s;>]+)/i);
    if (metaMatch && !/^utf-?8$/i.test(metaMatch[1])) {
        throw new Error(`${htmlPath}: unsupported charset ${metaMatch[1]}`);
    }

    const hashes = [];
    const warnings = [];
    let pos = 0;

    while (pos < html.length) {
        const tagStart = indexOfOpenScript(html, pos);
        if (tagStart === -1) break;

        const { hasSrc, contentStart } = parseScriptTag(html, tagStart + 7);
        if (hasSrc) {
            pos = contentStart;
            continue;
        }

        const contentEnd = findScriptContentEnd(html, contentStart);
        if (contentEnd === -1) {
            warnings.push(`Unterminated <script> at offset ${tagStart}`);
            break;
        }

        hashes.push(calculateStringHash(html.slice(contentStart, contentEnd)));
        pos = findTagClose(html, contentEnd + 8) + 1;
    }

    return { hashes, warnings };
}

module.exports = { extractInlineScriptHashes };
