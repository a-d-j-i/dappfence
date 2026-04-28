import { describe, it, expect } from 'vitest';
import { shouldVerifyAsset } from '../manifest/operations.js';
import { DEFAULT_SECURITY_EXTENSIONS, VERIFICATION_STATUS } from '../../core/constants.js';

const RESPONSE = new Response('');

describe('VERIFICATION_STATUS', () => {
    it('exposes a description and isViolation flag for each verdict', () => {
        expect(VERIFICATION_STATUS.MATCH.description).toBe('MATCH');
        expect(VERIFICATION_STATUS.MATCH.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.SKIPPED.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.MISMATCH.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.NOT_FOUND_IN_MANIFEST.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.ERROR.description).toBe('VERIFICATION_ERROR');
        expect(VERIFICATION_STATUS.ERROR.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.UNSUPPORTED_SIGNATURE.isViolation).toBe(true);
        expect(VERIFICATION_STATUS.CONFIG_ERROR.isViolation).toBe(true);
    });
});

describe('shouldVerifyAsset', () => {
    it('always verifies navigation requests', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/image.png',
                true,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(true);
    });

    it('verifies JS files with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/app.js',
                false,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(true);
    });

    it('verifies CSS files with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/style.css',
                false,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(true);
    });

    it('verifies HTML files with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/page.html',
                false,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(true);
    });

    it('does not verify images with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/logo.png',
                false,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(false);
    });

    it('does not verify fonts with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/font.woff2',
                false,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(false);
    });

    it('matches files against the provided extensions list', () => {
        expect(
            shouldVerifyAsset('https://example.com/module.wasm', false, RESPONSE, ['.wasm', '.js'])
        ).toBe(true);
    });

    it('rejects files not in the provided extensions list', () => {
        expect(shouldVerifyAsset('https://example.com/app.js', false, RESPONSE, ['.wasm'])).toBe(
            false
        );
    });

    it('verifies .json with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/app.json',
                false,
                RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS
            )
        ).toBe(true);
    });
});
