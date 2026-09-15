// Headless checks for the DOM-independent logic: text segmentation, path
// helpers, DeepSeek reply parsing and EPUB repackaging (mimetype-first order).
//
// Run with: npm test

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applySegments, decodeEntities, extractSegments } from '../src/epub-text.js';
import {
  DEFAULT_MODEL,
  DeepSeekClient,
  DeepSeekError,
  MODELS,
  buildRequestBody,
  parseTranslations,
} from '../src/deepseek.js';
import { AUTO_DETECT, isRtl, languageName, normalizeLanguageCode } from '../src/languages.js';
import { estimateCostUsd, estimateTokens, formatTokens, formatUsd, isPeakNow } from '../src/tokens.js';

// The vendored JSZip is a browser standalone bundle; evaluate it in a sandbox
// (same as a <script> tag would) so the test exercises the exact file we ship.
const jszipSource = readFileSync(new URL('../vendor/jszip.min.js', import.meta.url), 'utf8');
const sandbox = {};
new Function('window', 'global', 'self', jszipSource)(sandbox, sandbox, sandbox);
globalThis.JSZip = sandbox.JSZip;

const { EpubBook, dirname, guessMime, normalizePath, resolvePath } = await import('../src/epub.js');

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};
const acheck = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};

console.log('epub-text');

check('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b&nbsp;c &#65; &#x42;'), 'a & b\u00a0c A B');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

check('extracts a simple text run', () => {
  const segments = extractSegments('<p>Hello &amp; welcome&nbsp;there</p>');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].raw, 'Hello &amp; welcome&nbsp;there');
  assert.equal(segments[0].plain, 'Hello & welcome\u00a0there');
});

check('skips script/style/head and tolerates "<" inside them', () => {
  const html = '<head><title>T</title></head><body><p>A</p>'
    + '<script>if (a<b) { x = "</p>"; }</script>'
    + '<style>p::before{content:"<"}</style><p>B</p></body>';
  assert.deepEqual(extractSegments(html).map((s) => s.plain), ['A', 'B']);
});

check('ignores attributes containing ">" and void elements', () => {
  const html = '<p title="a > b">Real text</p><br>Next line';
  assert.deepEqual(extractSegments(html).map((s) => s.plain), ['Real text', 'Next line']);
});

check('skips comments and CDATA', () => {
  const html = '<p>A</p><!-- ignore me --><p>B</p><![CDATA[also ignore]]><p>C</p>';
  assert.deepEqual(extractSegments(html).map((s) => s.plain), ['A', 'B', 'C']);
});

check('skips whitespace/digit-only runs', () => {
  assert.equal(extractSegments('<p>   </p><p>42</p><p>!!</p>').length, 0);
});

check('applySegments splices translations and escapes them', () => {
  const html = '<p>Hello &amp; welcome</p>';
  const out = applySegments(html, extractSegments(html), ['Bonjour & bienvenue <3']);
  assert.equal(out, '<p>Bonjour &amp; bienvenue &lt;3</p>');
});

check('applySegments keeps original text when a translation is missing', () => {
  const html = '<p>One</p><p>Two</p>';
  assert.equal(applySegments(html, extractSegments(html), ['Un', null]), '<p>Un</p><p>Two</p>');
});

check('applySegments preserves whitespace around inline tags', () => {
  const html = '<p>He said <em>hello</em> quietly.</p>';
  const segments = extractSegments(html);
  const out = applySegments(html, segments, segments.map((s) => s.plain.toUpperCase()));
  assert.equal(out, '<p>HE SAID <em>HELLO</em> QUIETLY.</p>');
});

console.log('languages');

check('normalizes and names languages', () => {
  assert.equal(normalizeLanguageCode('en-US'), 'en');
  assert.equal(normalizeLanguageCode('zh-Hant-TW'), 'zh-Hant');
  assert.equal(languageName('de'), 'German');
  assert.equal(isRtl('ar'), true);
  assert.equal(isRtl('en'), false);
  assert.equal(AUTO_DETECT, 'auto');
});

console.log('deepseek');

check('parses a well-formed JSON reply', () => {
  assert.deepEqual(parseTranslations('{"translations":["a","b"]}', 2), ['a', 'b']);
});

check('parses fenced JSON and plain arrays', () => {
  assert.deepEqual(parseTranslations('```json\n{"translations":["x"]}\n```', 1), ['x']);
  assert.deepEqual(parseTranslations('["x","y"]', 2), ['x', 'y']);
});

check('rejects a length mismatch so the caller can retry', () => {
  assert.equal(parseTranslations('{"translations":["only-one"]}', 2), null);
  assert.equal(parseTranslations('not json at all', 1), null);
});

check('ships only current model ids, defaulting to deepseek-flash', () => {
  assert.equal(DEFAULT_MODEL, 'deepseek-flash');
  assert.deepEqual(MODELS.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.ok(MODELS.every((m) => m.name && m.id));
  assert.ok(!MODELS.some((m) => /deepseek-chat|deepseek-reasoner/.test(m.id)), 'retired ids must be gone');
});

check('request body disables thinking and uses JSON output', () => {
  const body = buildRequestBody({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.thinking, { type: 'disabled' }, 'thinking must be explicitly disabled for translation');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.temperature, 1.3, 'temperature only has an effect with thinking disabled');
  assert.equal(body.stream, false);
  assert.ok(!('reasoning_effort' in body));
});

console.log('tokens');

check('estimates latin text at roughly 4 chars per token', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.ok(estimateTokens('Hello, world!') > 0);
});

check('estimates CJK text far denser than latin', () => {
  const cjk = '\u4e2d'.repeat(100);
  assert.equal(estimateTokens(cjk), 160); // 100 chars x 1.6
  assert.ok(estimateTokens(cjk) > estimateTokens('x'.repeat(100)));
});

check('formats token counts and USD compactly', () => {
  assert.equal(formatTokens(1234567), (1234567).toLocaleString());
  assert.equal(formatTokens(0), '0');
  assert.equal(formatUsd(0), '$0.00');
  assert.equal(formatUsd(0.0042), '$0.0042');
  assert.equal(formatUsd(0.42), '$0.420');
  assert.equal(formatUsd(3.5), '$3.50');
});

check('classifies DeepSeek peak windows (UTC, weekdays only)', () => {
  assert.equal(isPeakNow(new Date('2026-09-15T02:00:00Z')), true); // Tue 02:00
  assert.equal(isPeakNow(new Date('2026-09-15T07:30:00Z')), true); // Tue 07:30
  assert.equal(isPeakNow(new Date('2026-09-15T00:30:00Z')), false);
  assert.equal(isPeakNow(new Date('2026-09-15T05:00:00Z')), false);
  assert.equal(isPeakNow(new Date('2026-09-15T12:00:00Z')), false);
  assert.equal(isPeakNow(new Date('2026-09-20T02:00:00Z')), false); // Sunday
});

check('prices a run using peak/off-peak and cache-hit rates', () => {
  const offPeak = new Date('2026-09-15T12:00:00Z');
  const peak = new Date('2026-09-15T02:00:00Z');
  // 1M input (no cache) + 1M output: off-peak 0.15 + 0.60, peak 0.30 + 1.20
  assert.equal(Number(estimateCostUsd({ inputTokens: 1e6, outputTokens: 1e6, date: offPeak }).toFixed(4)), 0.75);
  assert.equal(Number(estimateCostUsd({ inputTokens: 1e6, outputTokens: 1e6, date: peak }).toFixed(4)), 1.5);
  // Fully cache-hit input only pays the cache-hit rate.
  assert.equal(
    Number(estimateCostUsd({ inputTokens: 1e6, cacheHitTokens: 1e6, date: offPeak }).toFixed(4)),
    0.003,
  );
});

console.log('epub paths');

check('resolves relative hrefs against a base directory', () => {
  assert.equal(dirname('OEBPS/text/ch1.xhtml'), 'OEBPS/text');
  assert.equal(dirname('content.opf'), '');
  assert.equal(normalizePath('OEBPS/./text/../text/ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/text', '../images/pic.png'), 'OEBPS/images/pic.png');
  assert.equal(resolvePath('OEBPS/text', 'ch2.xhtml#s2'), 'OEBPS/text/ch2.xhtml');
  assert.equal(guessMime('a/b/pic.PNG'), 'image/png');
});

console.log('deepseek client (stubbed fetch)');

const realFetch = globalThis.fetch;
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

await acheck('posts to the chat endpoint with the new request contract', async () => {
  let captured = null;
  const seenUsage = [];
  globalThis.fetch = async (url, options) => {
    captured = { url: String(url), headers: options.headers, body: JSON.parse(options.body) };
    return jsonResponse({
      choices: [{ message: { content: JSON.stringify({ translations: ['Hallo'] }) } }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        prompt_cache_hit_tokens: 20,
      },
    });
  };
  try {
    const client = new DeepSeekClient({ apiKey: 'sk-test' });
    const out = await client.translateBatch(['Hello'], {
      source: 'English',
      target: 'German',
      onUsage: (usage) => seenUsage.push(usage),
    });
    assert.deepEqual(out, ['Hallo']);
    assert.equal(seenUsage.length, 1, 'usage should be reported once per request');
    assert.equal(seenUsage[0].prompt_tokens, 120);
    assert.equal(seenUsage[0].prompt_cache_hit_tokens, 20);
    assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(captured.headers.Authorization, 'Bearer sk-test');
    assert.equal(captured.body.model, 'deepseek-flash');
    assert.deepEqual(captured.body.thinking, { type: 'disabled' });
    assert.deepEqual(captured.body.response_format, { type: 'json_object' });
    assert.equal(captured.body.temperature, 1.3);
    // The prompt must contain the literal word "json" for JSON mode to be honoured.
    assert.match(captured.body.messages.map((m) => m.content).join('\n'), /json/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await acheck('surfaces an invalid key as a non-retryable 401 error', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ error: { message: 'Authentication Fails' } }, 401);
  };
  try {
    const client = new DeepSeekClient({ apiKey: 'sk-bad' });
    await assert.rejects(
      () => client.translateBatch(['Hello'], { source: 'English', target: 'German' }),
      (error) => error instanceof DeepSeekError && error.status === 401 && !error.retryable,
    );
    assert.equal(calls, 1, 'a 401 must not be retried');
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log('epub repackaging');

const zip = new globalThis.JSZip();
zip.file('mimetype', 'application/epub+zip');
zip.file('META-INF/container.xml', '<container/>');
zip.file('OEBPS/content.opf', '<package><metadata><dc:language>fr</dc:language></metadata></package>');
zip.file('OEBPS/ch1.xhtml', '<html><body><p>Salut</p></body></html>');

const book = new EpubBook(zip, 'demo.epub');
book.opfPath = 'OEBPS/content.opf';
book.chapters.push({
  index: 0, id: 'c1', path: 'OEBPS/ch1.xhtml', mediaType: 'application/xhtml+xml',
  href: 'ch1.xhtml', title: 'One', raw: null, translated: null,
});
book.setChapterTranslation(0, '<html><body><p>Hello</p></body></html>');
await book.setLanguage('en');

const blob = await book.buildEpubBlob();
const buffer = Buffer.from(await blob.arrayBuffer());
const reopened = await globalThis.JSZip.loadAsync(buffer);
const names = Object.keys(reopened.files);

check('mimetype is the first entry in the exported zip', () => {
  assert.equal(names[0], 'mimetype');
});

check('mimetype is stored uncompressed (local header method 0)', () => {
  const signature = buffer.indexOf(Buffer.from('PK\x03\x04', 'binary'));
  assert.ok(signature >= 0, 'no local file header found');
  assert.equal(buffer.readUInt16LE(signature + 8), 0);
});

const ch1 = await reopened.file('OEBPS/ch1.xhtml').async('string');
const opf = await reopened.file('OEBPS/content.opf').async('string');
const container = await reopened.file('META-INF/container.xml').async('string');

check('translated chapter is written back', () => {
  assert.equal(ch1, '<html><body><p>Hello</p></body></html>');
});

check('OPF language is patched to the target language', () => {
  assert.match(opf, /<dc:language>en<\/dc:language>/);
});

check('untouched entries survive unchanged', () => {
  assert.equal(container, '<container/>');
});

console.log(`\n${passed} checks passed.`);
