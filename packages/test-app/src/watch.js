#!/usr/bin/env node
/**
 * Watches @dappfence/core dist output, templates, and assets for changes
 * and rebuilds manifests automatically.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const watchDirs = [
    path.dirname(require.resolve('@dappfence/core')),
    path.resolve(ROOT, 'template'),
    path.resolve(ROOT, 'assets'),
];

let debounce = null;

function rebuild() {
    try {
        console.log('[watch] change detected, rebuilding manifests...');
        execSync('node src/build.js --quiet', { stdio: 'inherit', cwd: ROOT });
        console.log('[watch] manifests rebuilt');
    } catch (error) {
        console.error('[watch] manifest build failed:', error.message);
    }
}

function onChange() {
    if (debounce) {
        clearTimeout(debounce);
    }
    debounce = setTimeout(rebuild, 300);
}

for (const dir of watchDirs) {
    console.log(`[watch] watching ${dir}`);
    fs.watch(dir, { recursive: true }, onChange);
}
