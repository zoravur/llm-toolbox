// Executed inside the browser page by test/e2e.mjs (wrapped in an async IIFE).
// It drives the real UI: load EPUB -> render -> translate (with a stubbed
// DeepSeek endpoint) -> export -> inspect the exported EPUB bytes.

async function pageTest() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const steps = [];
  const step = (name, ok, extra) => steps.push({ name, ok: Boolean(ok), extra: extra === undefined ? '' : String(extra) });
  const shadow = () => document.getElementById('reader').shadowRoot;
  const content = () => shadow().querySelector('.chapter-content');

  // --- Stub the DeepSeek endpoint -----------------------------------------
  const realFetch = window.fetch.bind(window);
  let deepseekCalls = 0;
  let firstRequest = null;
  window.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.deepseek.com')) {
      deepseekCalls += 1;
      const body = JSON.parse(opts.body);
      if (!firstRequest) firstRequest = body;
      const userMsg = body.messages[body.messages.length - 1].content;
      // The JSON payload is the final line of the prompt.
      const payload = userMsg.split('\n').reverse().find((line) => line.trim().startsWith('['));
      const texts = JSON.parse(payload);
      const translations = texts.map((t) => `TR: ${t}`);
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ translations }) } }],
        usage: {
          prompt_tokens: 180,
          completion_tokens: 90,
          total_tokens: 270,
          prompt_cache_hit_tokens: 0,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  // --- Stub downloads so nothing hits disk --------------------------------
  const downloads = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {
    if (this.download) {
      downloads.push({ name: this.download, href: this.href });
      return;
    }
    return originalClick.apply(this, arguments);
  };

  // --- Load the fixture EPUB through the real file input ------------------
  const bytes = await (await realFetch('/test/fixtures/sample.epub')).arrayBuffer();
  const file = new File([bytes], 'sample.epub', { type: 'application/epub+zip' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.getElementById('file-input');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change'));

  for (let i = 0; i < 120 && document.getElementById('book-title').textContent === '\u2014'; i += 1) await sleep(50);

  const title = document.getElementById('book-title').textContent;
  step('epub loads and metadata is shown', title === 'Le Petit Livre', title);
  step('table of contents is populated', document.getElementById('toc-select').options.length === 2, document.getElementById('toc-select').options.length);
  const tocFirst = document.getElementById('toc-select').options[0].textContent;
  step('toc uses nav labels', tocFirst.includes('Le Premier Chapitre'), tocFirst);

  // The token estimate is computed in the background after the book loads.
  for (let i = 0; i < 100; i += 1) {
    if (document.getElementById('estimate').textContent.startsWith('Whole book')) break;
    await sleep(50);
  }
  const estimate = document.getElementById('estimate');
  step('token estimate appears after load', !estimate.hidden && /tokens/.test(estimate.textContent), estimate.textContent);

  const originalText = content().textContent;
  step('chapter renders in the reader', originalText.includes('Le Premier Chapitre'), originalText.slice(0, 60));
  step('images are rewritten to blob URLs', /blob:/.test(content().innerHTML));
  step('entity + inline markup survive rendering', content().querySelector('em') && /\u00a0/.test(originalText));
  step('epub stylesheet is inlined', shadow().querySelectorAll('.epub-styles style').length >= 1);
  step('shadow DOM isolates styles', shadow().querySelectorAll('body').length === 0);

  // --- Translate with the stubbed endpoint --------------------------------
  document.getElementById('api-key').value = 'sk-test-key';
  document.getElementById('lang-from').value = 'fr';
  document.getElementById('lang-to').value = 'en';
  document.getElementById('scope-select').value = 'book';
  document.getElementById('translate-btn').click();

  for (let i = 0; i < 200 && document.getElementById('download-btn').disabled; i += 1) await sleep(50);

  step('deepseek endpoint was called', deepseekCalls > 0, `calls=${deepseekCalls}`);
  step('request uses the current model', firstRequest?.model === 'deepseek-flash', firstRequest?.model);
  step('thinking is disabled for translation', firstRequest?.thinking?.type === 'disabled', JSON.stringify(firstRequest?.thinking));
  step('JSON output is requested', firstRequest?.response_format?.type === 'json_object', JSON.stringify(firstRequest?.response_format));
  step('temperature is still sent (thinking off)', firstRequest?.temperature === 1.3, firstRequest?.temperature);
  const usageEl = document.getElementById('usage');
  step('actual token usage is displayed', !usageEl.hidden);
  step('usage total sums the API responses', document.getElementById('usage-total').textContent === '270', document.getElementById('usage-total').textContent);
  step('usage prompt/completion split is shown', document.getElementById('usage-prompt').textContent === '180' && document.getElementById('usage-completion').textContent === '90');
  step('an estimated cost is shown', /^\$\d/.test(document.getElementById('usage-cost').textContent), document.getElementById('usage-cost').textContent);
  step('translation finished and download is enabled', !document.getElementById('download-btn').disabled);
  step('view auto-switched to translated', document.querySelector('[data-view="translated"]').classList.contains('active'));

  const translatedText = content().textContent;
  step('translated text is rendered', translatedText.includes('TR: Le Premier Chapitre'), translatedText.slice(0, 60));

  // --- Toggle back to the original ----------------------------------------
  document.querySelector('[data-view="original"]').click();
  await sleep(150);
  step('original view is intact after translation', content().textContent.includes('Le Premier Chapitre') && !content().textContent.includes('TR:'));

  // --- Export and inspect the produced EPUB -------------------------------
  document.getElementById('download-btn').click();
  for (let i = 0; i < 120 && downloads.length === 0; i += 1) await sleep(50);

  step('download is triggered', downloads.length === 1, JSON.stringify(downloads.map((d) => d.name)));
  if (downloads.length === 1) {
    const entry = downloads[0];
    step('filename encodes the target language', entry.name.endsWith('.en.epub'), entry.name);

    const exported = await (await realFetch(entry.href)).arrayBuffer();
    const view = new DataView(exported);
    step('exported bytes start with the ZIP signature', view.getUint32(0, false) === 0x504b0304);

    const zip = await JSZip.loadAsync(exported);
    const names = Object.keys(zip.files);
    step('mimetype is the first zip entry', names[0] === 'mimetype', names.slice(0, 4).join(', '));
    step('mimetype content is correct', (await zip.file('mimetype').async('string')) === 'application/epub+zip');

    const chapter = await zip.file('OEBPS/chapter1.xhtml').async('string');
    step('exported chapter contains the translation', chapter.includes('TR:'));
    step('exported chapter keeps untouched markup', chapter.includes('<img') && chapter.includes('alt="illustration"'));
    step('exported chapter has no leftover unstyled page', !chapter.includes('<em>chapitre</em>') || chapter.includes('TR:'));

    const opf = await zip.file('OEBPS/content.opf').async('string');
    step('exported OPF advertises the target language', /<dc:language>en<\/dc:language>/.test(opf));
  }

  return {
    steps,
    deepseekCalls,
    log: document.getElementById('log-list').textContent.replace(/\s+/g, ' ').trim(),
    toast: document.getElementById('toast').textContent,
  };
}
