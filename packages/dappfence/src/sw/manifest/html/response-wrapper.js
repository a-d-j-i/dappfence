/**
 * Wraps a fetch Response with lazy, unified body reading.
 *
 * One reader, one shared chunks array — all methods draw from the same source:
 *   getBodyBytes()    — reads all body bytes for hash verification
 *   scanPreamble()    — reads until <head> is found (CSP injection phase 1)
 *   injectAtHead(b)   — splices b into chunks after <head> (phase 2)
 *   asResponse()      — returns original response if body was never read, or a
 *                       reconstructed Response from buffered chunks otherwise;
 *                       hides the body-reading detail from callers
 *
 * @param {Response} response
 */
import { VERIFICATION_STATUS } from '../../../core/constants.js';
import { createPreambleScanner } from './preamble-scanner.js';

export const makeResponseWrapper = (response) => {
    if (!response || !response.body) {
        return {
            ok: response?.ok ?? false,
            type: response?.type ?? 'error',
            getBodyBytes: () => Promise.resolve({ status: VERIFICATION_STATUS.ERROR }),
            scanPreamble: () => Promise.resolve({ status: VERIFICATION_STATUS.PREAMBLE_VIOLATION }),
            injectAtHead: () => {},
            asResponse: () => response ?? null,
        };
    }

    let reader = null;
    let readerStarted = false;
    const scanner = createPreambleScanner();
    const chunks = [];
    let insertionIndex = null;
    let headInjectionLength = 0;

    const ensureReader = () => {
        if (!reader) {
            reader = response.body.getReader();
            readerStarted = true;
        }
        return reader;
    };

    const getStream = () => {
        const buffered = [...chunks];
        const capturedReader = reader;
        return new ReadableStream({
            async start(controller) {
                for (const c of buffered) {
                    controller.enqueue(c);
                }
                if (capturedReader) {
                    while (true) {
                        const { done, value } = await capturedReader.read();
                        if (done) {
                            break;
                        }
                        controller.enqueue(value);
                    }
                }
                controller.close();
            },
            cancel() {
                return capturedReader?.cancel();
            },
        });
    };

    return {
        ok: response.ok,
        type: response.type,
        async getBodyBytes() {
            try {
                const r = ensureReader();
                while (true) {
                    const { done, value } = await r.read();
                    if (done) {
                        break;
                    }
                    chunks.push(value);
                }
                const total = chunks.reduce((n, c) => n + c.length, 0);
                const out = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                    out.set(c, off);
                    off += c.length;
                }
                return { value: out };
            } catch {
                return { status: VERIFICATION_STATUS.ERROR };
            }
        },
        async scanPreamble() {
            const r = ensureReader();
            let offset = null;
            while (offset === null) {
                const { done, value } = await r.read();
                if (done) {
                    await r.cancel();
                    return { status: VERIFICATION_STATUS.PREAMBLE_VIOLATION };
                }
                chunks.push(value);
                offset = scanner.push(value);
                if (offset?.violation) {
                    await r.cancel();
                    return { status: VERIFICATION_STATUS.PREAMBLE_VIOLATION };
                }
            }
            const chunk = chunks[chunks.length - 1];
            chunks.splice(-1, 1, chunk.slice(0, offset), chunk.slice(offset));
            insertionIndex = chunks.length - 1;
        },
        injectAtHead(bytes) {
            if (insertionIndex === null) {
                throw new Error('injectAtHead called before scanPreamble located <head>');
            }
            chunks.splice(insertionIndex, 0, bytes);
            headInjectionLength += bytes.length;
            insertionIndex++;
        },
        asResponse() {
            if (!readerStarted) {
                return response;
            }
            const headers = new Headers(response.headers);
            if (headInjectionLength > 0) {
                const originalLength = response.headers.get('content-length');
                if (originalLength !== null) {
                    headers.set(
                        'content-length',
                        String(parseInt(originalLength, 10) + headInjectionLength)
                    );
                }
            }
            return new Response(getStream(), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        },
    };
};
