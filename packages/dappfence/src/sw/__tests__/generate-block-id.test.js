import { describe, it, expect } from 'vitest';
import { generateBlockId } from '../storage/security-stores.js';

describe('generateBlockId', () => {
    const BLOCK_DATA = {
        status: 'MISMATCH',
        fileKey: '/app.js',
        expectedHash: 'expected123',
        actualHash: 'actual456',
    };

    it('returns a block_ prefixed hex string', async () => {
        const id = await generateBlockId(BLOCK_DATA);
        expect(id).toMatch(/^block_[0-9a-f]{16}$/);
    });

    it('is deterministic — same input produces same id', async () => {
        const id1 = await generateBlockId(BLOCK_DATA);
        const id2 = await generateBlockId(BLOCK_DATA);
        expect(id1).toBe(id2);
    });

    it('produces different ids for different file keys', async () => {
        const id1 = await generateBlockId(BLOCK_DATA);
        const id2 = await generateBlockId({ ...BLOCK_DATA, fileKey: '/other.js' });
        expect(id1).not.toBe(id2);
    });

    it('produces different ids for different violation types', async () => {
        const id1 = await generateBlockId(BLOCK_DATA);
        const id2 = await generateBlockId({
            ...BLOCK_DATA,
            status: 'NOT_FOUND_IN_MANIFEST',
        });
        expect(id1).not.toBe(id2);
    });

    it('handles missing expectedHash gracefully', async () => {
        const id = await generateBlockId({
            status: 'MISMATCH',
            fileKey: '/app.js',
            actualHash: 'hash',
        });
        expect(id).toMatch(/^block_[0-9a-f]{16}$/);
    });

    it('throws when status is missing', async () => {
        await expect(generateBlockId({ fileKey: '/app.js' })).rejects.toThrow(
            'Missing required parameters'
        );
    });

    it('produces a stable id when only status is set (manifest-load errors)', async () => {
        const id = await generateBlockId({ status: 'CONFIG_ERROR' });
        expect(id).toMatch(/^block_[0-9a-f]{16}$/);
        const id2 = await generateBlockId({ status: 'CONFIG_ERROR' });
        expect(id2).toBe(id);
    });
});
