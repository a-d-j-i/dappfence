import { describe, it, expect } from 'vitest';
import { monkeyPatch, secureMonkeyPatch, verifyPatchIntegrity } from '../monkey-patch.js';

describe('monkeyPatch', () => {
    it('intercepts method calls with the handler', () => {
        const target = { greet: (name) => `hello ${name}` };
        monkeyPatch(target, 'greet', (ctx, name) => `patched: ${ctx.call(name)}`);

        expect(target.greet('world')).toBe('patched: hello world');
    });

    it('provides ctx.call to invoke the original', () => {
        const target = { add: (a, b) => a + b };
        let captured;
        monkeyPatch(target, 'add', (ctx, a, b) => {
            captured = ctx.call(a, b);
            return captured + 1;
        });

        expect(target.add(2, 3)).toBe(6);
        expect(captured).toBe(5);
    });

    it('returns a restore function that undoes the patch', () => {
        const original = (x) => x * 2;
        const target = { fn: original };
        const restore = monkeyPatch(target, 'fn', (ctx, x) => ctx.call(x) + 10);

        expect(target.fn(5)).toBe(20);
        restore();
        expect(target.fn(5)).toBe(10);
    });

    it('passes all arguments to the handler', () => {
        const target = { fn: () => {} };
        const args = [];
        monkeyPatch(target, 'fn', (ctx, ...a) => args.push(...a));

        target.fn('a', 'b', 'c');
        expect(args).toEqual(['a', 'b', 'c']);
    });
});

describe('secureMonkeyPatch', () => {
    it('applies a non-writable, non-configurable patch', () => {
        const target = { fn: () => 'original' };
        const result = secureMonkeyPatch(target, 'fn', (_ctx) => 'patched');

        expect(result.success).toBe(true);
        expect(target.fn()).toBe('patched');

        const desc = Object.getOwnPropertyDescriptor(target, 'fn');
        expect(desc.writable).toBe(false);
        expect(desc.configurable).toBe(false);
    });

    it('verify returns true when patch is intact', () => {
        const target = { fn: () => 'original' };
        const result = secureMonkeyPatch(target, 'fn', (_ctx) => 'patched');

        expect(result.verify()).toBe(true);
    });

    it('intercepts calls through the handler', () => {
        const target = { fn: (x) => x };
        secureMonkeyPatch(target, 'fn', (ctx, x) => ctx.call(x) + 1);

        expect(target.fn(10)).toBe(11);
    });
});

describe('verifyPatchIntegrity', () => {
    it('reports all patches intact', () => {
        const target = { a: () => {}, b: () => {} };
        const patchA = secureMonkeyPatch(target, 'a', () => {});
        const patchB = secureMonkeyPatch(target, 'b', () => {});

        const result = verifyPatchIntegrity([patchA, patchB]);
        expect(result.allIntact).toBe(true);
        expect(result.intactPatches).toBe(2);
        expect(result.compromisedPatches).toEqual([]);
    });

    it('detects compromised patches', () => {
        const patch = {
            success: true,
            target: { constructor: { name: 'FakeTarget' } },
            methodName: 'fn',
            verify: () => false,
        };

        const result = verifyPatchIntegrity([patch]);
        expect(result.allIntact).toBe(false);
        expect(result.compromisedPatches).toEqual(['FakeTarget.fn']);
    });

    it('handles failed patches gracefully', () => {
        const result = verifyPatchIntegrity([{ success: false }]);
        expect(result.allIntact).toBe(true);
        expect(result.intactPatches).toBe(0);
    });
});
