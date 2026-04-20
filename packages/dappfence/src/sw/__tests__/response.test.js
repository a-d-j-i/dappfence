import { describe, it, expect } from 'vitest';
import { createBlockResponse, createNavigationWarningResponse } from '../response.js';

describe('createBlockResponse', () => {
    it('returns JS redirect when request targets the SW script', () => {
        const response = createBlockResponse(
            false,
            'https://example.com/sw.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('javascript');
    });

    it('returns HTML redirect for navigation requests', () => {
        const response = createBlockResponse(
            true,
            'https://example.com/app.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/html');
    });

    it('returns plain text warning for non-navigation subresource requests', () => {
        const response = createBlockResponse(
            false,
            'https://example.com/app.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });

    it('does not treat a cross-origin same-pathname URL as the SW script', () => {
        const response = createBlockResponse(
            false,
            'https://evil.com/sw.js',
            'https://example.com/sw.js'
        );
        expect(response.headers.get('Content-Type')).toContain('text/plain');
        expect(response.status).toBe(403);
    });
});

describe('createNavigationWarningResponse', () => {
    it('returns a 302 redirect to the static warning page', () => {
        const response = createNavigationWarningResponse();
        expect(response.status).toBe(302);
        expect(response.headers.get('Location')).toBe('/sw-api/security-warning');
    });
});

describe('createBlockResponse edge cases', () => {
    it('handles invalid locationHref gracefully in SW path check', () => {
        const response = createBlockResponse(
            false,
            'https://example.com/app.js',
            'not-a-valid-url'
        );
        expect(response.status).toBe(403);
    });
});
