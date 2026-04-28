import { describe, it, expect } from 'vitest';
import {
    createSyntheticAppVersion,
    shouldVerifyAsset,
    VERIFICATION_STATUS,
} from '../manifest/verification-helpers.js';
import { DEFAULT_SECURITY_EXTENSIONS } from '../../core/constants.js';

describe('createSyntheticAppVersion', () => {
    it('creates a version string from manifest data', async () => {
        const mockHash = async () => 'abcdef1234567890abcdef';
        const version = await createSyntheticAppVersion({ files: {} }, mockHash);
        expect(version).toBe('manifest-abcdef1234567890');
    });

    it('produces different versions for different manifests', async () => {
        let callCount = 0;
        const mockHash = async () => {
            callCount++;
            return callCount === 1 ? 'aaaa' : 'bbbb';
        };
        const v1 = await createSyntheticAppVersion({ files: { a: '1' } }, mockHash);
        const v2 = await createSyntheticAppVersion({ files: { b: '2' } }, mockHash);
        expect(v1).not.toBe(v2);
    });
});

describe('VERIFICATION_STATUS', () => {
    it('has all expected statuses', () => {
        expect(VERIFICATION_STATUS.MATCH).toBe('MATCH');
        expect(VERIFICATION_STATUS.MISMATCH).toBe('MISMATCH');
        expect(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST).toBe('NOT_FOUND_IN_MANIFEST');
        expect(VERIFICATION_STATUS.ERROR).toBe('VERIFICATION_ERROR');
    });
});

describe('shouldVerifyAsset', () => {
    it('always verifies navigation requests', () => {
        expect(
            shouldVerifyAsset('https://example.com/image.png', true, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(true);
    });

    it('verifies JS files with default extensions', () => {
        expect(
            shouldVerifyAsset('https://example.com/app.js', false, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(true);
    });

    it('verifies CSS files with default extensions', () => {
        expect(
            shouldVerifyAsset('https://example.com/style.css', false, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(true);
    });

    it('verifies HTML files with default extensions', () => {
        expect(
            shouldVerifyAsset('https://example.com/page.html', false, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(true);
    });

    it('does not verify images with default extensions', () => {
        expect(
            shouldVerifyAsset('https://example.com/logo.png', false, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(false);
    });

    it('does not verify fonts with default extensions', () => {
        expect(
            shouldVerifyAsset('https://example.com/font.woff2', false, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(false);
    });

    it('matches files against the provided extensions list', () => {
        expect(shouldVerifyAsset('https://example.com/module.wasm', false, ['.wasm', '.js'])).toBe(
            true
        );
    });

    it('rejects files not in the provided extensions list', () => {
        expect(shouldVerifyAsset('https://example.com/app.js', false, ['.wasm'])).toBe(false);
    });

    it('verifies .json with default extensions', () => {
        expect(
            shouldVerifyAsset('https://example.com/app.json', false, DEFAULT_SECURITY_EXTENSIONS)
        ).toBe(true);
    });
});
