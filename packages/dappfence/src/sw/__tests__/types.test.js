import { describe, it, expect } from 'vitest';
import { shouldVerifyAsset } from '../manifest/operations.js';
import {
    DEFAULT_SECURITY_CONTENT_TYPES,
    DEFAULT_SECURITY_EXTENSIONS,
    VERIFICATION_STATUS,
} from '../../core/constants.js';

const EMPTY_RESPONSE = new Response('');
const responseWithType = (mime) => new Response('', { headers: { 'content-type': mime } });

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
                EMPTY_RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(true);
    });

    it('verifies JS files with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/app.js',
                false,
                EMPTY_RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(true);
    });

    it('verifies CSS files with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/style.css',
                false,
                EMPTY_RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(true);
    });

    it('verifies HTML files with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/page.html',
                false,
                EMPTY_RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(true);
    });

    it('does not verify images with default extensions and a non-text content-type', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/logo.png',
                false,
                responseWithType('image/png'),
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(false);
    });

    it('does not verify fonts with default extensions and a non-text content-type', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/font.woff2',
                false,
                responseWithType('font/woff2'),
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(false);
    });

    it('matches files against the provided extensions list', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/module.wasm',
                false,
                EMPTY_RESPONSE,
                ['.wasm', '.js'],
                []
            )
        ).toBe(true);
    });

    it('rejects files not in the provided extensions or content-type lists', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/app.js',
                false,
                EMPTY_RESPONSE,
                ['.wasm'],
                ['image/png']
            )
        ).toBe(false);
    });

    it('verifies .json with default extensions', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/app.json',
                false,
                EMPTY_RESPONSE,
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(true);
    });

    it('verifies extensionless URLs when content-type is in the list', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('application/json'),
                [],
                ['application/json']
            )
        ).toBe(true);
    });

    it('strips charset parameters from content-type before matching', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('application/json; charset=utf-8'),
                [],
                ['application/json']
            )
        ).toBe(true);
    });

    it('matches content-type case-insensitively', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('Application/JSON'),
                [],
                ['application/json']
            )
        ).toBe(true);
    });

    it('does not verify when neither extension nor content-type matches', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/data.bin',
                false,
                responseWithType('application/octet-stream'),
                DEFAULT_SECURITY_EXTENSIONS,
                DEFAULT_SECURITY_CONTENT_TYPES
            )
        ).toBe(false);
    });

    it('falls through when content-type header is missing', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/extensionless',
                false,
                EMPTY_RESPONSE,
                ['.js'],
                ['application/json']
            )
        ).toBe(false);
    });
});
