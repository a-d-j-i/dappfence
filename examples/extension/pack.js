/**
 * Create a store-ready zip from dist/.
 *
 *   node pack.js                  → release/dappfence-chrome.zip
 *   node pack.js --target=firefox → release/dappfence-firefox.zip
 *
 * Run the appropriate build first:
 *   node build.js [--target=firefox]
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipArchive } from 'archiver';

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv.includes('--target=firefox') ? 'firefox' : 'chrome';

const dist = join(here, 'dist');
const release = join(here, 'release');
const out = join(release, `dappfence-${target}.zip`);

mkdirSync(release, { recursive: true });

const archive = new ZipArchive({ zlib: { level: 9 } });
const stream = createWriteStream(out);

await new Promise((resolve, reject) => {
    archive.on('error', reject);
    stream.on('close', resolve);
    archive.pipe(stream);
    // false = files sit at the root of the zip, not inside a 'dist/' folder.
    archive.directory(dist, false);
    archive.finalize();
});

console.log(`[extension] packed → ${out} (${archive.pointer()} bytes)`);
