// Browser end-to-end test driven over the Chrome DevTools Protocol.
//
// Boots the real static server and a real headless Chrome, loads the fixture
// EPUB through the actual UI, translates it against a stubbed DeepSeek endpoint,
// and inspects the exported EPUB. No extra npm dependencies required.
//
// Run with: npm run test:e2e

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFixture } from './fixture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4173;
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  return CHROME_CANDIDATES.find((path) => existsSync(path)) || null;
}

async function waitFor(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* not ready yet */
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Tiny Chrome DevTools Protocol client over a single WebSocket. */
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else {
        this.events.push(message);
        for (const handler of this.handlers.get(message.method) || []) handler(message.params);
      }
    });
  }

  static connect(webSocketDebuggerUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketDebuggerUrl);
      socket.addEventListener('open', () => resolve(new CDP(socket)));
      socket.addEventListener('error', () => reject(new Error('Could not open the CDP socket')));
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Page evaluation failed: ${text}`);
    }
    return result.result?.value;
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.log('⚠  No Chrome/Chromium found — skipping the browser end-to-end test.');
    console.log('   Set CHROME_PATH to run it.');
    return 0;
  }

  const fixturePath = join(ROOT, 'test', 'fixtures', 'sample.epub');
  await writeFixture(fixturePath);

  const profileDir = mkdtempSync(join(tmpdir(), 'epub-e2e-'));
  const server = spawn(process.execPath, [join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  const browser = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanups = [
    () => server.kill('SIGKILL'),
    () => browser.kill('SIGKILL'),
    () => rmSync(profileDir, { recursive: true, force: true }),
  ];

  try {
    await waitFor(`http://127.0.0.1:${PORT}/index.html`);
    await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`);

    const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);

    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'unknown');
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const appUrl = `http://127.0.0.1:${PORT}/index.html`;
    await cdp.send('Page.navigate', { url: appUrl });

    let ready = false;
    for (let i = 0; i < 100 && !ready; i += 1) {
      ready = await cdp.evaluate(
        "Boolean(document.getElementById('log-list') && document.getElementById('log-list').childElementCount > 0)",
      ).catch(() => false);
      if (!ready) await sleep(100);
    }
    if (!ready) throw new Error(`The app did not initialise. Page errors:\n${pageErrors.join('\n') || '(none captured)'}`);
    console.log('  ✓ app boots without errors');

    const pageTestSource = readFileSync(join(ROOT, 'test', 'page-test.js'), 'utf8');
    const outcome = await cdp.evaluate(`(async () => { ${pageTestSource}\n return await pageTest(); })()`);

    let failures = 0;
    for (const entry of outcome.steps) {
      if (entry.ok) {
        console.log(`  ✓ ${entry.name}`);
      } else {
        failures += 1;
        console.log(`  ✗ ${entry.name}${entry.extra ? `  →  ${entry.extra}` : ''}`);
      }
    }

    if (pageErrors.length > 0) {
      console.log('\nUncaught page errors:');
      for (const error of pageErrors) console.log(`  ! ${error.split('\n')[0]}`);
    }

    if (failures > 0) {
      console.log('\nActivity log from the page:');
      console.log(`  ${outcome.log}`);
      if (outcome.toast) console.log(`  toast: ${outcome.toast}`);
    }

    const total = outcome.steps.length;
    console.log(`\n${total - failures}/${total} browser checks passed.`);
    if (failures > 0 || pageErrors.length > 0) return 1;
    return 0;
  } finally {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
