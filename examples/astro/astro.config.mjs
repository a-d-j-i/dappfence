// @ts-check

import { defineConfig, fontProviders } from 'astro/config';
import dappfence from '@dappfence/astro';

// Fallback key for local development — do NOT use in production.
// In production, set the DAPPFENCE_SECRET_KEY environment variable instead.
// Derived address: 0x101b8c4f4ac94ce506319d1ea0c098f84bfd291f
const DEV_SECRET_KEY = 'f0570667f49550681727162441fb99d8b54cba2920952e8f06cc9394f7e0a4be';

// https://astro.build/config
export default defineConfig({
    site: 'https://example.com',
    integrations: [
        dappfence({
            secretKey: DEV_SECRET_KEY, // overridden by DAPPFENCE_SECRET_KEY env var if set
        }),
    ],
    fonts: [
        {
            provider: fontProviders.local(),
            name: 'Atkinson',
            cssVariable: '--font-atkinson',
            fallbacks: ['sans-serif'],
            options: {
                variants: [
                    {
                        src: ['./src/assets/fonts/atkinson-regular.woff'],
                        weight: 400,
                        style: 'normal',
                        display: 'swap',
                    },
                    {
                        src: ['./src/assets/fonts/atkinson-bold.woff'],
                        weight: 700,
                        style: 'normal',
                        display: 'swap',
                    },
                ],
            },
        },
    ],
});
