// Matches the initializer script Next.js emits once per page:
//   self.__next_f=self.__next_f||[];self.__next_f.push([1,""])
const INITIALIZER_RE =
    /^\s*self\.__next_f\s*=\s*self\.__next_f\s*\|\|\s*\[\s*\]\s*;\s*self\.__next_f\.push\(\[\s*1\s*,\s*""\s*\]\)\s*$/;

const PUSH_PREFIX = 'self.__next_f.push(';

/**
 * Returns true if this script looks like an RSC wire-format script that this
 * validator handles. Scripts that return false here are left to #scripts hash
 * verification (not yet implemented = skipped today).
 *
 * @param {string} scriptContent — raw text between <script> and </script>
 * @returns {boolean}
 */
export function claimsScript(scriptContent) {
    return scriptContent.trimStart().startsWith('self.__next_f');
}

/**
 * Returns true if the inline script content conforms to the Next.js RSC
 * wire-format protocol and cannot execute arbitrary JavaScript.
 *
 * Two forms are accepted:
 *
 *   Initializer — emitted once per page:
 *     self.__next_f=self.__next_f||[];self.__next_f.push([1,""])
 *
 *   Push call — one per RSC payload chunk:
 *     self.__next_f.push([frameId, payload])
 *     where frameId is a number and payload is JSON-serializable.
 *
 * Anything with extra statements, non-JSON payloads, or a different
 * call target is rejected.
 *
 * @param {string} scriptContent — raw text between <script> and </script>
 * @returns {boolean}
 */
export function validateNextjsRsc(scriptContent) {
    const s = scriptContent.trim().replace(/;\s*$/, '');

    if (INITIALIZER_RE.test(s)) {
        return true;
    }

    if (!s.startsWith(PUSH_PREFIX) || !s.endsWith(')')) {
        return false;
    }

    // Extract the argument to push(…) and validate it as a JSON array.
    // Any extra statements corrupt the JSON and cause parse failure.
    const inner = s.slice(PUSH_PREFIX.length, -1);

    let parsed;
    try {
        parsed = JSON.parse(inner);
    } catch {
        return false;
    }

    if (!Array.isArray(parsed) || parsed.length !== 2) {
        return false;
    }

    if (typeof parsed[0] !== 'number') {
        return false;
    }

    return true;
}
