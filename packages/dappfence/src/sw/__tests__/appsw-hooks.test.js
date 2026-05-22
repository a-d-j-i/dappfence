import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyImportedScript } from '../appsw-hooks.js';
import { ASSET_TYPE, VERIFICATION_STATUS } from '../../core/constants.js';

describe('verifyImportedScript', () => {
    let core;

    beforeEach(() => {
        core = {
            manifestService: { verifyLocation: vi.fn() },
            appStore: { recordSecurityViolation: vi.fn() },
        };
    });

    it('does not record a violation on MATCH', async () => {
        core.manifestService.verifyLocation.mockResolvedValue({
            status: VERIFICATION_STATUS.MATCH,
        });

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.manifestService.verifyLocation).toHaveBeenCalledWith(
            'https://example.com/lib.js'
        );
        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });

    it('records a service-worker violation on MISMATCH', async () => {
        core.manifestService.verifyLocation.mockResolvedValue({
            status: VERIFICATION_STATUS.MISMATCH,
            fileKey: '/lib.js',
        });

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.MISMATCH,
                assetType: ASSET_TYPE.SERVICE_WORKER,
                url: 'https://example.com/lib.js',
            })
        );
    });

    it('records a service-worker violation when verifyLocation returns ERROR', async () => {
        core.manifestService.verifyLocation.mockResolvedValue({
            status: VERIFICATION_STATUS.ERROR,
        });

        await verifyImportedScript(core, 'https://example.com/missing.js');

        expect(core.appStore.recordSecurityViolation).toHaveBeenCalledWith(
            expect.objectContaining({
                status: VERIFICATION_STATUS.ERROR,
                assetType: ASSET_TYPE.SERVICE_WORKER,
                url: 'https://example.com/missing.js',
            })
        );
    });

    it('treats SKIPPED results as non-violations', async () => {
        core.manifestService.verifyLocation.mockResolvedValue({
            status: VERIFICATION_STATUS.SKIPPED,
            fileKey: '/lib.js',
        });

        await verifyImportedScript(core, 'https://example.com/lib.js');

        expect(core.appStore.recordSecurityViolation).not.toHaveBeenCalled();
    });
});
