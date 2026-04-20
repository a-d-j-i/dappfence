/**
 * Monkey patching utilities for intercepting method calls.
 */

/**
 * Monkey patch a method on a target object.
 * @param {object} target - Object to patch
 * @param {string} methodName - Method name to patch
 * @param {function} handler - Handler function that receives (context, ...args)
 * @returns {function} Restore function to undo the patch
 */
export function monkeyPatch(target, methodName, handler) {
    const original = target[methodName];

    const ctx = {
        original,
        target,
        methodName,
        call: (...args) => original.apply(target, args),
        apply: (thisArg, args) => original.apply(thisArg, args),
    };

    target[methodName] = function (...args) {
        return handler.call(this, ctx, ...args);
    };

    // Return restore function
    return () => {
        target[methodName] = original;
    };
}

/**
 * ANTI-TAMPERING: Immutable monkey patch that prevents restoration.
 * Uses Object.defineProperty with non-writable, non-configurable descriptors.
 * @param {object} target - Object to patch
 * @param {string} methodName - Method name to patch
 * @param {function} handler - Handler function that receives (context, ...args)
 * @returns {object} Patch status and integrity verification function
 */
export function secureMonkeyPatch(target, methodName, handler) {
    const original = target[methodName];

    // Store the original descriptor for integrity checks
    const originalDescriptor = Object.getOwnPropertyDescriptor(target, methodName) || {
        value: original,
        writable: true,
        enumerable: true,
        configurable: true,
    };

    const ctx = {
        original,
        target,
        methodName,
        call: (...args) => original.apply(target, args),
        apply: (thisArg, args) => original.apply(thisArg, args),
    };

    const patchedFunction = function (...args) {
        return handler.call(this, ctx, ...args);
    };

    try {
        // Apply an immutable patch with a non-configurable descriptor
        Object.defineProperty(target, methodName, {
            value: patchedFunction,
            writable: false, // Prevent direct assignment
            enumerable: originalDescriptor.enumerable,
            configurable: false, // Prevent descriptor changes
        });

        console.log(
            `[DappFence] 🔒 Secure patch applied to ${target.constructor?.name || 'Object'}.${methodName}`
        );

        return {
            success: true,
            target,
            methodName,
            // Integrity verification function
            verify: () => {
                try {
                    const currentDescriptor = Object.getOwnPropertyDescriptor(target, methodName);
                    const isIntact =
                        currentDescriptor &&
                        currentDescriptor.value === patchedFunction &&
                        currentDescriptor.writable === false &&
                        currentDescriptor.configurable === false;

                    if (!isIntact) {
                        console.error(
                            `[DappFence] 🚨 TAMPERING DETECTED: ${target.constructor?.name || 'Object'}.${methodName} has been modified!`
                        );
                    }

                    return isIntact;
                } catch (error) {
                    console.error(
                        `[DappFence] Integrity verification failed for ${methodName}:`,
                        error
                    );
                    return false;
                }
            },
        };
    } catch (error) {
        console.error(`[DappFence] Failed to apply secure patch to ${methodName}:`, error);
        return {
            success: false,
            error: error.message,
        };
    }
}

/**
 * Verify the integrity of multiple secure patches.
 * @param {Array} patches - Array of patch objects from secureMonkeyPatch
 * @returns {object} Verification results
 */
export function verifyPatchIntegrity(patches) {
    const results = {
        totalPatches: patches.length,
        intactPatches: 0,
        compromisedPatches: [],
        allIntact: true,
    };

    for (const patch of patches) {
        if (patch.success && patch.verify) {
            const isIntact = patch.verify();
            if (isIntact) {
                results.intactPatches++;
            } else {
                results.compromisedPatches.push(
                    `${patch.target.constructor?.name || 'Object'}.${patch.methodName}`
                );
                results.allIntact = false;
            }
        }
    }

    if (!results.allIntact) {
        console.error(
            `[DappFence] 🚨 SECURITY ALERT: ${results.compromisedPatches.length} patches compromised:`,
            results.compromisedPatches
        );
    }

    return results;
}
