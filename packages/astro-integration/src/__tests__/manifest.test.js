import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    buildScriptAttrs,
    buildScriptTag,
    injectScriptTag,
    extractDynamicRoutes,
    buildDynamicRouteAllowRules,
    buildPathRules,
    buildIntegrityManifest,
    DEFAULT_EXTENSIONS,
} from '../manifest.js';

const MINIMAL = { scriptSrc: '/dappfence.js' };

// ── buildScriptAttrs ──────────────────────────────────────────────────────────

describe('buildScriptAttrs', () => {
    it('includes src from scriptSrc', () => {
        expect(buildScriptAttrs(MINIMAL).src).toBe('/dappfence.js');
    });

    it('omits falsy optional attributes', () => {
        const attrs = buildScriptAttrs({ ...MINIMAL, appSW: null, warningUrl: null });
        expect(attrs).not.toHaveProperty('data-app-sw');
        expect(attrs).not.toHaveProperty('data-warning-url');
    });

    it('includes all optional attributes when provided', () => {
        const attrs = buildScriptAttrs({
            scriptSrc: '/dappfence.js',
            manifestUrl: '/integrity-manifest.json',
            manifestSignatureType: 'noble-secp256k1-recovered-eth',
            manifestSignatureIdentity: '0xAbC123',
            appSW: '/app-sw.js',
            warningUrl: '/security-warning',
        });
        expect(attrs['data-manifest']).toBe('/integrity-manifest.json');
        expect(attrs['data-manifest-signature-type']).toBe('noble-secp256k1-recovered-eth');
        expect(attrs['data-manifest-signature-identity']).toBe('0xAbC123');
        expect(attrs['data-app-sw']).toBe('/app-sw.js');
        expect(attrs['data-warning-url']).toBe('/security-warning');
    });
});

// ── buildScriptTag ────────────────────────────────────────────────────────────

describe('buildScriptTag', () => {
    it('produces a valid script element', () => {
        const tag = buildScriptTag(MINIMAL);
        expect(tag).toMatch(/^<script /);
        expect(tag).toContain('src="/dappfence.js"');
        expect(tag).toMatch(/<\/script>$/);
    });

    it('includes data attributes in the tag', () => {
        const tag = buildScriptTag({
            ...MINIMAL,
            manifestUrl: '/integrity-manifest.json',
        });
        expect(tag).toContain('data-manifest="/integrity-manifest.json"');
    });
});

// ── injectScriptTag ───────────────────────────────────────────────────────────

describe('injectScriptTag', () => {
    it('injects after <head>', () => {
        const html = '<html><head></head><body></body></html>';
        const result = injectScriptTag(html, MINIMAL);
        expect(result).toContain('<head>\n    <script src="/dappfence.js"');
    });

    it('injects after <head> with attributes', () => {
        const html = '<html><head lang="en"></head><body></body></html>';
        const result = injectScriptTag(html, MINIMAL);
        expect(result).toContain('<head lang="en">\n    <script');
    });

    it('does not double-inject on repeated calls', () => {
        const html = '<html><head></head><body></body></html>';
        const once = injectScriptTag(html, MINIMAL);
        const twice = injectScriptTag(once, MINIMAL);
        expect(twice).toBe(once);
    });

    it('returns html unchanged when no <head> is present', () => {
        const fragment = '<div>hello</div>';
        expect(injectScriptTag(fragment, MINIMAL)).toBe(fragment);
    });
});

// ── extractDynamicRoutes ──────────────────────────────────────────────────────

describe('extractDynamicRoutes', () => {
    it('returns empty array for null/undefined input', () => {
        expect(extractDynamicRoutes(null)).toEqual([]);
        expect(extractDynamicRoutes(undefined)).toEqual([]);
        expect(extractDynamicRoutes([])).toEqual([]);
    });

    it('returns empty array when all routes are prerendered', () => {
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/about', isPrerendered: true },
        ];
        expect(extractDynamicRoutes(routes)).toEqual([]);
    });

    it('returns patterns for non-prerendered routes', () => {
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/blog/[slug]', isPrerendered: false },
            { pattern: '/_server-islands/[name]', isPrerendered: false },
        ];
        expect(extractDynamicRoutes(routes)).toEqual(['/blog/[slug]', '/_server-islands/[name]']);
    });

    it('filters out routes with no pattern', () => {
        const routes = [
            { pattern: null, isPrerendered: false },
            { pattern: '/api/data', isPrerendered: false },
        ];
        expect(extractDynamicRoutes(routes)).toEqual(['/api/data']);
    });
});

// ── buildDynamicRouteAllowRules ───────────────────────────────────────────────

describe('buildDynamicRouteAllowRules', () => {
    it('returns empty array for no dynamic routes', () => {
        expect(buildDynamicRouteAllowRules([])).toEqual([]);
    });

    it('emits allow rule for server-islands prefix', () => {
        const rules = buildDynamicRouteAllowRules(['/_server-islands/[name]']);
        expect(rules).toEqual([
            { condition: { urlFilter: '/_server-islands/' }, action: { type: 'allow' } },
        ]);
    });

    it('emits allow rule for /blog/[slug]', () => {
        const rules = buildDynamicRouteAllowRules(['/blog/[slug]']);
        expect(rules).toEqual([{ condition: { urlFilter: '/blog/' }, action: { type: 'allow' } }]);
    });

    it('skips routes whose prefix is only "/"', () => {
        const rules = buildDynamicRouteAllowRules(['/[lang]']);
        expect(rules).toEqual([]);
    });

    it('emits literal route as urlFilter when no dynamic segment', () => {
        const rules = buildDynamicRouteAllowRules(['/api/data']);
        expect(rules).toEqual([
            { condition: { urlFilter: '/api/data' }, action: { type: 'allow' } },
        ]);
    });
});

// ── buildPathRules ────────────────────────────────────────────────────────────

describe('buildPathRules', () => {
    it('emits directory-index for format=directory', () => {
        expect(buildPathRules('directory')).toEqual([{ type: 'directory-index' }]);
    });

    it('emits html-extension for format=file', () => {
        expect(buildPathRules('file')).toEqual([{ type: 'html-extension' }]);
    });

    it('returns empty array for unknown/undefined format', () => {
        expect(buildPathRules(undefined)).toEqual([]);
        expect(buildPathRules('preserve')).toEqual([]);
    });
});

// ── buildIntegrityManifest (integration) ──────────────────────────────────────

async function makeTmpDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'dappfence-test-'));
}

const LOGGER = {
    info: () => {},
    warn: () => {},
    error: () => {},
};

describe('buildIntegrityManifest', () => {
    const tmpDirs = [];

    afterEach(async () => {
        for (const dir of tmpDirs) {
            await fs.rm(dir, { recursive: true, force: true });
        }
        tmpDirs.length = 0;
    });

    async function setup() {
        const outDir = await makeTmpDir();
        tmpDirs.push(outDir);
        return outDir;
    }

    it('writes manifest file with hashes for tracked extensions', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'app.js'), 'console.log("hello")', 'utf8');
        await fs.writeFile(path.join(outDir, 'style.css'), 'body{}', 'utf8');
        await fs.writeFile(path.join(outDir, 'image.png'), 'fake png', 'utf8');

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/app.js']).toBeDefined();
        expect(manifest.pay.files['/style.css']).toBeDefined();
        expect(manifest.pay.files['/image.png']).toBeUndefined();
    });

    it('excludes the manifest file itself', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'app.js'), 'x', 'utf8');

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/integrity-manifest.json']).toBeUndefined();
    });

    it('respects the exclude option', async () => {
        const outDir = await setup();
        const adminDir = path.join(outDir, 'admin');
        await fs.mkdir(adminDir);
        await fs.writeFile(path.join(adminDir, 'app.js'), 'secret', 'utf8');
        await fs.writeFile(path.join(outDir, 'public.js'), 'open', 'utf8');

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: ['/admin'],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/admin/app.js']).toBeUndefined();
        expect(manifest.pay.files['/public.js']).toBeDefined();
    });

    it('injects script tag into every HTML file', async () => {
        const outDir = await setup();
        await fs.mkdir(path.join(outDir, 'about'), { recursive: true });
        await fs.writeFile(
            path.join(outDir, 'index.html'),
            '<html><head></head><body></body></html>',
            'utf8'
        );
        await fs.writeFile(
            path.join(outDir, 'about', 'index.html'),
            '<html><head></head><body></body></html>',
            'utf8'
        );

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const root = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
        const about = await fs.readFile(path.join(outDir, 'about', 'index.html'), 'utf8');
        expect(root).toContain('src="/dappfence.js"');
        expect(about).toContain('src="/dappfence.js"');
    });

    it('skips HTML fragments without a <head> tag', async () => {
        const outDir = await setup();
        await fs.writeFile(path.join(outDir, 'partial.html'), '<div>fragment</div>', 'utf8');

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const html = await fs.readFile(path.join(outDir, 'partial.html'), 'utf8');
        expect(html).not.toContain('src="/dappfence.js"');
    });

    it('writes mode into the manifest payload', async () => {
        const outDir = await setup();

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'reporting',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.mode).toBe('reporting');
    });

    it('signs the manifest when secretKey is provided', async () => {
        const outDir = await setup();
        const secretKey = 'a'.repeat(64);

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            secretKey,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.sig).toBeDefined();
        expect(manifest.pay).toBeDefined();
    });

    it('merges additionalFiles entries into manifest files', async () => {
        const outDir = await setup();

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            additionalFiles: {
                '/.netlify/scripts/cdp': ['sha256-aaa=', 'sha256-bbb='],
            },
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.files['/.netlify/scripts/cdp']).toEqual(['sha256-aaa=', 'sha256-bbb=']);
    });

    it('emits pathRules for buildFormat=directory', async () => {
        const outDir = await setup();

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            buildFormat: 'directory',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.pathRules).toEqual([{ type: 'directory-index' }]);
    });

    it('emits pathRules for buildFormat=file', async () => {
        const outDir = await setup();

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            buildFormat: 'file',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.pathRules).toEqual([{ type: 'html-extension' }]);
    });

    it('omits pathRules when buildFormat is not set', async () => {
        const outDir = await setup();

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.pathRules).toBeUndefined();
    });

    it('emits contentRules when provided', async () => {
        const outDir = await setup();
        const contentRules = [
            {
                condition: { resourceTypes: ['document'] },
                action: { type: 'transform', transform: 'netlify-cdp' },
            },
        ];

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            contentRules,
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.contentRules).toEqual(contentRules);
    });

    it('includes SSR route allow rules in contentRules', async () => {
        const outDir = await setup();
        const routes = [
            { pattern: '/', isPrerendered: true },
            { pattern: '/_server-islands/[name]', isPrerendered: false },
        ];

        await buildIntegrityManifest({
            outDir,
            routes,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.contentRules).toContainEqual(
            expect.objectContaining({
                condition: { urlFilter: '/_server-islands/' },
                action: { type: 'allow' },
            })
        );
    });

    it('does not emit contentRules when no rules exist', async () => {
        const outDir = await setup();

        await buildIntegrityManifest({
            outDir,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.contentRules).toBeUndefined();
    });

    it('does not include dynamicRoutes in metadata', async () => {
        const outDir = await setup();
        const routes = [{ pattern: '/api/[id]', isPrerendered: false }];

        await buildIntegrityManifest({
            outDir,
            routes,
            manifestPath: 'integrity-manifest.json',
            extensions: DEFAULT_EXTENSIONS,
            exclude: [],
            mode: 'protected',
            logger: LOGGER,
            scriptAttrs: MINIMAL,
        });

        const raw = await fs.readFile(path.join(outDir, 'integrity-manifest.json'), 'utf8');
        const manifest = JSON.parse(raw);
        expect(manifest.pay.metadata.dynamicRoutes).toBeUndefined();
    });
});
