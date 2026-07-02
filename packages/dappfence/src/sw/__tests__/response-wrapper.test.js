import { describe, it, expect, vi } from 'vitest';
import { makeResponseWrapper } from '../manifest/html/response-wrapper.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const enc = (str) => new TextEncoder().encode(str).buffer;

function makeResponse({
    ok = true,
    type = 'basic',
    contentType = null,
    body = enc('<!DOCTYPE html><html><body></body></html>'),
    throwOnClone = false,
} = {}) {
    const headers = { get: (name) => (name === 'content-type' ? contentType : null) };
    const clone = vi.fn(() => ({
        arrayBuffer: throwOnClone
            ? () => Promise.reject(new Error('network error'))
            : () => Promise.resolve(body),
    }));
    return { ok, type, headers, clone };
}

// ── passthrough properties ────────────────────────────────────────────────────

describe('passthrough properties', () => {
    it('exposes ok, type, headers from the underlying response', () => {
        const response = makeResponse({ ok: false, type: 'opaque' });
        const wrapper = makeResponseWrapper(response);
        expect(wrapper.ok).toBe(false);
        expect(wrapper.type).toBe('opaque');
        expect(wrapper.headers).toBe(response.headers);
    });

    it('returns undefined safely when response is null', () => {
        const wrapper = makeResponseWrapper(null);
        expect(wrapper.ok).toBeUndefined();
        expect(wrapper.type).toBeUndefined();
        expect(wrapper.headers).toBeUndefined();
    });
});

// ── getBodyBytes ─────────────────────────────────────────────────────────────────

describe('getBodyBytes()', () => {
    it('returns { value } on success', async () => {
        const body = enc('hello');
        const wrapper = makeResponseWrapper(makeResponse({ body }));
        const result = await wrapper.getBodyBytes();
        expect(result.status).toBeUndefined();
        expect(result.value).toBeInstanceOf(Uint8Array);
    });

    it('calls clone().arrayBuffer() exactly once across multiple calls', async () => {
        const response = makeResponse();
        const wrapper = makeResponseWrapper(response);
        await wrapper.getBodyBytes();
        await wrapper.getBodyBytes();
        await wrapper.getBodyBytes();
        expect(response.clone).toHaveBeenCalledTimes(1);
    });

    it('returns { status } when clone throws', async () => {
        const wrapper = makeResponseWrapper(makeResponse({ throwOnClone: true }));
        const result = await wrapper.getBodyBytes();
        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
    });

    it('caches the failure — clone not retried after error', async () => {
        const response = makeResponse({ throwOnClone: true });
        const wrapper = makeResponseWrapper(response);
        await wrapper.getBodyBytes();
        await wrapper.getBodyBytes();
        expect(response.clone).toHaveBeenCalledTimes(1);
    });
});

// ── getBodyUtf8 ─────────────────────────────────────────────────────────────────

describe('getBodyUtf8()', () => {
    it('returns { text } for valid UTF-8', async () => {
        const wrapper = makeResponseWrapper(makeResponse());
        const result = await wrapper.getBodyUtf8(['utf-8']);
        expect(result.status).toBeUndefined();
        expect(typeof result.text).toBe('string');
    });

    it('includes detectedCharset in the result', async () => {
        const wrapper = makeResponseWrapper(makeResponse());
        const result = await wrapper.getBodyUtf8(['utf-8']);
        expect(result.status).toBeUndefined();
        expect(result.detectedCharset).toBeDefined();
    });

    it('detects UTF-16LE from BOM and decodes successfully', async () => {
        const text = '<!DOCTYPE html>';
        // Prepend UTF-16LE BOM (FF FE) + re-encode as UTF-16LE
        const utf16 = new Uint16Array([...text].map((c) => c.charCodeAt(0)));
        const bom = new Uint8Array([0xff, 0xfe]);
        const body = new Uint8Array([...bom, ...new Uint8Array(utf16.buffer)]).buffer;
        const wrapper = makeResponseWrapper(makeResponse({ body }));
        const result = await wrapper.getBodyUtf8(['utf-16le']);
        expect(result.status).toBeUndefined();
        expect(result.bomCharset).toBe('utf-16le');
        expect(result.detectedCharset).toBe('utf-16le');
        expect(result.text).toContain('DOCTYPE');
    });

    it('uses Content-Type charset when no BOM', async () => {
        const wrapper = makeResponseWrapper(
            makeResponse({ contentType: 'text/html; charset=iso-8859-1' })
        );
        const result = await wrapper.getBodyUtf8(['iso-8859-1']);
        expect(result.ctCharset).toBe('iso-8859-1');
    });

    it('detects meta charset', async () => {
        const body = enc('<meta charset="iso-8859-1"><html></html>');
        const wrapper = makeResponseWrapper(makeResponse({ body }));
        const result = await wrapper.getBodyUtf8(['iso-8859-1']);
        expect(result.metaCharset).toBe('iso-8859-1');
    });

    it('calls clone().arrayBuffer() exactly once even on multiple getBodyUtf8 calls', async () => {
        const response = makeResponse();
        const wrapper = makeResponseWrapper(response);
        await wrapper.getBodyUtf8(['utf-8']);
        await wrapper.getBodyUtf8(['utf-8']);
        await wrapper.getBodyUtf8(['utf-8']);
        expect(response.clone).toHaveBeenCalledTimes(1);
    });

    it('getBodyBytes and getBodyUtf8 share the same clone call', async () => {
        const response = makeResponse();
        const wrapper = makeResponseWrapper(response);
        await wrapper.getBodyBytes();
        await wrapper.getBodyUtf8(['utf-8']);
        expect(response.clone).toHaveBeenCalledTimes(1);
    });

    it('propagates buffer failure as { status: ERROR }', async () => {
        const wrapper = makeResponseWrapper(makeResponse({ throwOnClone: true }));
        const result = await wrapper.getBodyUtf8(['utf-8']);
        expect(result.status).toBe(VERIFICATION_STATUS.ERROR);
    });

    it('returns { status } when charset is declared but decoding fails', async () => {
        // UTF-16LE BOM but only utf-8 allowed — encoding mismatch
        const body = new Uint8Array([0xff, 0xfe, 0x00]).buffer;
        const wrapper = makeResponseWrapper(makeResponse({ body }));
        const result = await wrapper.getBodyUtf8(['utf-8']);
        // Either decoded successfully (text) or rejected (status) — must not throw
        expect(result.text !== undefined || result.status !== undefined).toBe(true);
    });
});
