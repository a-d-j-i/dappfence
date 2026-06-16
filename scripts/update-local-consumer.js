#!/usr/bin/env node
/**
 * Update a local @dappfence tarball consumer.
 *
 * Finds all file:*.tgz references to @dappfence packages in the consumer's
 * package.json, copies fresh tarballs from dist/, updates the version references,
 * clears stale @dappfence entries from package-lock.json, and runs the lock
 * integrity check.
 *
 * Usage:
 *   node scripts/update-local-consumer.js <consumer-dir>             dry run
 *   node scripts/update-local-consumer.js <consumer-dir> --apply     write changes
 *   node scripts/update-local-consumer.js <consumer-dir> --apply --install   also npm install
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPTS_DIR, '..');
const DIST_DIR = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const install = args.includes('--install');
const consumerArg = args.find((a) => !a.startsWith('-'));

if (!consumerArg) {
    console.error('Usage: node scripts/update-local-consumer.js <consumer-dir> [--apply] [--install]');
    process.exit(1);
}

const consumerDir = resolve(consumerArg);
const consumerPkgPath = resolve(consumerDir, 'package.json');
const consumerLockPath = resolve(consumerDir, 'package-lock.json');

if (!existsSync(consumerPkgPath)) {
    console.error(`No package.json found at: ${consumerPkgPath}`);
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(consumerPkgPath, 'utf8'));
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };

// Find all @dappfence entries that use a local file: tarball reference
const tgzEntries = Object.entries(allDeps).filter(
    ([name, ref]) =>
        name.startsWith('@dappfence/') &&
        typeof ref === 'string' &&
        ref.startsWith('file:') &&
        ref.endsWith('.tgz')
);

if (tgzEntries.length === 0) {
    console.log('No @dappfence file: tarball references found in consumer package.json.');
    process.exit(0);
}

// Tarball name pattern: <slug>-<semver>.tgz  e.g. dappfence-astro-0.1.0.tgz
const TARBALL_RE = /^(.+)-(\d+\.\d+\.\d+(?:-.+)?)\.tgz$/;

const distFiles = readdirSync(DIST_DIR).filter((f) => f.endsWith('.tgz'));

const label = apply ? '→' : '(dry run)';

const updates = [];

for (const [pkgName, ref] of tgzEntries) {
    // ref is like "file:./dependencies/dappfence-astro-0.1.0.tgz"
    const refPath = ref.slice('file:'.length); // "./dependencies/dappfence-astro-0.1.0.tgz"
    const destDir = resolve(consumerDir, dirname(refPath));
    const oldFilename = refPath.split('/').at(-1); // "dappfence-astro-0.1.0.tgz"

    const match = TARBALL_RE.exec(oldFilename);
    if (!match) {
        console.warn(`  Skipping ${pkgName}: cannot parse tarball filename "${oldFilename}"`);
        continue;
    }
    const [, slug, oldVersion] = match; // slug = "dappfence-astro", oldVersion = "0.1.0"

    // Find the matching tarball in dist/ by slug prefix
    const newFilename = distFiles.find((f) => f.startsWith(slug + '-'));
    if (!newFilename) {
        console.warn(`  Skipping ${pkgName}: no tarball found in dist/ for slug "${slug}"`);
        continue;
    }

    const newVersionMatch = TARBALL_RE.exec(newFilename);
    const newVersion = newVersionMatch ? newVersionMatch[2] : '?';

    const srcPath = resolve(DIST_DIR, newFilename);
    const destPath = resolve(destDir, newFilename);
    const newRef = ref.replace(oldFilename, newFilename);

    console.log(`  ${pkgName}  ${oldVersion} ${label} ${newVersion}`);
    console.log(`    copy   ${relative(ROOT, srcPath)}`);
    console.log(`      →    ${relative(ROOT, destPath)}`);
    if (oldFilename !== newFilename) {
        console.log(`    delete ${relative(ROOT, resolve(destDir, oldFilename))}`);
    }

    const oldPath = resolve(destDir, oldFilename);
    updates.push({ pkgName, oldRef: ref, newRef, srcPath, destPath, oldFilename, oldPath });
}

if (updates.length === 0) {
    console.log('Nothing to update.');
    process.exit(0);
}

if (!apply) {
    console.log('\nNo files written. Pass --apply to apply.');
    process.exit(0);
}

// Copy tarballs, then delete the old file if the filename changed
for (const { srcPath, destPath, oldPath } of updates) {
    copyFileSync(srcPath, destPath);
    if (oldPath !== destPath && existsSync(oldPath)) {
        unlinkSync(oldPath);
    }
}

// Update package.json references
let pkgRaw = readFileSync(consumerPkgPath, 'utf8');
for (const { oldRef, newRef } of updates) {
    pkgRaw = pkgRaw.replaceAll(oldRef, newRef);
}
writeFileSync(consumerPkgPath, pkgRaw);
console.log(`\nUpdated ${consumerPkgPath}`);

// Clear stale @dappfence entries from package-lock.json
if (existsSync(consumerLockPath)) {
    const lock = JSON.parse(readFileSync(consumerLockPath, 'utf8'));
    let removed = 0;
    for (const key of Object.keys(lock.packages ?? {})) {
        if (key.includes('@dappfence') || key.includes('node_modules/@dappfence')) {
            delete lock.packages[key];
            removed++;
        }
    }
    writeFileSync(consumerLockPath, JSON.stringify(lock, null, 2) + '\n');
    console.log(`Cleared ${removed} stale @dappfence entries from package-lock.json`);
}

// npm install
if (install) {
    console.log('\nRunning npm install...');
    const result = spawnSync('npm', ['install'], {
        cwd: consumerDir,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    // Lock integrity check
    console.log('\nRunning lock integrity check...');
    const checkScript = resolve(SCRIPTS_DIR, 'check-lock-integrity.js');
    const check = spawnSync('node', [checkScript, consumerDir], {
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    process.exit(check.status ?? 0);
}

console.log('\nDone. Run npm install in the consumer directory to finish.');
