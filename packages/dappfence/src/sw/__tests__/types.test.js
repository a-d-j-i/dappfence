import { describe, it, expect } from 'vitest';
import { shouldVerifyAsset } from '../manifest/verification.js';
import { VERIFICATION_STATUS } from '../../core/constants.js';

const EMPTY_RESPONSE = new Response('');
const responseWithType = (mime) => new Response('', { headers: { 'content-type': mime } });

describe('VERIFICATION_STATUS', () => {
    it('exposes a description and isViolation flag for each verdict', () => {
        expect(VERIFICATION_STATUS.MATCH.description).toBe('MATCH');
        expect(VERIFICATION_STATUS.MATCH.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.SKIPPED.isViolation).toBe(false);
        expect(VERIFICATION_STATUS.REWRITE.description).toBe('REWRITE');
        expect(VERIFICATION_STATUS.REWRITE.isViolation).toBe(false);
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
        expect(shouldVerifyAsset('https://example.com/image.png', true, EMPTY_RESPONSE)).toBe(true);
    });

    it('verifies JS files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/app.js', false, EMPTY_RESPONSE)).toBe(true);
    });

    it('verifies MJS files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/app.mjs', false, EMPTY_RESPONSE)).toBe(true);
    });

    it('verifies CSS files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/style.css', false, EMPTY_RESPONSE)).toBe(
            true
        );
    });

    it('verifies HTML files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/page.html', false, EMPTY_RESPONSE)).toBe(
            true
        );
    });

    it('verifies HTM files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/page.htm', false, EMPTY_RESPONSE)).toBe(true);
    });

    it('verifies JSON files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/app.json', false, EMPTY_RESPONSE)).toBe(true);
    });

    it('verifies WASM files by default extension', () => {
        expect(shouldVerifyAsset('https://example.com/module.wasm', false, EMPTY_RESPONSE)).toBe(
            true
        );
    });

    it('does not verify images', () => {
        expect(
            shouldVerifyAsset('https://example.com/logo.png', false, responseWithType('image/png'))
        ).toBe(false);
    });

    it('does not verify fonts', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/font.woff2',
                false,
                responseWithType('font/woff2')
            )
        ).toBe(false);
    });

    it('verifies extensionless URL served as text/javascript', () => {
        expect(
            shouldVerifyAsset('/.netlify/scripts/cdp', false, responseWithType('text/javascript'))
        ).toBe(true);
    });

    it('verifies extensionless URL served as application/javascript', () => {
        expect(
            shouldVerifyAsset(
                '/.netlify/scripts/cdp',
                false,
                responseWithType('application/javascript')
            )
        ).toBe(true);
    });

    it('verifies extensionless URL served as application/wasm', () => {
        expect(shouldVerifyAsset('/module', false, responseWithType('application/wasm'))).toBe(
            true
        );
    });

    it('verifies extensionless URL when content-type is in the default list', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('application/json')
            )
        ).toBe(true);
    });

    it('verifies extensionless URL when content-type is in meta extras', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('application/x-custom'),
                { contentTypes: ['application/x-custom'] }
            )
        ).toBe(true);
    });

    it('verifies file matching a meta extra extension', () => {
        expect(
            shouldVerifyAsset('https://example.com/module.ts', false, EMPTY_RESPONSE, {
                extensions: ['.ts'],
            })
        ).toBe(true);
    });

    it('strips charset parameters from content-type before matching', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('application/json; charset=utf-8')
            )
        ).toBe(true);
    });

    it('matches content-type case-insensitively', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/api/config',
                false,
                responseWithType('Application/JSON')
            )
        ).toBe(true);
    });

    it('does not verify when neither extension nor content-type matches', () => {
        expect(
            shouldVerifyAsset(
                'https://example.com/data.bin',
                false,
                responseWithType('application/octet-stream')
            )
        ).toBe(false);
    });

    it('falls through when content-type header is missing', () => {
        expect(shouldVerifyAsset('https://example.com/extensionless', false, EMPTY_RESPONSE)).toBe(
            false
        );
    });
});
