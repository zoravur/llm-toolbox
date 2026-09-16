// In-browser chapter renderer.
//
// Untrusted book markup is rendered inside a sandboxed <iframe>, never directly
// in the app document. The iframe is created with `sandbox="allow-same-origin"`
// and, crucially, WITHOUT `allow-scripts`: every script in the book — inline
// <script>, event-handler attributes, javascript: URLs and nested frames — is
// therefore blocked by the browser sandbox. `allow-same-origin` is kept so the
// reader can drive navigation and scroll position and so the e2e suite can
// inspect the rendered document; with scripts disabled that same-origin
// document cannot run any code against the app or read the API-key input.
//
// This mirrors epub-security-audit.md finding #1. As defence in depth the markup
// is also passed through an allowlist sanitizer (src/sanitize.js), every
// resource is rewritten to a same-origin blob URL, external resources are
// dropped, and the book document carries a restrictive CSP.

import { dirname, resolvePath } from './epub.js';
import { sanitizeCss, sanitizeDocument } from './sanitize.js';

const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Content Security Policy for every book document: no scripts, no plugins, no
// network, no frames. Only same-origin blob/data resources and inline styles.
const BOOK_CSP = [
  "default-src 'none'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' blob: data:",
  "style-src 'unsafe-inline'",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const BLANK_DOC = '<!DOCTYPE html><html><head><meta charset="utf-8">'
  + `<meta http-equiv="Content-Security-Policy" content="${BOOK_CSP}"></head><body></body></html>`;

// Base styling for the book document itself (the iframe's own document, so
// these select html/body rather than :host).
const BASE_CSS = `
  html, body { margin:0; padding:0; }
  body { background: var(--reader-bg); color: var(--reader-fg); }
  .page { min-height:100%; box-sizing:border-box; padding: 3rem 1.5rem 7rem; }
  .chapter-content {
    max-width: var(--reader-measure, 40rem);
    margin: 0 auto;
    font-family: var(--reader-font, Georgia, "Iowan Old Style", "Times New Roman", serif);
    font-size: var(--reader-font-size, 1.125rem);
    line-height: var(--reader-line-height, 1.7);
    text-align: start;
    overflow-wrap: break-word;
  }
  .chapter-content > :first-child { margin-top: 0; }
  .chapter-content img, .chapter-content svg, .chapter-content video, .chapter-content table { max-width: 100%; height: auto; }
  .chapter-content h1, .chapter-content h2, .chapter-content h3, .chapter-content h4, .chapter-content h5, .chapter-content h6 {
    line-height: 1.3; margin: 1.6em 0 .6em; font-weight: 600;
  }
  .chapter-content p { margin: 0 0 1em; }
  .chapter-content a { color: var(--reader-link); text-decoration: underline; text-underline-offset: 2px; }
  .chapter-content blockquote { margin: 1.2em 1.5em; font-style: italic; opacity: .92; }
  .chapter-content pre, .chapter-content code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: .92em; }
  .chapter-content pre { overflow-x: auto; padding: .8em 1em; background: var(--reader-code-bg); border-radius: 8px; }
  .chapter-content hr { border: none; border-top: 1px solid var(--reader-rule); margin: 2.4em auto; width: 42%; }
  .chapter-content table { border-collapse: collapse; }
  .chapter-content td, .chapter-content th { border: 1px solid var(--reader-rule); padding: .35em .6em; }
  .chapter-content figure { margin: 1.4em 0; }
  .chapter-content figcaption { font-size: .9em; opacity: .75; text-align: center; }
  ::selection { background: var(--reader-selection); }
`;

// App CSS variables copied into the book document so theming and font size
// changes keep working inside the isolated iframe.
const READER_VARS = [
  '--reader-bg', '--reader-fg', '--reader-link', '--reader-rule',
  '--reader-code-bg', '--reader-selection', '--reader-font-size',
  '--reader-line-height', '--reader-measure', '--reader-font',
];

function escapeCssIdent(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function escapeStyleText(text) {
  // Prevent a book stylesheet from closing its own <style> element.
  return String(text).replace(/<\/(style|script)/gi, '<\\/$1');
}

const ABSOLUTE_URL = /^(data:|https?:|\/\/|#|blob:|mailto:|tel:|javascript:)/i;

export class Reader {
  /**
   * @param {HTMLElement} host an element that will hold the sandboxed iframe
   */
  constructor(host) {
    this.host = host;
    this.frame = document.createElement('iframe');
    this.frame.className = 'reader-frame';
    this.frame.setAttribute('title', 'Book content');
    this.frame.setAttribute('referrerpolicy', 'no-referrer');
    // No `allow-scripts`: EPUB content can never execute JavaScript. The
    // `allow-same-origin` token only lets the parent read/drive the frame.
    this.frame.setAttribute('sandbox', 'allow-same-origin');
    this.frame.setAttribute('srcdoc', BLANK_DOC);
    host.appendChild(this.frame);

    this.book = null;
    this.currentIndex = -1;
    this.mode = 'original';
    this.scrollPositions = new Map();
    this.boundDocument = null;
    this.revision = 0;
    /** @type {((index:number, fragment?:string)=>void)|null} */
    this.onNavigate = null;
  }

  /** The book document, or null before the iframe has loaded. */
  get document() {
    try {
      return this.frame.contentDocument || null;
    } catch {
      return null;
    }
  }

  get window() {
    try {
      return this.frame.contentWindow || null;
    } catch {
      return null;
    }
  }

  /** Load new markup into the sandbox and resolve once the document is ready. */
  #loadFrame(html) {
    return new Promise((resolve) => {
      const frame = this.frame;
      const onLoad = () => {
        frame.removeEventListener('load', onLoad);
        resolve();
      };
      frame.addEventListener('load', onLoad);
      // Make each document unique so an identical string still triggers a load.
      frame.setAttribute('srcdoc', `${html}<!--r${(this.revision += 1)}-->`);
    });
  }

  #bindLinkHandling() {
    const doc = this.document;
    if (!doc || this.boundDocument === doc) return;
    this.boundDocument = doc;

    doc.addEventListener('click', (event) => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;

      if (href.startsWith('#')) {
        event.preventDefault();
        this.#scrollToAnchor(href.slice(1));
        return;
      }
      if (ABSOLUTE_URL.test(href) && !href.startsWith('blob:')) {
        if (/^https?:|^mailto:|^tel:/i.test(href)) {
          // Sandboxed frames cannot open popups themselves; the app does it.
          event.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
        }
        return;
      }

      const chapter = this.book?.chapters[this.currentIndex];
      if (!chapter) return;
      const path = resolvePath(dirname(chapter.path), href);
      const target = this.book.chapters.findIndex((c) => c.path === path);
      if (target >= 0) {
        event.preventDefault();
        const fragment = href.includes('#') ? href.split('#')[1] : undefined;
        this.onNavigate?.(target, fragment);
      }
    });
  }

  #scrollToAnchor(fragment) {
    if (!fragment) return;
    const doc = this.document;
    if (!doc) return;
    const id = decodeURIComponent(fragment);
    const target = doc.getElementById(id)
      || doc.querySelector(`[name="${escapeCssIdent(id)}"]`);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  setBook(book) {
    this.book = book;
    this.currentIndex = -1;
    this.scrollPositions.clear();
    this.boundDocument = null;
    this.frame.setAttribute('srcdoc', BLANK_DOC);
  }

  /** Copy the app's current reader CSS variables into the book document. */
  updateTheme() {
    const doc = this.document;
    if (!doc?.documentElement) return;
    const computed = getComputedStyle(this.host);
    for (const name of READER_VARS) {
      const value = computed.getPropertyValue(name).trim();
      if (value) doc.documentElement.style.setProperty(name, value);
    }
  }

  #readerVarsCss() {
    const computed = getComputedStyle(this.host);
    const decls = READER_VARS
      .map((name) => {
        const value = computed.getPropertyValue(name).trim();
        return value ? `${name}: ${value};` : '';
      })
      .join(' ');
    return `:root { ${decls} }`;
  }

  async #rewriteCssUrls(css, baseDir) {
    if (!css || !css.includes('url(')) return css;
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const matches = [...css.matchAll(re)];
    if (matches.length === 0) return css;

    const replacements = await Promise.all(matches.map(async (match) => {
      const raw = match[2].trim();
      if (ABSOLUTE_URL.test(raw)) return null;
      const url = await this.book.resourceUrl(resolvePath(baseDir, raw));
      return url ? `url("${url}")` : null;
    }));

    let out = '';
    let cursor = 0;
    matches.forEach((match, i) => {
      const replacement = replacements[i];
      if (replacement == null) return; // keep original text as-is
      out += css.slice(cursor, match.index) + replacement;
      cursor = match.index + match[0].length;
    });
    return out + css.slice(cursor);
  }

  async #collectStyles(doc, baseDir) {
    const sheets = [];
    for (const link of Array.from(doc.querySelectorAll('link'))) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      if (!rel.includes('stylesheet')) continue;
      const href = link.getAttribute('href');
      if (!href || ABSOLUTE_URL.test(href)) continue;
      const path = resolvePath(baseDir, href);
      const css = await this.book.readText(path).catch(() => null);
      if (css == null) continue;
      sheets.push(await this.#rewriteCssUrls(sanitizeCss(css), dirname(path)));
      link.remove();
    }
    for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
      const css = sanitizeCss(styleEl.textContent || '');
      sheets.push(await this.#rewriteCssUrls(css, baseDir));
      styleEl.remove();
    }
    return sheets;
  }

  #rewriteResources(doc, baseDir) {
    const targets = [
      ['img', 'src'], ['image', 'href'], ['image', 'xlink:href'],
      ['source', 'src'], ['audio', 'src'], ['video', 'src'],
      ['video', 'poster'], ['track', 'src'],
    ];
    const jobs = [];
    for (const [selector, attr] of targets) {
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        const value = el.getAttribute(attr);
        if (!value || ABSOLUTE_URL.test(value.trim())) continue;
        jobs.push(this.book.resourceUrl(resolvePath(baseDir, value)).then((url) => {
          if (url) el.setAttribute(attr, url);
        }));
      }
    }
    for (const el of Array.from(doc.querySelectorAll('image'))) {
      const xlink = el.getAttributeNS(XLINK_NS, 'href');
      if (xlink && !ABSOLUTE_URL.test(xlink)) {
        jobs.push(this.book.resourceUrl(resolvePath(baseDir, xlink)).then((url) => {
          if (url) el.setAttributeNS(XLINK_NS, 'xlink:href', url);
        }));
      }
    }
    return Promise.all(jobs);
  }

  #buildDocument(doc, sheets, rtl) {
    const styles = [BASE_CSS, this.#readerVarsCss(), ...sheets]
      .filter(Boolean)
      .map(escapeStyleText)
      .join('\n');
    return [
      '<!DOCTYPE html>',
      `<html dir="${rtl ? 'rtl' : 'ltr'}">`,
      '<head>',
      '<meta charset="utf-8">',
      `<meta http-equiv="Content-Security-Policy" content="${BOOK_CSP}">`,
      '<meta name="referrer" content="no-referrer">',
      `<style>${styles}</style>`,
      '</head>',
      '<body><div class="page"><div class="chapter-content" part="content">',
      doc.body ? doc.body.innerHTML : '',
      '</div></div></body>',
      '</html>',
    ].join('\n');
  }

  /**
   * Render a chapter.
   * @param {number} index spine index
   * @param {{mode?: 'original'|'translated', rtl?: boolean, fragment?: string, restoreScroll?: boolean}} [options]
   */
  async render(index, options = {}) {
    const book = this.book;
    if (!book) return { ok: false };
    const chapter = book.chapters[index];
    if (!chapter) return { ok: false };

    const requested = options.mode ?? this.mode ?? 'original';
    const translated = requested === 'translated' && chapter.translated != null;
    const mode = translated ? 'translated' : 'original';
    const markup = translated ? chapter.translated : await book.getChapterRaw(index);

    if (this.currentIndex >= 0 && this.currentIndex !== index) {
      this.scrollPositions.set(this.currentIndex, this.window?.scrollY || 0);
    }

    const baseDir = dirname(chapter.path);
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    for (const script of Array.from(doc.querySelectorAll('script'))) script.remove();
    const sheets = await this.#collectStyles(doc, baseDir);
    sanitizeDocument(doc);
    await this.#rewriteResources(doc, baseDir);

    await this.#loadFrame(this.#buildDocument(doc, sheets, options.rtl));
    this.#bindLinkHandling();

    this.currentIndex = index;
    this.mode = mode;

    if (options.restoreScroll && this.scrollPositions.has(index)) {
      this.scrollTo(this.scrollPositions.get(index));
    } else {
      this.scrollTo(0);
    }

    if (options.fragment) {
      requestAnimationFrame(() => this.#scrollToAnchor(options.fragment));
    }

    return { ok: true, mode, requestedTranslated: requested === 'translated', hasTranslation: chapter.translated != null };
  }

  scrollTo(position) {
    this.window?.scrollTo(0, position || 0);
  }

  scrollToTop() {
    this.scrollTo(0);
  }
}
