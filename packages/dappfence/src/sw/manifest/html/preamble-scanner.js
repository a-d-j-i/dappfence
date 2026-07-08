import { createLogger } from '../../../core/logger.js';

// Byte constants
const LT = 0x3c; // <
const GT = 0x3e; // >
const BANG = 0x21; // !
const DASH = 0x2d; // -
const SLASH = 0x2f; // /
const QUEST = 0x3f; // ?
const DQ = 0x22; // "
const SQ = 0x27; // '
const NUL = 0x00;

const PREAMBLE_LIMIT = 8 * 1024;
const MAX_TAG_NAME = 20;
const DOCTYPE_CHARS = 'DOCTYPE';

const logger = createLogger('preamble-scanner');

class PreambleViolation extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'PreambleViolation';
    }
}

// Parser states
const S_INITIAL = 'I';
const S_BOM1 = 'B1';
const S_BOM2 = 'B2';
const S_BETWEEN = 'W';
const S_OPEN = 'O';
const S_BANG = 'BA';
const S_BANG_DASH = 'BD';
const S_COMMENT = 'CO';
const S_COMMENT_D1 = 'C1';
const S_COMMENT_D2 = 'C2';
const S_DOCTYPE_MATCH = 'DM';
const S_DOCTYPE_BODY = 'DB';
const S_PI = 'PI';
const S_BOGUS = 'BG';
const S_TAG_NAME = 'TN';
const S_TAG_BODY = 'TB';
const S_TAG_DQ = 'TD';
const S_TAG_SQ = 'TS';

function isWhitespace(b) {
    return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function isAlpha(b) {
    return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

/**
 * Create a streaming preamble scanner. Call push(chunk) for each incoming
 * chunk; it returns the injection offset (number), a violation object, or null
 * if more data is needed.
 *
 * Accepted token sequence (strict allowlist — anything else is a violation):
 *   [UTF-8 BOM] [whitespace] <!DOCTYPE...> [whitespace|comments|PIs|bogus]* [<html...>]? [whitespace|comments|PIs|bogus]* <head...>
 */
export function createPreambleScanner() {
    const _state = {
        s: S_INITIAL,
        seenDoctype: false,
        seenHtml: false,
        tagName: '',
        matchLen: 0,
        totalPos: 0,
    };

    function closeTag() {
        const name = _state.tagName;
        _state.tagName = '';

        if (name === 'head') {
            if (!_state.seenDoctype) {
                throw new PreambleViolation('<head> appears before <!DOCTYPE>');
            }
            return true; // signals head found; push() converts to local chunk offset
        }

        if (name === 'html') {
            if (!_state.seenDoctype) {
                throw new PreambleViolation('<html> appears before <!DOCTYPE>');
            }
            if (_state.seenHtml) {
                throw new PreambleViolation('duplicate <html> tag');
            }
            _state.seenHtml = true;
            _state.s = S_BETWEEN;
            return null;
        }

        throw new PreambleViolation(`unexpected element <${name}> before <head>`);
    }

    function step(b) {
        switch (_state.s) {
            case S_INITIAL:
                if (b === 0xfe || b === 0xff) {
                    throw new PreambleViolation('UTF-16 BOM — document encoding unsupported');
                }
                if (b === 0xef) {
                    _state.s = S_BOM1;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte at start of document');
                }
                _state.s = S_BETWEEN;
            // fall through to S_BETWEEN to handle whitespace and '<'

            // eslint-disable-next-line no-fallthrough
            case S_BETWEEN:
                if (isWhitespace(b)) {
                    return null;
                }
                if (b === LT) {
                    _state.s = S_OPEN;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                throw new PreambleViolation(
                    `unexpected byte 0x${b.toString(16).padStart(2, '00')} before <head>`
                );

            case S_BOM1:
                if (b === 0xbb) {
                    _state.s = S_BOM2;
                    return null;
                }
                throw new PreambleViolation('non-ASCII byte at start of document');

            case S_BOM2:
                if (b === 0xbf) {
                    _state.s = S_BETWEEN;
                    return null;
                }
                throw new PreambleViolation('non-ASCII byte at start of document');

            case S_OPEN:
                if (b === BANG) {
                    _state.s = S_BANG;
                    return null;
                }
                if (b === QUEST) {
                    _state.s = S_PI;
                    return null;
                }
                if (b === SLASH) {
                    throw new PreambleViolation('closing tag before <head>');
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in tag name');
                }
                if (isAlpha(b)) {
                    _state.s = S_TAG_NAME;
                    _state.tagName = String.fromCharCode(b | 0x20); // lowercase first char
                    return null;
                }
                throw new PreambleViolation(
                    `unexpected byte 0x${b.toString(16).padStart(2, '00')} in tag`
                );

            case S_BANG:
                if (b === DASH) {
                    _state.s = S_BANG_DASH;
                    return null;
                }
                if ((b | 0x20) === 0x64) {
                    // 'd' — potential start of DOCTYPE
                    _state.s = S_DOCTYPE_MATCH;
                    _state.matchLen = 1; // 'D' already matched
                    return null;
                }
                if (b === GT) {
                    _state.s = S_BETWEEN;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                _state.s = S_BOGUS;
                return null;

            case S_BANG_DASH:
                if (b === DASH) {
                    _state.s = S_COMMENT;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                _state.s = S_BOGUS;
                return null;

            case S_DOCTYPE_MATCH: {
                const expected = DOCTYPE_CHARS.charCodeAt(_state.matchLen);
                if ((b | 0x20) === (expected | 0x20)) {
                    _state.matchLen++;
                    if (_state.matchLen === DOCTYPE_CHARS.length) {
                        _state.s = S_DOCTYPE_BODY;
                        _state.matchLen = 0;
                    }
                    return null;
                }
                if (b === GT) {
                    _state.s = S_BETWEEN;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                _state.s = S_BOGUS;
                return null;
            }

            case S_DOCTYPE_BODY:
                if (b === GT) {
                    if (_state.seenDoctype) {
                        throw new PreambleViolation('duplicate <!DOCTYPE>');
                    }
                    _state.seenDoctype = true;
                    _state.s = S_BETWEEN;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                return null;

            case S_COMMENT:
                if (b === DASH) {
                    _state.s = S_COMMENT_D1;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in comment');
                }
                return null;

            case S_COMMENT_D1:
                if (b === DASH) {
                    _state.s = S_COMMENT_D2;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in comment');
                }
                _state.s = S_COMMENT;
                return null;

            case S_COMMENT_D2:
                if (b === GT) {
                    _state.s = S_BETWEEN;
                    return null;
                }
                if (b === DASH) {
                    return null; // stay in D2: handles --->, ---->, etc.
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in comment');
                }
                _state.s = S_COMMENT;
                return null;

            case S_PI:
                if (b === GT) {
                    _state.s = S_BETWEEN;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                return null;

            case S_BOGUS:
                if (b === GT) {
                    _state.s = S_BETWEEN;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in preamble');
                }
                return null;

            case S_TAG_NAME:
                if (b === GT) {
                    return closeTag();
                }
                if (isWhitespace(b) || b === SLASH) {
                    _state.s = S_TAG_BODY;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in tag name');
                }
                _state.tagName += String.fromCharCode(b | 0x20);
                if (_state.tagName.length >= MAX_TAG_NAME) {
                    throw new PreambleViolation(
                        `unexpected element <${_state.tagName}...> before <head>`
                    );
                }
                return null;

            case S_TAG_BODY:
                if (b === GT) {
                    return closeTag();
                }
                if (b === DQ) {
                    _state.s = S_TAG_DQ;
                    return null;
                }
                if (b === SQ) {
                    _state.s = S_TAG_SQ;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in tag');
                }
                return null;

            case S_TAG_DQ:
                if (b === DQ) {
                    _state.s = S_TAG_BODY;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in tag');
                }
                return null;

            case S_TAG_SQ:
                if (b === SQ) {
                    _state.s = S_TAG_BODY;
                    return null;
                }
                if (b === NUL) {
                    throw new PreambleViolation('null byte in tag');
                }
                return null;

            default:
                throw new PreambleViolation(`internal: unknown state ${_state.s}`);
        }
    }

    return {
        get totalPos() {
            return _state.totalPos;
        },
        /**
         * Feed a new chunk to the scanner.
         *
         * Returns the absolute byte offset immediately after the closing '>' of
         * <head ...> when found. Returns { violation: string } on any structural
         * violation. Returns null if more data is needed.
         */
        push(chunk) {
            try {
                for (let i = 0; i < chunk.length; i++) {
                    const b = chunk[i];
                    _state.totalPos++;
                    if (step(b) !== null) {
                        return i + 1; // local offset within this chunk
                    }
                }
                if (_state.totalPos >= PREAMBLE_LIMIT) {
                    logger.warn('Preamble violation: <head> not found within 8 KB limit');
                    return { violation: '<head> not found within 8 KB limit' };
                }
            } catch (err) {
                if (err instanceof PreambleViolation) {
                    logger.warn('Preamble violation:', err.message);
                    return { violation: err.message };
                }
                throw err;
            }
            return null;
        },
    };
}
