import { describe, it, expect } from 'vitest';
import { calculateHash } from '../crypto.js';

describe('calculateHash', () => {
    it('returns an SRI string for given input', async () => {
        const hash = await calculateHash(new TextEncoder().encode('hello'));
        // sha256- prefix + 44 standard-base64 chars (with `=` padding)
        expect(hash).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
    });

    it('returns consistent hashes for the same input', async () => {
        const input = new TextEncoder().encode('test content');
        const hash1 = await calculateHash(input);
        const hash2 = await calculateHash(input);
        expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different input', async () => {
        const hash1 = await calculateHash(new TextEncoder().encode('a'));
        const hash2 = await calculateHash(new TextEncoder().encode('b'));
        expect(hash1).not.toBe(hash2);
    });

    it('produces the known SHA-256 of an empty string in SRI form', async () => {
        const hash = await calculateHash(new TextEncoder().encode(''));
        expect(hash).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
    });

    it('matches the canonical SRI encoding (standard base64, with padding) used by the signer', async () => {
        // The signer emits hashes via Buffer.toString('base64') in Node — same
        // encoding as `btoa` here. A drift in either side (base64url, missing
        // padding, etc.) would silently break manifest hash comparisons, so
        // pin a known input to a known output.
        const hash = await calculateHash(new TextEncoder().encode('abc'));
        expect(hash).toBe('sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    });
});
