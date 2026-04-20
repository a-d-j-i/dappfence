import { describe, it, expect } from 'vitest';
import { calculateHash, sriToHex } from '../crypto.js';

describe('calculateHash', () => {
    it('returns a hex string for given input', async () => {
        const hash = await calculateHash(new TextEncoder().encode('hello'));
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
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

    it('produces the known SHA-256 of an empty string', async () => {
        const hash = await calculateHash(new TextEncoder().encode(''));
        expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
});

describe('sriToHex', () => {
    it('converts a valid sha256 SRI hash to hex', () => {
        // sha256 of empty string in base64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
        const hex = sriToHex('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
        expect(hex).toMatch(/^[0-9a-f]{64}$/);
        expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('returns non-SRI strings as-is', () => {
        const hex = 'abc123def456';
        expect(sriToHex(hex)).toBe(hex);
    });

    it('returns null/undefined as-is', () => {
        expect(sriToHex(null)).toBe(null);
        expect(sriToHex(undefined)).toBe(undefined);
    });

    it('returns non-sha256 prefixed strings as-is', () => {
        expect(sriToHex('sha384-abc')).toBe('sha384-abc');
    });
});
