/**
 * Cryptographic utilities: hashing, SRI conversion, and Ethereum signature recovery.
 */

import { etc, hashes, Point, recoverPublicKey } from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';

hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
hashes.sha256 = sha256;

/**
 * Calculate SHA-256 hash of a buffer.
 * @param {ArrayBuffer|Uint8Array} buffer - Data to hash
 * @returns {Promise<string>} Hex string of the hash
 */
export async function calculateHash(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert SRI format hash to hex format.
 * @param {string} sriHash - SRI format hash (e.g., "sha256-abc123...")
 * @returns {string} Hex format hash
 */
export function sriToHex(sriHash) {
    if (!sriHash || !sriHash.startsWith('sha256-')) {
        return sriHash; // Return as-is if not SRI format
    }

    try {
        const base64Hash = sriHash.replace('sha256-', '');
        const binaryString = atob(base64Hash);
        const bytes = new Uint8Array(binaryString.length);

        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
    } catch (error) {
        console.warn('[DappFence Utils] Failed to convert SRI to hex:', sriHash, error);
        return sriHash; // Return original on error
    }
}

/**
 * Calculate Ethereum address from a compressed public key.
 * @param {Uint8Array} compressedPubKey - Compressed secp256k1 public key
 * @returns {string} Ethereum address with 0x prefix
 */
export function ethereumAddress(compressedPubKey) {
    const point = Point.fromBytes(compressedPubKey);
    const keccak = keccak_256(point.toBytes(false).slice(1));
    return '0x' + etc.bytesToHex(keccak.slice(-20));
}

/**
 * Recover Ethereum address from a message and secp256k1 signature.
 * @param {Uint8Array} msg - The original message bytes
 * @param {string} signature - Hex-encoded signature
 * @returns {string} Recovered Ethereum address
 */
export function recoverEthereumAddress(msg, signature) {
    const msgHash = keccak_256(msg);
    const sigBytes = etc.hexToBytes(signature);
    return ethereumAddress(recoverPublicKey(sigBytes, msgHash, { prehash: false }));
}

/**
 * Recover Ethereum address from a wallet personal_sign message using the signature.
 * @param {Uint8Array} msg - The original message bytes
 * @param {string} signature - Hex-encoded signature
 * @returns {string} Recovered Ethereum address
 */
export function recoverPersonalSign(msg, signature) {
    const msgHash = keccak_256(msg);
    const sigBytes = etc.hexToBytes(signature);

    // Message Hash
    const prefix = '\x19Ethereum Signed Message:\n';
    const messageHash = keccak_256(
        etc.concatBytes(new TextEncoder('utf-8').encode(prefix + msgHash.length), msgHash)
    );
    return ethereumAddress(recoverPublicKey(sigBytes, messageHash, { prehash: false }));
}
