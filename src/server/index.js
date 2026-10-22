import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WEB_DIR } from '../config.js';
import { repoRoot } from '../git.js';
import { HttpError, isUserError, routes, sendJson } from './routes.js';
import { BusyError } from './runs.js';

const MAX_BODY_BYTES = 30 * 1024 * 1024; // a 20 MB BRD grows by a third as base64
const PORT_ATTEMPTS = 10;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  // The API token travels in URLs; never leak it through Referer.
  'Referrer-Policy': 'no-referrer',
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reject(new HttpError(415, 'Expected a JSON body'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request too large (BRD files are limited to 20 MB)'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The file under web/ for a URL path, or null. Never resolves outside web/. */
function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return null;
  }
  const file = path.resolve(WEB_DIR, `.${decoded}`);
  if (!file.startsWith(WEB_DIR + path.sep) || !STATIC_TYPES[path.extname(file)]) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function serveStatic(res, file) {
  res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

async function handle(ctx, req, res) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);

  // Reject requests addressed to any other host name (DNS rebinding).
  if (!ctx.allowedHosts.has(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const file = staticFile(url.pathname);
    if (file) serveStatic(res, file);
    else res.writeHead(404).end('Not found');
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (!tokenMatches(req.headers['x-cra-token'] ?? url.searchParams.get('t'), ctx.token)) {
    sendJson(res, 401, { error: 'Missing or invalid token. Open the URL printed by `code-review-agent ui`.' });
    return;
  }

  for (const [method, pattern, handler] of routes) {
    const match = url.pathname.match(pattern);
    if (!match || req.method !== method) continue;
    try {
      await handler(ctx, req, res, url, match.slice(1));
    } catch (error) {
      if (res.headersSent) {
        res.end();
      } else if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
      } else if (isUserError(error)) {
        sendJson(res, error instanceof BusyError ? 409 : 400, { error: error.message });
      } else {
        console.error(error);
        sendJson(res, 500, { error: 'Internal error. See the terminal running `code-review-agent ui`.' });
      }
    }
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** Start the UI server on 127.0.0.1. Tries the next ports if the requested one is busy. */
export async function startServer({ port = 4477, token = crypto.randomBytes(24).toString('base64url') } = {}) {
  const host = '127.0.0.1';
  let launchRepo = null;
  try {
    launchRepo = await repoRoot(process.cwd());
  } catch {
    // launched outside a git repo
  }
  const ctx = { token, launchRepo, readJson, allowedHosts: new Set() };
  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((error) => {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  let bound;
  for (let attempt = 0; ; attempt += 1) {
    try {
      bound = await listen(server, port === 0 ? 0 : port + attempt, host);
      break;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port === 0 || attempt + 1 >= PORT_ATTEMPTS) throw error;
    }
  }
  ctx.allowedHosts = new Set([`${host}:${bound}`, `localhost:${bound}`]);
  return {
    server,
    port: bound,
    token,
    url: `http://${host}:${bound}/?t=${token}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
