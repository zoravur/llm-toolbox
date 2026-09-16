// Application shell: file loading, the left control panel, the translation
// pipeline (with progress + cancellation) and EPUB export.

import { EpubBook } from './epub.js';
import { applySegments, countCharacters, extractSegments } from './epub-text.js';
import { DEFAULT_MODEL, DeepSeekClient, DeepSeekError, MODELS } from './deepseek.js';
import { AUTO_DETECT, LANGUAGES, isRtl, languageName, normalizeLanguageCode } from './languages.js';
import { Reader } from './reader.js';
import {
  PER_REQUEST_OVERHEAD_TOKENS,
  PER_SEGMENT_OVERHEAD_TOKENS,
  estimateCostUsd,
  estimateTokens,
  formatTokens,
  formatUsd,
} from './tokens.js';

const $ = (id) => document.getElementById(id);

const els = {
  app: $('app'),
  panel: $('panel'),
  sidebarToggle: $('sidebar-toggle'),
  securityNotice: $('security-notice'),
  securityDismiss: $('security-dismiss'),
  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  bookCard: $('book-card'),
  bookTitle: $('book-title'),
  bookCreator: $('book-creator'),
  bookMeta: $('book-meta'),
  bookReset: $('book-reset'),
  apiKey: $('api-key'),
  toggleKey: $('toggle-key'),
  rememberKey: $('remember-key'),
  modelSelect: $('model-select'),
  langFrom: $('lang-from'),
  langTo: $('lang-to'),
  scopeSelect: $('scope-select'),
  translateBtn: $('translate-btn'),
  cancelBtn: $('cancel-btn'),
  progress: $('progress'),
  progressBar: $('progress-bar'),
  progressText: $('progress-text'),
  estimate: $('estimate'),
  usage: $('usage'),
  usagePrompt: $('usage-prompt'),
  usageCompletion: $('usage-completion'),
  usageTotal: $('usage-total'),
  usageRequests: $('usage-requests'),
  usageCost: $('usage-cost'),
  log: $('log'),
  logList: $('log-list'),
  downloadBtn: $('download-btn'),
  readerBookTitle: $('reader-book-title'),
  chapterTitle: $('chapter-title'),
  prevBtn: $('prev-btn'),
  nextBtn: $('next-btn'),
  tocSelect: $('toc-select'),
  viewButtons: Array.from(document.querySelectorAll('[data-view]')),
  fontDec: $('font-dec'),
  fontInc: $('font-inc'),
  themeToggle: $('theme-toggle'),
  reader: $('reader'),
  emptyState: $('empty-state'),
  viewNote: $('view-note'),
  toast: $('toast'),
};

const BATCH_MAX_CHARS = 3500;
const BATCH_MAX_ITEMS = 50;
const CONCURRENCY = 3;
const SETTINGS_KEY = 'epub-translator:settings:v1';

const state = {
  book: null,
  reader: new Reader(els.reader),
  currentIndex: 0,
  view: 'original',
  translating: false,
  abortController: null,
  usage: { inputTokens: 0, outputTokens: 0, hitTokens: 0, requests: 0 },
  estimate: null,
  settings: {
    model: DEFAULT_MODEL,
    source: AUTO_DETECT,
    target: 'en',
    scope: 'book',
    theme: 'light',
    fontSize: 18,
    rememberKey: false,
    apiKey: '',
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function slugify(value) {
  return String(value || 'book')
    .normalize('NFKD')
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'book';
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

let toastTimer = null;
function toast(message, kind = 'info') {
  els.toast.textContent = message;
  els.toast.dataset.kind = kind;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 5200);
}

function log(message, kind = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.innerHTML = `<span class="log-time">${time}</span><span class="log-msg"></span>`;
  line.querySelector('.log-msg').textContent = message;
  els.logList.appendChild(line);
  els.logList.scrollTop = els.logList.scrollHeight;
  while (els.logList.childElementCount > 200) els.logList.firstElementChild.remove();
}

function clearLog() {
  els.logList.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch {
    /* ignore malformed settings */
  }
}

function saveSettings() {
  state.settings.model = els.modelSelect.value;
  state.settings.source = els.langFrom.value;
  state.settings.target = els.langTo.value;
  state.settings.scope = els.scopeSelect.value;
  state.settings.rememberKey = els.rememberKey.checked;
  state.settings.apiKey = els.rememberKey.checked ? els.apiKey.value : '';
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    /* ignore quota errors */
  }
}

// ---------------------------------------------------------------------------
// Control panel setup
// ---------------------------------------------------------------------------

function populateSelect(select, { includeAuto = false } = {}) {
  select.innerHTML = '';
  if (includeAuto) {
    const opt = document.createElement('option');
    opt.value = AUTO_DETECT;
    opt.textContent = 'Auto-detect';
    select.appendChild(opt);
  }
  for (const lang of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.name;
    select.appendChild(opt);
  }
}

function populateModels() {
  els.modelSelect.innerHTML = '';
  for (const model of MODELS) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.name;
    els.modelSelect.appendChild(opt);
  }
}

function syncControlsFromSettings() {
  // A previously-saved model id may no longer exist (e.g. the retired
  // `deepseek-chat`); fall back to the current default.
  const known = MODELS.some((model) => model.id === state.settings.model);
  state.settings.model = known ? state.settings.model : DEFAULT_MODEL;
  els.modelSelect.value = state.settings.model;
  els.langFrom.value = state.settings.source;
  els.langTo.value = state.settings.target;
  els.scopeSelect.value = state.settings.scope;
  els.rememberKey.checked = state.settings.rememberKey;
  els.apiKey.value = state.settings.rememberKey ? state.settings.apiKey || '' : '';
  applyTheme(state.settings.theme);
  applyFontSize(state.settings.fontSize);
}

function applyTheme(theme) {
  state.settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  els.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  els.themeToggle.textContent = theme === 'dark' ? '☀' : '☾';
  state.reader.updateTheme();
}

function applyFontSize(size) {
  const clamped = Math.max(13, Math.min(30, size));
  state.settings.fontSize = clamped;
  els.reader.style.setProperty('--reader-font-size', `${clamped}px`);
  state.reader.updateTheme();
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

function setupDropzone() {
  document.getElementById('empty-browse')?.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('click', () => els.fileInput.click());
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) handleFile(file);
    els.fileInput.value = '';
  });

  for (const type of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('dragover');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove('dragover');
    });
  }
  els.dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
}

async function handleFile(file) {
  if (!/\.epub$/i.test(file.name) && file.type !== 'application/epub+zip') {
    toast('That does not look like an EPUB file. Trying anyway…', 'warn');
  }
  els.dropzone.classList.add('loading');
  // Release the previous book up front so its blob URLs are not leaked.
  if (state.book) {
    state.book.dispose();
    state.book = null;
  }
  try {
    const book = await EpubBook.open(file);
    state.book = book;
    state.reader.setBook(book);
    state.view = 'original';
    clearLog();
    log(`Loaded "${book.metadata.title}" — ${formatNumber(book.chapters.length)} sections.`, 'ok');
    if (book.metadata.language) {
      log(`Source language reported by the book: ${languageName(normalizeLanguageCode(book.metadata.language) || book.metadata.language)}.`, 'info');
    }

    els.bookCard.hidden = false;
    els.bookTitle.textContent = book.metadata.title;
    els.bookCreator.textContent = book.metadata.creator || 'Unknown author';
    els.bookMeta.textContent = `${formatNumber(book.chapters.length)} sections`;
    els.readerBookTitle.textContent = book.metadata.title;
    els.emptyState.hidden = true;

    resetUsage();
    state.estimate = null;
    renderEstimate();
    buildTocSelect();
    setViewEnabled(true);
    updateViewButtons();
    await showChapter(0);

    // Warm the chapter cache and show an up-front token estimate (runs in the
    // background; it also makes the first translation noticeably snappier).
    updateTokenEstimate();

    els.translateBtn.disabled = false;
    els.downloadBtn.disabled = !bookHasTranslations();
    if (!els.langFrom.value || els.langFrom.value === AUTO_DETECT) {
      const guess = normalizeLanguageCode(book.metadata.language);
      if (guess) log(`Auto-detect selected; the book suggests the source is ${languageName(guess)}.`, 'info');
    }
  } catch (error) {
    console.error(error);
    toast(`Could not open this EPUB: ${error.message}`, 'error');
    log(`Failed to open file: ${error.message}`, 'error');
    teardownBook();
  } finally {
    els.dropzone.classList.remove('loading');
  }
}

/** Drop the current book and return the UI to its empty state. */
function teardownBook() {
  if (state.book) state.book.dispose();
  state.book = null;
  state.reader.setBook(null);
  els.bookCard.hidden = true;
  els.emptyState.hidden = false;
  els.readerBookTitle.textContent = 'No book loaded';
  els.chapterTitle.textContent = '';
  els.tocSelect.innerHTML = '';
  els.downloadBtn.disabled = true;
  els.translateBtn.disabled = true;
  state.estimate = null;
  renderEstimate();
  resetUsage();
  els.viewNote.hidden = true;
  setViewEnabled(false);
}

function bookHasTranslations() {
  return Boolean(state.book?.chapters.some((chapter) => chapter.translated != null));
}

function buildTocSelect() {
  els.tocSelect.innerHTML = '';
  state.book.chapters.forEach((chapter, index) => {
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = `${index + 1}. ${chapter.title || `Section ${index + 1}`}`;
    els.tocSelect.appendChild(opt);
  });
}

function setViewEnabled(enabled) {
  els.viewButtons.forEach((button) => {
    button.disabled = !enabled;
  });
  els.tocSelect.disabled = !enabled;
  els.prevBtn.disabled = !enabled;
  els.nextBtn.disabled = !enabled;
}

// ---------------------------------------------------------------------------
// Reading / navigation
// ---------------------------------------------------------------------------

function currentRtl() {
  if (state.view === 'translated') return isRtl(els.langTo.value);
  const bookLang = normalizeLanguageCode(state.book?.metadata.language);
  return isRtl(bookLang) || state.book?.spineDirection === 'rtl';
}

async function showChapter(index, options = {}) {
  if (!state.book) return;
  const last = state.book.chapters.length - 1;
  const clamped = Math.max(0, Math.min(last, index));
  const chapter = state.book.chapters[clamped];

  const result = await state.reader.render(clamped, {
    mode: state.view,
    rtl: currentRtl(),
    fragment: options.fragment,
    restoreScroll: Boolean(options.restoreScroll),
  });

  state.currentIndex = clamped;
  els.tocSelect.value = String(clamped);
  els.chapterTitle.textContent = chapter.title || `Section ${clamped + 1}`;
  els.prevBtn.disabled = clamped === 0;
  els.nextBtn.disabled = clamped === last;

  if (state.view === 'translated' && result.ok && !result.hasTranslation) {
    els.viewNote.hidden = false;
    els.viewNote.textContent = bookHasTranslations()
      ? 'This section has not been translated yet — showing the original text.'
      : 'No translations yet. Paste your DeepSeek key and press Translate.';
  } else {
    els.viewNote.hidden = true;
  }
}

function setView(view) {
  state.view = view;
  updateViewButtons();
  if (state.book) showChapter(state.currentIndex, { restoreScroll: true });
}

function updateViewButtons() {
  els.viewButtons.forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function stepChapter(delta) {
  if (!state.book) return;
  showChapter(state.currentIndex + delta);
}

// ---------------------------------------------------------------------------
// Translation pipeline
// ---------------------------------------------------------------------------

function setBusy(busy) {
  state.translating = busy;
  els.translateBtn.disabled = busy || !state.book;
  els.translateBtn.querySelector('.btn-label').textContent = busy ? 'Translating…' : 'Translate';
  els.cancelBtn.hidden = !busy;
  els.scopeSelect.disabled = busy;
  els.modelSelect.disabled = busy;
  els.langFrom.disabled = busy;
  els.langTo.disabled = busy;
}

function setProgress(done, total, chars) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.width = `${pct}%`;
  els.progressText.textContent = `${formatNumber(done)} / ${formatNumber(total)} segments · ${formatNumber(chars)} chars · ${pct}%`;
}

function chunkJobs(jobs) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const job of jobs) {
    const size = job.text.length;
    if (current.length > 0 && (chars + size > BATCH_MAX_CHARS || current.length >= BATCH_MAX_ITEMS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(job);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Read every selected chapter, extract translatable segments and de-duplicate
 * identical strings across the whole selection.
 *
 * @returns {Promise<{jobs: {id:number,text:string}[], plan: Map<number, {raw:string, segments:object[], ids:number[]}>}>}
 */
async function buildPlan(book, chapterIndexes) {
  const jobs = [];
  const jobIdByText = new Map();
  const plan = new Map();

  for (const index of chapterIndexes) {
    const raw = await book.getChapterRaw(index);
    const segments = extractSegments(raw);
    const ids = [];
    for (const segment of segments) {
      let id = jobIdByText.get(segment.plain);
      if (id === undefined) {
        id = jobs.length;
        jobIdByText.set(segment.plain, id);
        jobs.push({ id, text: segment.plain });
      }
      ids.push(id);
    }
    plan.set(index, { raw, segments, ids });
  }

  return { jobs, plan };
}

/** Pre-flight token + cost estimate for a set of jobs and their batches. */
function estimateRun(jobs, batches, model) {
  const inputTokens = jobs.reduce((sum, job) => sum + estimateTokens(job.text), 0)
    + batches.length * PER_REQUEST_OVERHEAD_TOKENS
    + jobs.length * PER_SEGMENT_OVERHEAD_TOKENS;
  // Translated output tends to be roughly the same length as the source, so we
  // reuse the input estimate for the completion side.
  const outputTokens = inputTokens;
  return { inputTokens, outputTokens, costUsd: estimateCostUsd({ model, inputTokens, outputTokens }) };
}

function resetUsage() {
  state.usage = { inputTokens: 0, outputTokens: 0, hitTokens: 0, requests: 0 };
  els.usage.hidden = true;
  renderUsage();
}

/** Fold one API `usage` object into the running totals and refresh the display. */
function accumulateUsage(usage) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const hit = Number(usage.prompt_cache_hit_tokens ?? 0) || 0;

  state.usage.inputTokens += input;
  state.usage.outputTokens += output;
  state.usage.hitTokens += hit;
  state.usage.requests += 1;

  els.usage.hidden = false;
  renderUsage();
}

function renderUsage() {
  const { inputTokens, outputTokens, hitTokens, requests } = state.usage;
  const model = els.modelSelect.value || DEFAULT_MODEL;
  els.usagePrompt.textContent = formatTokens(inputTokens);
  els.usageCompletion.textContent = formatTokens(outputTokens);
  els.usageTotal.textContent = formatTokens(inputTokens + outputTokens);
  els.usageRequests.textContent = formatNumber(requests);
  els.usageCost.textContent = formatUsd(estimateCostUsd({
    model,
    inputTokens,
    outputTokens,
    cacheHitTokens: hitTokens,
  }));
}

/** Background pre-flight estimate shown as soon as a book is loaded. */
async function updateTokenEstimate() {
  if (!state.book) {
    els.estimate.hidden = true;
    return;
  }
  els.estimate.hidden = false;
  els.estimate.textContent = 'Estimating tokens…';
  const current = state.book;
  try {
    const { jobs } = await buildPlan(current, current.chapters.map((chapter) => chapter.index));
    if (state.book !== current) return; // a different book was loaded meanwhile
    const batches = chunkJobs(jobs);
    const { inputTokens } = estimateRun(jobs, batches, els.modelSelect.value || DEFAULT_MODEL);
    state.estimate = { jobs: jobs.length, inputTokens, batches: batches.length };
    renderEstimate();
  } catch {
    els.estimate.hidden = true;
  }
}

function renderEstimate() {
  if (!state.estimate) {
    els.estimate.hidden = true;
    return;
  }
  const { jobs, inputTokens, batches } = state.estimate;
  els.estimate.hidden = false;
  els.estimate.textContent = `Whole book: ${formatNumber(jobs)} segments · ~${formatTokens(inputTokens)} tokens`
    + ` · ${formatNumber(batches)} API requests`;
}

async function runTranslation() {
  const book = state.book;
  if (!book) {
    toast('Load an EPUB before translating.', 'warn');
    return;
  }
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    toast('Paste your DeepSeek API key in the left panel first.', 'warn');
    els.apiKey.focus();
    return;
  }

  const targetCode = els.langTo.value;
  const sourceCode = els.langFrom.value === AUTO_DETECT ? '' : els.langFrom.value;
  const scope = els.scopeSelect.value;
  const model = els.modelSelect.value;

  let client;
  try {
    client = new DeepSeekClient({ apiKey, model });
  } catch (error) {
    toast(error.message, 'error');
    return;
  }

  const chapterIndexes = scope === 'chapter'
    ? [state.currentIndex]
    : book.chapters.map((chapter) => chapter.index);

  // --- 1. Extract translatable segments, de-duplicating identical strings ----
  const { jobs, plan } = await buildPlan(book, chapterIndexes);

  if (jobs.length === 0) {
    toast('There is no translatable text in the selected range.', 'warn');
    return;
  }

  const totalChars = jobs.reduce((sum, job) => sum + job.text.length, 0);
  const uniqueChars = countCharacters([...plan.values()].flatMap((entry) => entry.segments));
  const batches = chunkJobs(jobs);
  const results = new Array(jobs.length).fill(null);
  const estimate = estimateRun(jobs, batches, model);

  resetUsage();

  log(
    `Translating ${scope === 'chapter' ? 'the current section' : `the whole book (${chapterIndexes.length} sections)`} → ${languageName(targetCode)}`
    + ` using ${model}. ${formatNumber(jobs.length)} unique segments (${formatNumber(totalChars)} chars,`
    + ` ~${formatTokens(estimate.inputTokens)} tokens, ${formatNumber(batches.length)} requests, ~${formatUsd(estimate.costUsd)}).`,
    'info',
  );
  if (uniqueChars > totalChars * 1.4) {
    log('Many repeated strings were found and de-duplicated to save tokens.', 'info');
  }

  const controller = new AbortController();
  state.abortController = controller;
  setBusy(true);
  els.progress.hidden = false;
  setProgress(0, jobs.length, totalChars);

  let done = 0;
  let failures = 0;

  try {
    const queue = batches.slice();
    const worker = async () => {
      while (queue.length > 0 && !controller.signal.aborted) {
        const batch = queue.shift();
        const texts = batch.map((job) => job.text);
        const translations = await client.translateBatch(texts, {
          source: sourceCode ? languageName(sourceCode) : '',
          target: languageName(targetCode),
          signal: controller.signal,
          onNote: (note) => log(note, 'warn'),
          onUsage: (usage) => accumulateUsage(usage),
        });
        batch.forEach((job, i) => {
          const value = translations[i];
          if (value == null || value === '') failures += 1;
          results[job.id] = value ?? job.text;
        });
        done += batch.length;
        setProgress(done, jobs.length, totalChars);
      }
    };

    const workerCount = Math.max(1, Math.min(CONCURRENCY, queue.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (controller.signal.aborted) {
      log('Translation cancelled. No changes were applied.', 'warn');
      toast('Translation cancelled.', 'warn');
      return;
    }

    // --- 3. Splice translations back into each chapter ---------------------
    for (const [index, entry] of plan) {
      const translations = entry.segments.map((_, i) => results[entry.ids[i]]);
      const markup = applySegments(entry.raw, entry.segments, translations);
      book.setChapterTranslation(index, markup);
    }
    await book.setLanguage(targetCode);

    log(`Translation complete for ${chapterIndexes.length} section(s).`, 'ok');
    if (failures > 0) log(`${failures} segment(s) kept their original text.`, 'warn');

    els.downloadBtn.disabled = false;
    state.view = 'translated';
    updateViewButtons();
    await showChapter(state.currentIndex, { restoreScroll: true });
    toast('Translation finished — download the translated EPUB below.', 'ok');
  } catch (error) {
    if (error?.name === 'AbortError') {
      log('Translation cancelled.', 'warn');
      toast('Translation cancelled.', 'warn');
    } else {
      const message = error instanceof DeepSeekError ? error.message : error?.message || String(error);
      log(`Translation failed: ${message}`, 'error');
      toast(message, 'error');
      if (error instanceof DeepSeekError && (error.status === 401 || error.status === 403)) {
        els.apiKey.focus();
      }
    }
  } finally {
    state.abortController = null;
    setBusy(false);
    els.progress.hidden = true;
  }
}

function cancelTranslation() {
  state.abortController?.abort();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function buildFileName() {
  const title = slugify(state.book?.metadata.title || 'book');
  const target = els.langTo.value || 'translated';
  return `${title}.${target}.epub`;
}

async function downloadEpub() {
  if (!state.book || !bookHasTranslations()) {
    toast('Translate the book first, then download it.', 'warn');
    return;
  }
  const label = els.downloadBtn.querySelector('.btn-label');
  const previous = label.textContent;
  els.downloadBtn.disabled = true;
  label.textContent = 'Packaging…';
  try {
    const blob = await state.book.buildEpubBlob();
    const filename = buildFileName();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    log(`Saved ${filename} (${formatBytes(blob.size)}).`, 'ok');
    toast(`Downloaded ${filename}`, 'ok');
  } catch (error) {
    console.error(error);
    toast(`Could not build the EPUB: ${error.message}`, 'error');
  } finally {
    els.downloadBtn.disabled = false;
    label.textContent = previous;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function bindEvents() {
  els.translateBtn.addEventListener('click', runTranslation);
  els.cancelBtn.addEventListener('click', cancelTranslation);
  els.downloadBtn.addEventListener('click', downloadEpub);

  els.tocSelect.addEventListener('change', () => showChapter(Number(els.tocSelect.value)));
  els.prevBtn.addEventListener('click', () => stepChapter(-1));
  els.nextBtn.addEventListener('click', () => stepChapter(1));

  els.viewButtons.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });

  els.fontDec.addEventListener('click', () => {
    applyFontSize(state.settings.fontSize - 1);
    saveSettings();
  });
  els.fontInc.addEventListener('click', () => {
    applyFontSize(state.settings.fontSize + 1);
    saveSettings();
  });
  els.themeToggle.addEventListener('click', () => {
    applyTheme(state.settings.theme === 'dark' ? 'light' : 'dark');
    saveSettings();
  });

  els.sidebarToggle.addEventListener('click', () => els.app.classList.toggle('sidebar-open'));

  els.securityDismiss?.addEventListener('click', () => {
    els.securityNotice.hidden = true;
  });

  els.toggleKey.addEventListener('click', () => {
    const showing = els.apiKey.type === 'text';
    els.apiKey.type = showing ? 'password' : 'text';
    els.toggleKey.textContent = showing ? 'Show' : 'Hide';
  });

  els.bookReset.addEventListener('click', () => {
    teardownBook();
    log('Book removed.', 'info');
  });

  for (const control of [els.modelSelect, els.langFrom, els.langTo, els.scopeSelect, els.rememberKey]) {
    control.addEventListener('change', saveSettings);
  }
  els.rememberKey.addEventListener('change', () => {
    if (!els.rememberKey.checked) els.apiKey.value = '';
    saveSettings();
  });
  els.apiKey.addEventListener('input', () => {
    if (els.rememberKey.checked) saveSettings();
  });

  document.addEventListener('keydown', (event) => {
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!state.book) return;
    if (event.key === 'ArrowRight') stepChapter(1);
    else if (event.key === 'ArrowLeft') stepChapter(-1);
  });

  state.reader.onNavigate = (index, fragment) => showChapter(index, { fragment });
}

function init() {
  populateModels();
  populateSelect(els.langFrom, { includeAuto: true });
  populateSelect(els.langTo);
  loadSettings();
  syncControlsFromSettings();
  setupDropzone();
  bindEvents();
  setViewEnabled(false);
  els.viewNote.hidden = true;
  updateViewButtons();
  log('Ready. Load an EPUB to begin.', 'info');
}

init();
