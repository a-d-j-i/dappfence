/**
 * DappFence extension icon generator.
 *
 * Produces icon-{16,32,48,128}.png entirely in JS — keeps the source tree
 * binary-free. Design: rounded shield with blue gradient, green border,
 * and a ☠ skull behind an iron-gray fence.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const SHIELD_TOP = [0x60, 0xa5, 0xfa]; // blue-400
const SHIELD_BOT = [0x1e, 0x3a, 0x8a]; // indigo-900
const IRON = [0x96, 0x48, 0x3c]; // rust red iron

function lerp3(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

// True when (nx, ny) is inside the shield: rectangle with rounded top corners
// from t to m, then an elliptical lower half from m to b.
function hitShield(nx, ny, l, r, t, m, b, cr) {
    if (ny < t || ny > b) return false;
    if (ny <= m) {
        if (nx < l || nx > r) return false;
        if (ny < t + cr) {
            if (nx < l + cr && Math.hypot(nx - (l + cr), ny - (t + cr)) > cr) return false;
            if (nx > r - cr && Math.hypot(nx - (r - cr), ny - (t + cr)) > cr) return false;
        }
        return true;
    }
    const dx = nx - 0.5,
        dy = ny - m;
    const rx = (r - l) / 2,
        ry = b - m;
    return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

// True when (nx, ny) is inside a bone shape: cylindrical shaft from (x1,y1)
// to (x2,y2) of half-width sw/2, capped with circles of radius cr at each end.
function inBone(nx, ny, x1, y1, x2, y2, sw, cr) {
    if (Math.hypot(nx - x1, ny - y1) <= cr) return true;
    if (Math.hypot(nx - x2, ny - y2) <= cr) return true;
    const bx = x2 - x1,
        by = y2 - y1;
    const len = Math.hypot(bx, by);
    if (len === 0) return false;
    const px = nx - x1,
        py = ny - y1;
    const proj = (px * bx + py * by) / len;
    if (proj < 0 || proj > len) return false;
    return Math.abs(px * by - py * bx) / len <= sw / 2;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (const b of buf) {
        crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crc]);
};

function shieldPixel(px, py, size) {
    const nx = (px + 0.5) / size;
    const ny = (py + 0.5) / size;

    const L = 0.12,
        R = 0.88,
        T = 0.05,
        M = 0.52,
        B = 0.94;
    const bw = Math.max(1, Math.round(size * 0.04)) / size;
    const cr = Math.max(bw * 2, 0.09);

    if (!hitShield(nx, ny, L, R, T, M, B, cr)) return [0, 0, 0, 0];

    const innerT = T + bw;
    if (!hitShield(nx, ny, L + bw, R - bw, innerT, M, B - bw, Math.max(0, cr - bw))) {
        return [0x22, 0xc5, 0x5e, 255]; // green border
    }

    // Top-to-bottom gradient: bright blue → deep indigo
    const [r, g, b] = lerp3(SHIELD_TOP, SHIELD_BOT, Math.max(0, (ny - T) / (B - T)));

    // Top gloss highlight
    let fr = r,
        fg = g,
        fb = b;
    if (ny < 0.28) {
        const hf = 0.28 * (1 - ny / 0.28);
        fr = Math.round(r + (255 - r) * hf);
        fg = Math.round(g + (255 - g) * hf);
        fb = Math.round(b + (255 - b) * hf);
    }

    // Rusty iron fence: five full-height pickets with pointed tips + mid rail (checked first = in front)
    const pw = Math.max(0.025, 2 / size);
    const fenceL = L + bw,
        fenceR = R - bw;
    const tipTop = T + bw,
        taperH = 0.06;

    if (ny >= 0.72 && ny <= 0.77 && nx >= fenceL && nx <= fenceR) return [...IRON, 255];

    for (const cx of [0.24, 0.36, 0.5, 0.64, 0.76]) {
        if (ny >= tipTop && ny < tipTop + taperH) {
            if (Math.abs(nx - cx) <= (pw / 2) * ((ny - tipTop) / taperH)) return [...IRON, 255];
        }
        if (Math.abs(nx - cx) <= pw / 2 && ny >= tipTop + taperH && ny <= B - bw) {
            return [...IRON, 255];
        }
    }

    // ☠ U+2620 — drawn after fence so bars appear in front of it
    // Skull cranium with eye sockets and nose hole
    const skullCx = 0.5,
        skullCy = 0.38;
    if (Math.hypot(nx - skullCx, ny - skullCy) <= 0.14) {
        const lEye = Math.hypot(nx - (skullCx - 0.055), ny - (skullCy - 0.03)) <= 0.038;
        const rEye = Math.hypot(nx - (skullCx + 0.055), ny - (skullCy - 0.03)) <= 0.038;
        const nose = Math.hypot(nx - skullCx, ny - (skullCy + 0.025)) <= 0.024;
        if (!lEye && !rEye && !nose) return [0, 0, 0, 255];
    }
    // Teeth just below cranium
    if (ny >= skullCy + 0.14 && ny <= skullCy + 0.178) {
        for (const tx of [skullCx - 0.052, skullCx, skullCx + 0.052]) {
            if (Math.abs(nx - tx) <= 0.02) return [0, 0, 0, 255];
        }
    }
    // Crossbones (visible in gaps between fence bars)
    if (
        inBone(nx, ny, 0.3, 0.7, 0.7, 0.5, 0.055, 0.042) ||
        inBone(nx, ny, 0.7, 0.7, 0.3, 0.5, 0.055, 0.042)
    ) {
        return [0, 0, 0, 255];
    }

    return [fr, fg, fb, 255];
}

function makePng(size) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    // ihdr[10..12] left zero — default compression/filter/interlace.
    const stride = 1 + size * 4;
    const raw = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) {
        const row = y * stride;
        raw[row] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const off = row + 1 + x * 4;
            const [r, g, b, a] = shieldPixel(x, y, size);
            raw[off] = r;
            raw[off + 1] = g;
            raw[off + 2] = b;
            raw[off + 3] = a;
        }
    }
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

export function generateIcons(dist) {
    for (const size of [16, 32, 48, 128]) {
        writeFileSync(join(dist, `icon-${size}.png`), makePng(size));
    }
}
