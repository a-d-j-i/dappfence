import { describe, it, expect } from 'vitest';
import { createSwContext } from '../context.js';

function createMockGlobal() {
    return {
        location: {
            href: 'https://example.com/sw.js',
            origin: 'https://example.com',
        },
        clients: {
            matchAll: async (opts) => [{ id: 'client-1', opts }],
            get: async (id) => ({ id }),
            claim: async () => 'claimed',
        },
        navigator: { userAgent: 'TestAgent/1.0' },
        skipWaiting: async () => 'skipped',
        fetch: async (input, init) => ({ input, init }),
    };
}

describe('createSwContext', () => {
    it('getLocationHref delegates to global', () => {
        const ctx = createSwContext(createMockGlobal());
        expect(ctx.getLocationHref()).toBe('https://example.com/sw.js');
    });

    it('getLocationOrigin delegates to global', () => {
        const ctx = createSwContext(createMockGlobal());
        expect(ctx.getLocationOrigin()).toBe('https://example.com');
    });

    it('getLocation returns the location object', () => {
        const ctx = createSwContext(createMockGlobal());
        const loc = ctx.getLocation();
        expect(loc.href).toBe('https://example.com/sw.js');
        expect(loc.origin).toBe('https://example.com');
    });

    it('matchAllClients delegates to clients.matchAll', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.matchAllClients({ type: 'window' });
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('client-1');
    });

    it('getClient delegates to clients.get', async () => {
        const ctx = createSwContext(createMockGlobal());
        const client = await ctx.getClient('client-1');
        expect(client.id).toBe('client-1');
    });

    it('claimClients delegates to clients.claim', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.claimClients();
        expect(result).toBe('claimed');
    });

    it('skipWaiting delegates to global', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.skipWaiting();
        expect(result).toBe('skipped');
    });

    it('fetch delegates to global', async () => {
        const ctx = createSwContext(createMockGlobal());
        const result = await ctx.fetch('https://example.com/data', { method: 'GET' });
        expect(result.input).toBe('https://example.com/data');
        expect(result.init).toEqual({ method: 'GET' });
    });

    it('getUserAgent delegates to navigator', () => {
        const ctx = createSwContext(createMockGlobal());
        expect(ctx.getUserAgent()).toBe('TestAgent/1.0');
    });

    it('reads values lazily (not captured at creation)', () => {
        const mock = createMockGlobal();
        const ctx = createSwContext(mock);

        // Mutate the mock after context creation
        mock.location.origin = 'https://changed.com';
        expect(ctx.getLocationOrigin()).toBe('https://changed.com');
    });
});
