// Zero-dependency static file server for the EPUB Translator app.
// The app itself is 100% client-side; this server only exists so that
// `npm start` gives you a working http:// origin (required for ES modules,
// fetch, Web Workers and blob URLs to behave).
//
// Hardened after the audit in epub-security-audit.md (finding #2):
//   * binds to 127.0.0.1 by default, so it is not reachable from the network,
//   * serves only an explicit allowlist of public assets, so Git metadata,
//     the local memory database and other working files are never exposed,
//   * validates the resolved *real* path so symlinks cannot escape the root.

import { createServer } from 'node:http';
import { stat, readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 3000);
// Localhost only by default; set HOST=0.0.0.0 intentionally to share.
const host = process.env.HOST || '127.0.0.1';

// Explicit allowlist. Anything not listed here is refused, regardless of the
// filesystem layout. `test/fixtures` is only needed by the e2e harness.
const PUBLIC_FILES = new Set(['index.html', 'epub-security-audit.md']);
const PUBLIC_DIRS = ['src', 'styles', 'vendor', 'test/fixtures'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.epub': 'application/epub+zip',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Is a root-relative POSIX path one of the explicitly public assets? */
function isPublicPath(relPath) {
  if (!relPath || relPath.includes('\0')) return false;
  // Never serve dotfiles or dot-directories (e.g. .git, .env).
  if (/(^|\/)\./.test(relPath)) return false;
  if (PUBLIC_FILES.has(relPath)) return true;
  return PUBLIC_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`));
}

const realRoot = await realpath(root);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      send(res, 400, 'Bad request');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve against the project root and refuse anything that escapes it.
    const candidate = resolve(root, `.${pathname}`);
    const relToRoot = relative(root, candidate);
    if (!relToRoot || isAbsolute(relToRoot) || relToRoot.startsWith('..')) {
      send(res, 403, 'Forbidden');
      return;
    }

    const relPath = relToRoot.split(sep).join('/');
    if (!isPublicPath(relPath)) {
      // Do not reveal whether a private file exists.
      send(res, 404, 'Not found');
      return;
    }

    // Resolve symlinks and re-check, so a link cannot point outside the root.
    const real = await realpath(candidate).catch(() => null);
    if (!real) {
      send(res, 404, 'Not found');
      return;
    }
    const realRel = relative(realRoot, real);
    const realPath = realRel.split(sep).join('/');
    if (realPath.startsWith('..') || isAbsolute(realRel) || !isPublicPath(realPath)) {
      send(res, 403, 'Forbidden');
      return;
    }

    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) {
      send(res, 404, 'Not found');
      return;
    }

    const body = await readFile(real);
    res.writeHead(200, {
      'Content-Type': MIME[extname(real).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    send(res, 500, `Server error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(port, host, () => {
  console.log(`\n  EPUB Translator (DeepSeek)\n  → http://${host}:${port}\n`);
});
