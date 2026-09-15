// In-browser chapter renderer.
//
// Rendered inside a shadow root so the book's own CSS cannot leak into the app
// chrome (and vice-versa), while still letting the exported styles apply. Images,
// fonts and stylesheets from the EPUB are rewritten to blob URLs so they resolve
// without a server.

import { dirname, resolvePath } from './epub.js';

const XLINK_NS = 'http://www.w3.org/1999/xlink';

const BASE_CSS = `
  :host { display:block; height:100%; overflow-y:auto; background: var(--reader-bg); color: var(--reader-fg); }
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

function escapeCssIdent(value) {
  if (globalThis.CSS?.escape) return CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

const ABSOLUTE_URL = /^(data:|https?:|\/\/|#|blob:|mailto:|tel:|javascript:)/i;

export class Reader {
  /**
   * @param {HTMLElement} host an empty element that will own the shadow root
   */
  constructor(host) {
    this.host = host;
    this.shadow = host.attachShadow({ mode: 'open' });
    this.shadow.innerHTML = `
      <div class="epub-styles"></div>
      <style class="reader-base">${BASE_CSS}</style>
      <div class="page"><div class="chapter-content" part="content"></div></div>
    `;
    this.styleHost = this.shadow.querySelector('.epub-styles');
    this.container = this.shadow.querySelector('.chapter-content');
    this.book = null;
    this.currentIndex = -1;
    this.mode = 'original';
    this.scrollPositions = new Map();
    /** @type {((index:number, fragment?:string)=>void)|null} */
    this.onNavigate = null;
    this.#bindLinkHandling();
  }

  #bindLinkHandling() {
    this.container.addEventListener('click', (event) => {
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
          anchor.setAttribute('target', '_blank');
          anchor.setAttribute('rel', 'noopener noreferrer');
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
    const id = decodeURIComponent(fragment);
    const target = this.container.querySelector(`[id="${escapeCssIdent(id)}"]`)
      || this.container.querySelector(`[name="${escapeCssIdent(id)}"]`);
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  setBook(book) {
    this.book = book;
    this.currentIndex = -1;
    this.scrollPositions.clear();
    this.container.innerHTML = '';
    this.styleHost.innerHTML = '';
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
      sheets.push(await this.#rewriteCssUrls(css, dirname(path)));
      link.remove();
    }
    for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
      sheets.push(await this.#rewriteCssUrls(styleEl.textContent || '', baseDir));
      styleEl.remove();
    }
    return sheets;
  }

  async #rewriteResources(doc, baseDir) {
    const targets = [
      ['img', 'src'], ['image', 'href'], ['image', 'xlink:href'],
      ['source', 'src'], ['source', 'srcset'], ['audio', 'src'], ['video', 'src'],
      ['video', 'poster'], ['object', 'data'], ['embed', 'src'], ['iframe', 'src'], ['track', 'src'],
    ];
    for (const [selector, attr] of targets) {
      if (attr === 'srcset') continue;
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        const value = el.getAttribute(attr);
        if (!value || ABSOLUTE_URL.test(value.trim())) continue;
        const url = await this.book.resourceUrl(resolvePath(baseDir, value));
        if (url) el.setAttribute(attr, url);
      }
    }
    for (const el of Array.from(doc.querySelectorAll('image'))) {
      const xlink = el.getAttributeNS(XLINK_NS, 'href');
      if (xlink && !ABSOLUTE_URL.test(xlink)) {
        const url = await this.book.resourceUrl(resolvePath(baseDir, xlink));
        if (url) el.setAttributeNS(XLINK_NS, 'xlink:href', url);
      }
    }
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
      this.scrollPositions.set(this.currentIndex, this.host.scrollTop);
    }

    const baseDir = dirname(chapter.path);
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    for (const script of Array.from(doc.querySelectorAll('script'))) script.remove();
    await this.#rewriteResources(doc, baseDir);
    const sheets = await this.#collectStyles(doc, baseDir);

    this.styleHost.innerHTML = '';
    for (const css of sheets) {
      const styleEl = document.createElement('style');
      styleEl.textContent = css;
      this.styleHost.appendChild(styleEl);
    }

    this.container.innerHTML = '';
    this.container.setAttribute('dir', options.rtl ? 'rtl' : 'ltr');
    for (const node of Array.from(doc.body.childNodes)) {
      this.container.appendChild(document.importNode(node, true));
    }

    this.currentIndex = index;
    this.mode = mode;

    if (options.restoreScroll && this.scrollPositions.has(index)) {
      this.host.scrollTop = this.scrollPositions.get(index);
    } else {
      this.host.scrollTop = 0;
    }

    if (options.fragment) {
      requestAnimationFrame(() => this.#scrollToAnchor(options.fragment));
    }

    return { ok: true, mode, requestedTranslated: requested === 'translated', hasTranslation: chapter.translated != null };
  }

  scrollToTop() {
    this.host.scrollTop = 0;
  }
}
