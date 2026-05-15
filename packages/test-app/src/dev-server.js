#!/usr/bin/env node

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { connect } = require('node:net');

const PROJECT_ROOT = path.resolve(__dirname, '..', 'dist');
const ASSET_ROOT = path.resolve(__dirname, '..', 'assets');
const DAPPFENCE_DIST = require.resolve('@dappfence/core');

const pIndex = process.argv.indexOf('-p');
const port = pIndex > 0 && pIndex < process.argv.length ? parseInt(process.argv[pIndex + 1]) : 3333;
const dIndex = process.argv.indexOf('-d');
const defaultApp = dIndex > 0 && dIndex < process.argv.length && process.argv[dIndex + 1];

// MIME types mapping
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

function calculateSRIHash(content) {
    const hash = crypto.createHash('sha256');
    hash.update(content);
    const digest = hash.digest('base64');
    return `sha256-${digest}`;
}

// function truncateHash(sriHash, length = 12) {
//     if (!sriHash || !sriHash.startsWith('sha256-')) return 'no-hash';
//     return sriHash.substring(7, 7 + length); // Skip 'sha256-' prefix
// }

function getTimestamp() {
    return new Date().toISOString().split('T')[1].slice(0, -1); // HH:MM:SS.mmm format
}

const INTERCEPT_FORMULAS = {
    default: (data, testParams, filePath) => {
        const p = filePath.trim().toLowerCase();
        if (p.endsWith('.json')) {
            const json = JSON.parse(data);
            json.pay = { ...json.pay, 'integrity-manifest.json': 'modified' };
            return JSON.stringify(json);
        } else if (p.endsWith('.html')) {
            return '<!-- modified -->\n' + data;
        } else if (p.endsWith('.js')) {
            return '// modified\n' + data;
        }
        return ' ' + data;
    },
    empty: () => {
        return '';
    },
    'cdn-inject': (data, _testParams, filePath) => {
        const p = filePath.trim().toLowerCase();
        if (!p.endsWith('.html') && !p.endsWith('.htm')) {
            return data;
        }
        const deployId = crypto.randomBytes(8).toString('hex');
        const snippet = `<div data-netlify-deploy-id="${deployId}" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed">\n  \n  <script async src="/.netlify/scripts/cdp"></script>\n</div>`;
        return data.toString('utf8') + snippet;
    },
    'cdn-inject-malicious': (data, _testParams, filePath) => {
        const p = filePath.trim().toLowerCase();
        if (!p.endsWith('.html') && !p.endsWith('.htm')) {
            return data;
        }
        const deployId = crypto.randomBytes(8).toString('hex');
        // Extra content inside the div makes the pattern non-matching so it won't be stripped.
        const snippet = `<div data-netlify-deploy-id="${deployId}" data-netlify-site-id="00000000-0000-0000-0000-000000000000" data-vcs="github" style="position:fixed"><script>evil()</script><script async src="/.netlify/scripts/cdp"></script></div>`;
        return data.toString('utf8') + snippet;
    },
    replace: (data, testParams, filePath, pattern, args) => {
        const replacement = path.join(PROJECT_ROOT, testParams.app, args);
        if (fs.existsSync(replacement) && fs.statSync(replacement).isFile()) {
            return fs.readFileSync(replacement, 'utf8');
        }
        console.log(
            `[${getTimestamp()}]  \x1b[31m[REPLACE] skipping, file not found ${replacement}\x1b[0m`
        );
        return data;
    },
};

function checkPattern(pattern, val) {
    try {
        return new RegExp(pattern).test(val);
    } catch (_e) {
        /* empty */
    }
    try {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // Escape regex specials
        const regexString = escaped
            .replace(/\*\*/g, 'XXXX') // ** matches anything including /
            .replace(/\*/g, '([^/]*)') // * matches anything except /
            .replace(/XXXX/g, '(.*)') // ** matches anything including /
            .replace(/\?/g, '(.)'); // ? matches any single character
        return new RegExp(`^${regexString}$`).test(val);
    } catch (_e) {
        /* empty */
    }
    return pattern === val;
}

// This will be updated by the test-config API
const testParameters = {
    // port/testKey: data
    1: {
        appName: 'project-name',
        appVersion: 'latest',
        testTitle: 'example-test',
        testId: '111-222',
        responseHeaders: [
            {
                match: '*',
                headers: { 'Cache-Control': 'max-age=3600' }, // 1 hour
            },
        ],
        saveResponses: false,
        testResponse: [],
    },
};
function getExtraResponseHeaders(testParams) {
    const params = testParameters[testParams.testKey];
    if (params || process.argv.includes('--no-cache')) {
        if (params && params.responseHeaders) {
            const rulesByTest = params.responseHeaders;
            if (rulesByTest && Array.isArray(rulesByTest)) {
                for (const rule of rulesByTest) {
                    if (rule.match && rule.headers) {
                        const regex = new RegExp('^' + rule.match.replace(/\*/g, '.*') + '$');
                        if (regex.test(testParams.requestPath)) {
                            return rule.headers;
                        }
                    }
                }
            }
        }
        // This is a dev server; our default is to avoid caching
        return {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
        };
    }
    // For third-party assets or when testing manually with `defaultApp` (no testKey configuration).
    // Use aggressive caching to simulate production CDN behavior.
    const hours = 60 * 60; // Convert hours to seconds
    const cacheTimeout = 48 * hours; // 48 hours: exceeds the 24-hour service worker auto-update threshold
    return { 'Cache-Control': `public, max-age=${cacheTimeout}, immutable` };
}

function saveTestResponse(testParams, result, filePath = '', extraHeaders = {}, intercept = null) {
    const params = testParameters[testParams.testKey];
    if (params && params.saveResponses) {
        if (!params.testResponse) {
            params.testResponse = [];
        }
        params.testResponse.push({ ...testParams, filePath, result, extraHeaders, intercept });
    }
}

async function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJSON(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                console.log(
                    `[${getTimestamp()}]  \x1b[31m[READ-JSON] Error: ${err.message}\x1b[0m`
                );
                reject(err);
            }
        });
    });
}

function sendJson(res, status, data, extraHeaders = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(data));
}

async function serveConfigTestApi(req, res, testParams) {
    let params;
    try {
        params = await readJSON(req);
    } catch {
        return sendJson(res, 400, { error: 'Invalid JSON payload' });
    }
    if (!params.appName || !params.appVersion) {
        return sendJson(res, 400, { error: 'Missing required fields: appName and appVersion' });
    }
    let intercept = [];
    if (params.intercept) {
        intercept = Array.isArray(params.intercept) ? params.intercept : [params.intercept];
        intercept = intercept.map((i) => ({
            ...i,
            formula: i && i.formula && INTERCEPT_FORMULAS[i.formula] ? i.formula : 'default',
        }));
    }
    testParameters[testParams.testKey] = {
        ...testParameters[testParams.testKey],
        ...params,
        intercept,
    };
    return sendJson(res, 200, { success: true });
}

async function serveApi(res, req, testParams) {
    const params = testParameters[testParams.testKey];
    if (req.method === 'DELETE') {
        console.log('');
        console.log(
            `[${getTimestamp()}]  \x1b[36m[TEST-CONFIG] Deleting test parameters for key ${testParams.testKey}\x1b[0m`
        );
        testParameters[testParams.testKey] = {};
        return sendJson(res, 200, { success: true });
    }
    if (req.method === 'POST' && testParams.requestPath === '/api/log') {
        try {
            const json = await readJSON(req);
            console.log('');
            console.log(`[${getTimestamp()}]  \x1b[35m[CLIENT-LOG]\x1b[0m`, json);
            return sendJson(res, 200, { success: true });
        } catch {
            return sendJson(res, 400, { error: 'Invalid JSON payload' });
        }
    }
    if (req.method === 'POST' && testParams.requestPath === '/api/save-file') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const name = url.searchParams.get('name');
        if (!name || name.includes('/') || name.includes('..')) {
            return sendJson(res, 400, { error: 'Missing or invalid ?name= parameter' });
        }
        const body = await readBody(req);
        const dir = path.join(os.tmpdir(), 'dappfence-test');
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, name);
        console.log(
            `[${getTimestamp()}]  \x1b[35m[SAVE-FILE]\x1b[0m ${filePath} (${body.length} bytes)`
        );
        fs.writeFileSync(filePath, body);
        return sendJson(res, 200, { success: true, path: filePath });
    }
    if (req.method === 'POST' && testParams.requestPath === '/api/test-config') {
        return await serveConfigTestApi(req, res, testParams);
    }
    if (req.method === 'GET' && testParams.requestPath === '/api/test-responses') {
        return sendJson(res, 200, (params && params.testResponse) || [], {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
        });
    }
    res.writeHead(500, { 'Content-Type': 'application/test' });
    res.end('Internal server error');
}

function serveFile(filePath, res, req, testParams) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            saveTestResponse(testParams, 'error reading file', filePath);
            logRequestToConsole(
                req,
                testParams,
                `\x1b[31m ❌ ERROR ${filePath}, ${err.toString()}\x1b[0m`
            );
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found');
            return;
        }

        // Calculate and log SRI hash for debugging
        const sriHash = calculateSRIHash(data);
        const mimeType = getMimeType(filePath);
        const extraHeaders = getExtraResponseHeaders(testParams);
        const relativeFilePath = path.relative(PROJECT_ROOT, filePath);

        const params = testParameters[testParams.testKey];
        const intercept =
            params &&
            params.intercept &&
            params.intercept.find(
                (i) => i.pattern && checkPattern(i.pattern, testParams.requestPath)
            );
        const resData = intercept
            ? INTERCEPT_FORMULAS[intercept.formula](
                  data,
                  testParams,
                  filePath,
                  intercept.pattern,
                  intercept.args
              )
            : data;

        saveTestResponse(testParams, 'ok', filePath, extraHeaders, intercept);
        logRequestToConsole(
            req,
            testParams,
            `🔑 ${relativeFilePath}: ${sriHash} (${data.length} bytes) ${extraHeaders['Cache-Control'] || 'no-cache-header'}${intercept ? ` applied ${intercept.formula}` : ''}`
        );
        res.sendDate = false;
        res.writeHead(200, {
            'Content-Type': mimeType,
            ...extraHeaders,
        });
        res.end(resData);
    });
}

function logRequestToConsole(req, testParams, result) {
    const isServiceWorkerRequest =
        req.headers['service-worker'] === 'script' ||
        req.headers['sec-fetch-dest'] === 'serviceworker';

    // Check request type and DappFence tracking (header or URL param)
    const hasDappFenceHeader = 'x-dappfence' in req.headers;
    const isCacheCheck = req.headers['if-modified-since'] || req.headers['if-none-match'];

    let indicator = '';
    let colorCode = '';
    if (isServiceWorkerRequest) {
        indicator = '[SW-REG]';
        colorCode = '\x1b[36m'; // Cyan
    } else if (hasDappFenceHeader) {
        indicator = '[DFSW-HDR]'; // Only header
        colorCode = '\x1b[33m'; // Yellow
    } else {
        indicator = '[BYPASSED]'; // No SW tracking - direct browser request
        colorCode = '\x1b[31m'; // Red
    }
    // Add cache check indicator
    const cacheIndicator = isServiceWorkerRequest ? '🔧' : isCacheCheck ? '💾' : '';

    console.log();
    console.log(
        `[${getTimestamp()}]  ${colorCode}${indicator}\x1b[0m ${cacheIndicator} ${req.method} ${testParams.url}`
    );
    console.log(
        '\ttest key:',
        testParams.testKey,
        'app:',
        testParams.appName,
        'version:',
        testParams.appVersion
    );
    console.log('\t', result);
}

function getTestParameters(req) {
    // Extract the destination port from request headers to use as a test key.
    // The port is extracted from the 'Host' header (for same-origin requests)
    // or from the 'Origin' header (for cross-origin requests to external assets).
    const host = req.headers.host;
    const origin = URL.parse(req.headers.origin) || URL.parse(`http://${host}`);
    const testKey = origin && origin.port;
    const params = testParameters[testKey];

    const baseUrl = new URL(req.url, host ? `http://${host}` : 'http://localhost:' + port);
    // defaultApp (passed by argument) take precedence
    if (defaultApp) {
        return {
            testKey,
            app: defaultApp,
            appName: defaultApp.split('_')[0],
            appVersion: defaultApp.split('_')[1] || 'latest',
            testTitle: 'default',
            testId: 'default',
            url: baseUrl.toString(),
            requestPath: baseUrl.pathname,
        };
    }
    const { appName, appVersion, testTitle, testId } = params || {};
    return {
        testKey,
        app: appName + '_' + (appVersion || 'latest'),
        appName,
        appVersion,
        testTitle,
        testId,
        url: baseUrl.toString(),
        requestPath: baseUrl.pathname,
    };
}

const server = http.createServer((req, res) => {
    const testParams = getTestParameters(req);
    // Handle OPTIONS requests for CORS preflight
    const CORS_HEADERS = [
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers',
    ].reduce((acc, header) => ({ ...acc, [header]: '*' }), {});
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    // Add CORS headers to all responses
    Object.keys(CORS_HEADERS).forEach((header) => {
        res.setHeader(header, CORS_HEADERS[header]);
    });

    if (testParams.requestPath.startsWith('/api/')) {
        return serveApi(res, req, testParams).catch((err) => {
            console.error('Error serving API:', err);
            sendJson(res, 500, { error: err.message });
        });
    }

    // Handle special routes for development when I cannot control the request headers
    if (process.argv.includes('--dev') && testParams.requestPath.endsWith('/dappfence.js')) {
        // In development, serve the framework from dist/ so we don't need to copy
        return serveFile(DAPPFENCE_DIST, res, req, testParams); // Always log hash for dappfence.js
    }

    if (testParams.app) {
        const htmlRoot = path.join(PROJECT_ROOT, testParams.app);
        for (const p of ['', '.html', '/index.html']) {
            const filePath = path.join(htmlRoot, testParams.requestPath + p);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                return serveFile(filePath, res, req, testParams);
            }
        }
    }

    // As a last attempt, try `assets` path (`jquery` for example)
    const filePath = path.join(ASSET_ROOT, testParams.requestPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return serveFile(filePath, res, req, testParams);
    }

    saveTestResponse(testParams, 'file not found');
    logRequestToConsole(
        req,
        testParams,
        `\x1b[31m ❌ NOT FOUND ${req.method} ${testParams.url}\x1b[0m`
    );
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('File not found');
});

// Listen for the 'connect' event to handle proxy tunneling requests
server.on('connect', (req, socket) => {
    // console.log(
    //     `[${getTimestamp()}]  \x1b[32m[PROXY] Client requested CONNECT to: ${req.url} via ${req.headers.host}\x1b[0m`
    // );
    // console.log(`[${getTimestamp()}]  \x1b[32m[PROXY] Proxying to: localhost:${port}\x1b[0m`);
    const remote = connect(port, 'localhost', () => {
        // Tell the client that the connection is established
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Pipe data between the client socket and the remote server socket
        remote.pipe(socket);
        socket.pipe(remote);
    });
    remote.on('error', (e) => {
        console.log(
            `[${getTimestamp()}]  \x1b[31m[PROXY] Remote connection error: ${e.message}\x1b[0m`
        );
        socket.end();
    });
    socket.on('error', (e) => {
        console.log(
            `[${getTimestamp()}]  \x1b[31m[PROXY] Client socket error: ${e.message}\x1b[0m`
        );
        remote.end();
    });
});
// Prevent MaxListenersExceededWarning
server.setMaxListeners(Infinity);
server.listen(port, () => {
    console.log(`🚀 DappFence Dev Server running at http://localhost:${port}`);
    console.log(`📁 Serving test default app: ${defaultApp}`);
    console.log('');
    console.log('Press Ctrl+C to stop');
    if (process.argv.includes('--with-browser')) {
        // Try to open a browser (cross-platform) - gracefully handle errors
        try {
            const open =
                process.platform === 'win32'
                    ? 'start'
                    : process.platform === 'darwin'
                      ? 'open'
                      : 'xdg-open';

            const child = spawn(open, [`http://localhost:${port}`], {
                stdio: 'ignore',
                detached: true,
            });

            child.on('error', (_err) => {
                // Silently ignore browser-opening errors
                console.log(`💡 Open http://localhost:${port} in your browser`);
            });
        } catch (_err) {
            console.log(`💡 Open http://localhost:${port} in your browser`);
        }
    }
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down dev server...');
    server.close(() => {
        console.log('✅ Dev server stopped');
        process.exit(0);
    });
});
