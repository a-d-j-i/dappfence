import { createUint8Tokenizer } from '../../../core/html-tokenizer.js';
import { createLogger } from '../../../core/logger.js';
import { VERIFICATION_STATUS } from '../../../core/constants.js';

const logger = createLogger();

function mergeBytes(a, b) {
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a);
    merged.set(b, a.length);
    return merged;
}

// ── HTML encoding detection ───────────────────────────────────────────────────
// Detects charset from BOM, Content-Type, and <meta charset>, then decodes.
// BOM takes absolute priority (browser behaviour). Content-Type and meta
// charset are detected and returned for caller comparison but do not block.
// The decoded text is re-encoded to UTF-8 bytes so the byte-level tokenizer
// always receives a consistent encoding regardless of the source charset.

// Returns the BOM-declared encoding label (TextDecoder-compatible), or null.
// UTF-32 is checked before UTF-16 because UTF-32-LE starts with FF FE 00 00,
// which would otherwise match the UTF-16-LE prefix FF FE.
const detectBOM = (bytes) => {
    if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
        return 'utf-32be';
    if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)
        return 'utf-32le';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return null;
};

// Scan the first 1024 raw bytes for a <meta charset> or
// <meta http-equiv="content-type"> declaration using the tokenizer.
// Works on raw bytes without a prior decode — safe because all HTML structural
// characters are ASCII and the tokenizer is byte-level.
const extractMetaCharset = (rawBytes) => {
    const scan = rawBytes.length > 1024 ? rawBytes.slice(0, 1024) : rawBytes;
    let charset = null;
    const tok = createUint8Tokenizer({
        onElementOpen({ tagName, attrs }, ctl) {
            if (tagName !== 'meta') return;
            if (attrs.charset) {
                charset = attrs.charset;
                ctl.cancel();
                return;
            }
            if (attrs['http-equiv'] === 'content-type' && attrs.content) {
                const m = /\bcharset\s*=\s*([\w-]+)/i.exec(attrs.content);
                if (m) {
                    charset = m[1];
                    ctl.cancel();
                }
            }
        },
    });
    tok.push(scan);
    tok.finish();
    return charset;
};

// Extract the charset from a Content-Type header, preserving original form.
const extractContentTypeCharset = (headers) => {
    const ct = headers?.get('content-type') ?? '';
    const m = /\bcharset\s*=\s*["']?\s*([\w-]+)/i.exec(ct);
    return m ? m[1] : null;
};

/**
 * Wraps a fetch Response with lazy, memoised access to the body buffer and
 * decoded text. Exposes the response's observable properties (ok, type,
 * headers) so callers never need to hold the raw response themselves.
 *
 * getBodyBytes() → { value: Uint8Array } | { status }
 * getBodyUtf8() → { text, detectedCharset, bomCharset, ctCharset, metaCharset } | { status }
 *
 * clone().arrayBuffer() is called at most once.
 */
export const makeResponseWrapper = (response) => {
    let bufferResult = null;
    let decodeResult = null;

    const getBodyBytes = async () => {
        if (bufferResult) {
            return bufferResult;
        }
        try {
            const buf = await response.clone().arrayBuffer();
            bufferResult = { value: new Uint8Array(buf) };
        } catch (err) {
            logger.warn('[getBodyBytes] failed to read response body:', err);
            bufferResult = { status: VERIFICATION_STATUS.ERROR };
        }
        return bufferResult;
    };

    const getBodyUtf8 = async (validEncodings) => {
        if (decodeResult) {
            return decodeResult;
        }
        const buf = await getBodyBytes();
        if (buf.status) {
            return (decodeResult = buf);
        }
        const rawBytes = buf.value;
        const bomCharset = detectBOM(rawBytes);
        const ctCharset = extractContentTypeCharset(response?.headers);
        const metaCharset = extractMetaCharset(rawBytes);
        // Effective charset: BOM > Content-Type > meta > UTF-8 default.
        const detectedCharset = bomCharset ?? ctCharset ?? metaCharset ?? 'utf-8';

        if (!validEncodings.includes(detectedCharset.toLowerCase())) {
            logger.warn(
                `[encoding] "${detectedCharset}" not in manifest encodings: [${validEncodings.join(', ')}]`
            );
            return (decodeResult = { status: VERIFICATION_STATUS.ENCODING_MISMATCH });
        }
        try {
            const text = new TextDecoder(detectedCharset, { fatal: true }).decode(rawBytes);
            return (decodeResult = { text, detectedCharset, bomCharset, ctCharset, metaCharset });
        } catch (err) {
            logger.warn(`[decode] charset "${detectedCharset}" could not decode document:`, err);
            return (decodeResult = { status: VERIFICATION_STATUS.ENCODING_MISMATCH });
        }
    };

    return {
        get ok() {
            return response?.ok;
        },
        get type() {
            return response?.type;
        },
        get headers() {
            return response?.headers;
        },
        getBodyBytes,
        getBodyUtf8,
    };
};

/**
 * Returns a TransformStream<Uint8Array, string> that detects the document
 * encoding (BOM → Content-Type → <meta charset> → UTF-8 default), validates
 * it against validEncodings, then emits decoded string chunks.
 *
 * Encoding detection is deferred until the stream has accumulated at least
 * 4 bytes (enough for any BOM) or 1 024 bytes (enough for a <meta charset>
 * scan). The stream errors if the detected encoding is not in validEncodings
 * or if TextDecoder throws (malformed bytes for the declared charset).
 *
 * @param {string[]} validEncodings  — lowercase encoding labels
 * @param {Headers|null} headers     — response headers for Content-Type sniff
 * @returns {TransformStream<Uint8Array, string>}
 */
export function createDecodingStream(validEncodings, headers) {
    const SCAN_THRESHOLD = 1024;
    let accumulated = null;
    let decoder = null;
    const ctCharset = extractContentTypeCharset(headers);

    function activateDecoder(detectedCharset, controller) {
        if (!validEncodings.includes(detectedCharset.toLowerCase())) {
            controller.error(
                new Error(
                    `encoding "${detectedCharset}" not in manifest encodings: [${validEncodings.join(', ')}]`
                )
            );
            return false;
        }
        decoder = new TextDecoder(detectedCharset, { fatal: true });
        return true;
    }

    function decodeChunk(bytes, stream, controller) {
        try {
            const text = decoder.decode(bytes, { stream });
            if (text) controller.enqueue(text);
        } catch (err) {
            controller.error(err);
        }
    }

    return new TransformStream({
        transform(chunk, controller) {
            if (decoder !== null) {
                decodeChunk(chunk, true, controller);
                return;
            }
            accumulated = accumulated === null ? chunk : mergeBytes(accumulated, chunk);
            if (accumulated.length < 4) return;
            const bomCharset = detectBOM(accumulated);
            if (bomCharset !== null || accumulated.length >= SCAN_THRESHOLD) {
                const metaCharset = bomCharset ? null : extractMetaCharset(accumulated);
                const detectedCharset = bomCharset ?? ctCharset ?? metaCharset ?? 'utf-8';
                if (!activateDecoder(detectedCharset, controller)) return;
                const flushed = accumulated;
                accumulated = null;
                decodeChunk(flushed, true, controller);
            }
        },
        flush(controller) {
            if (decoder === null) {
                if (accumulated === null) return;
                const bomCharset = detectBOM(accumulated);
                const metaCharset = bomCharset ? null : extractMetaCharset(accumulated);
                const detectedCharset = bomCharset ?? ctCharset ?? metaCharset ?? 'utf-8';
                if (!activateDecoder(detectedCharset, controller)) return;
                decodeChunk(accumulated, false, controller);
            } else {
                decodeChunk(new Uint8Array(0), false, controller);
            }
        },
    });
}
