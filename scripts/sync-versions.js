#!/usr/bin/env node
/**
 * Sync all publishable package versions to a single version.
 * Pins workspace "*" dependencies in @dappfence/astro to the exact version.
 *
 * Usage: node scripts/sync-versions.js <version>  (e.g. 0.2.0)
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version) {
    console.error('Usage: node scripts/sync-versions.js <version>  (e.g. 0.2.0)');
    process.exit(1);
}
if (!/^\d+\.\d+\.\d+(-[^\s]+)?$/.test(version)) {
    console.error(`Invalid version: ${version}`);
    process.exit(1);
}

function update(relPath, transform) {
    const abs = resolve(ROOT, relPath);
    const pkg = JSON.parse(readFileSync(abs, 'utf8'));
    transform(pkg);
    writeFileSync(abs, JSON.stringify(pkg, null, 4) + '\n');
    console.log(`  ${relPath}  →  ${pkg.version}`);
}

import { readdirSync } from 'fs';

const packages = readdirSync(resolve(ROOT, 'packages'))
    .map((dir) => `packages/${dir}/package.json`)
    .filter((p) => {
        try {
            return !JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')).private;
        } catch {
            return false;
        }
    });

const packageNames = new Set(
    packages.map((p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')).name)
);

console.log(`Syncing all packages to ${version}...`);
for (const relPath of packages) {
    update(relPath, (pkg) => {
        pkg.version = version;
        for (const dep of Object.keys(pkg.dependencies ?? {})) {
            if (packageNames.has(dep)) {
                pkg.dependencies[dep] = version;
            }
        }
    });
}
console.log('\nDone. Commit the version bump before publishing.');
