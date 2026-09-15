// EPUB parsing and re-packaging.
//
// The reader/writer works directly on the original zip so that everything we do
// not touch (fonts, images, CSS, the OPF's manifest, the NCX, …) survives a
// round-trip untouched. Only chapter documents that we actually translate are
// replaced when exporting.

const JSZip = globalThis.JSZip;

if (!JSZip) {
  throw new Error('JSZip failed to load. Make sure vendor/jszip.min.js is present before the app modules.');
}

const XHTML_MEDIA_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
  'application/xml',
  'text/xml',
  'application/x-dtbook+xml',
]);

const EXTENSION_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  css: 'text/css', js: 'text/javascript', json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', ogv: 'video/ogg',
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html',
  ncx: 'application/x-dtbncx+xml', opf: 'application/oebps-package+xml',
  txt: 'text/plain', xml: 'application/xml',
};

export function guessMime(path) {
  const ext = String(path).split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME[ext] || 'application/octet-stream';
}

export function dirname(path) {
  const idx = String(path).lastIndexOf('/');
  return idx === -1 ? '' : String(path).slice(0, idx);
}

export function normalizePath(path) {
  const out = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

/** Resolve an `href` (relative to `baseDir`) to a zip entry path. */
export function resolvePath(baseDir, href) {
  const clean = String(href).split('#')[0].split('?')[0];
  if (!clean) return '';
  return normalizePath(baseDir ? `${baseDir}/${clean}` : clean);
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return doc;
}

function parseHtml(text) {
  return new DOMParser().parseFromString(text, 'text/html');
}

/** Collect descendant elements by local name, namespace-agnostic. */
function byName(root, name) {
  if (!root) return [];
  const lowered = name.toLowerCase();
  return Array.from(root.getElementsByTagName('*')).filter(
    (el) => (el.localName || el.nodeName).toLowerCase() === lowered,
  );
}

function firstByName(root, name) {
  return byName(root, name)[0] ?? null;
}

function textOf(el) {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Read `<title>` from a chapter document without a full parse. */
function peekTitle(markup) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(markup);
  if (!match) return '';
  return match[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export class EpubBook {
  constructor(zip, sourceName) {
    this.zip = zip;
    this.sourceName = sourceName || 'book.epub';
    this.opfPath = '';
    this.opfDir = '';
    this.metadata = { title: '', creator: '', language: '', identifier: '', publisher: '' };
    /** @type {Map<string, {id:string, href:string, mediaType:string, properties:string, path:string}>} */
    this.manifest = new Map();
    /** @type {{index:number, id:string, path:string, mediaType:string, href:string, title:string, raw:string|null, translated:string|null}[]} */
    this.chapters = [];
    /** @type {{label:string, index:number, href:string}[]} */
    this.toc = [];
    /** @type {Map<string,string>} zip path -> replaced content (used on export) */
    this.rewrites = new Map();
    /** @type {Map<string,string>} zip path -> blob URL (reset per book) */
    this.resourceUrls = new Map();
    /** @type {Map<string,Promise<string>>} zip path -> cached text read */
    this.textCache = new Map();
  }

  /** @param {File|Blob|ArrayBuffer} input */
  static async open(input) {
    const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const book = new EpubBook(zip, input.name);
    await book.#init();
    return book;
  }

  async #init() {
    const containerXml = await this.readText('META-INF/container.xml').catch(() => null);
    let opfPath = '';
    if (containerXml) {
      const container = parseXml(containerXml);
      const rootfile = firstByName(container, 'rootfile');
      opfPath = rootfile?.getAttribute('full-path') || '';
    }
    if (!opfPath) {
      // Fallback: find any .opf entry.
      opfPath = Object.keys(this.zip.files).find((name) => name.toLowerCase().endsWith('.opf')) || '';
    }
    if (!opfPath) throw new Error('This file does not look like an EPUB (no package document found).');

    this.opfPath = normalizePath(opfPath);
    this.opfDir = dirname(this.opfPath);

    const opfDoc = parseXml(await this.readText(this.opfPath));
    this.#readMetadata(opfDoc);
    this.#readManifestAndSpine(opfDoc);
    await this.#readToc(opfDoc);

    if (this.chapters.length === 0) {
      throw new Error('This EPUB has no readable chapters in its spine.');
    }
  }

  #readMetadata(opfDoc) {
    this.metadata.title = textOf(firstByName(opfDoc, 'title')) || '';
    this.metadata.creator = textOf(firstByName(opfDoc, 'creator')) || '';
    this.metadata.language = textOf(firstByName(opfDoc, 'language')) || '';
    this.metadata.identifier = textOf(firstByName(opfDoc, 'identifier')) || '';
    this.metadata.publisher = textOf(firstByName(opfDoc, 'publisher')) || '';
    if (!this.metadata.title) {
      this.metadata.title = this.sourceName.replace(/\.epub$/i, '');
    }
  }

  #readManifestAndSpine(opfDoc) {
    for (const item of byName(opfDoc, 'item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (!id || !href) continue;
      this.manifest.set(id, {
        id,
        href,
        mediaType: (item.getAttribute('media-type') || '').toLowerCase(),
        properties: item.getAttribute('properties') || '',
        path: resolvePath(this.opfDir, href),
      });
    }

    const spineEl = firstByName(opfDoc, 'spine');
    this.spineTocId = spineEl?.getAttribute('toc') || '';
    this.spineDirection = spineEl?.getAttribute('page-progression-direction') || '';

    for (const ref of byName(spineEl || opfDoc, 'itemref')) {
      const item = this.manifest.get(ref.getAttribute('idref') || '');
      if (!item) continue;
      if (item.mediaType && !XHTML_MEDIA_TYPES.has(item.mediaType)) continue;
      this.chapters.push({
        index: this.chapters.length,
        id: item.id,
        path: item.path,
        href: item.href,
        mediaType: item.mediaType || 'application/xhtml+xml',
        title: '',
        raw: null,
        translated: null,
      });
    }
  }

  async #readToc(opfDoc) {
    // EPUB 3 navigation document.
    const navItem = [...this.manifest.values()].find((item) => /\bnav\b/.test(item.properties));
    if (navItem) {
      const navRaw = await this.readText(navItem.path).catch(() => null);
      if (navRaw) {
        const navDoc = parseHtml(navRaw);
        const navs = Array.from(navDoc.getElementsByTagName('nav'));
        const tocNav = navs.find((nav) => {
          const type = nav.getAttribute('epub:type') || nav.getAttributeNS('http://www.idpf.org/2007/ops', 'type');
          return type === 'toc';
        }) || navs[0];
        if (tocNav) {
          for (const anchor of Array.from(tocNav.getElementsByTagName('a'))) {
            const href = anchor.getAttribute('href');
            const label = textOf(anchor);
            if (!href || !label) continue;
            const path = resolvePath(dirname(navItem.path), href);
            const index = this.chapters.findIndex((chapter) => chapter.path === path);
            if (index >= 0) this.toc.push({ label, index, href });
          }
        }
      }
    }

    // EPUB 2 NCX fallback.
    if (this.toc.length === 0 && this.spineTocId) {
      const ncxItem = this.manifest.get(this.spineTocId);
      if (ncxItem) {
        const ncxRaw = await this.readText(ncxItem.path).catch(() => null);
        if (ncxRaw) {
          const ncxDoc = parseXml(ncxRaw);
          for (const point of byName(ncxDoc, 'navPoint')) {
            const label = textOf(firstByName(point, 'navLabel'));
            const src = firstByName(point, 'content')?.getAttribute('src');
            if (!label || !src) continue;
            const path = resolvePath(dirname(ncxItem.path), src);
            const index = this.chapters.findIndex((chapter) => chapter.path === path);
            if (index >= 0) this.toc.push({ label, index, href: src });
          }
        }
      }
    }

    // Apply TOC labels to chapters.
    for (const entry of this.toc) {
      const chapter = this.chapters[entry.index];
      if (chapter && !chapter.title) chapter.title = entry.label;
    }
    for (const chapter of this.chapters) {
      if (!chapter.title) chapter.title = `Section ${chapter.index + 1}`;
    }
  }

  /** Read a zip entry as text (cached). */
  async readText(path) {
    if (!this.textCache.has(path)) {
      const entry = this.zip.file(path);
      if (!entry) throw new Error(`Missing entry in EPUB: ${path}`);
      this.textCache.set(path, entry.async('string'));
    }
    return this.textCache.get(path);
  }

  /** Read + cache a chapter's raw markup, filling in its title from `<title>`. */
  async getChapterRaw(index) {
    const chapter = this.chapters[index];
    if (!chapter) throw new Error(`No chapter at index ${index}`);
    if (chapter.raw == null) {
      chapter.raw = await this.readText(chapter.path);
      if (!chapter.title || /^Section \d+$/.test(chapter.title)) {
        const title = peekTitle(chapter.raw);
        if (title) chapter.title = title;
      }
    }
    return chapter.raw;
  }

  /** Store translated markup for a chapter (used for both export and reading). */
  setChapterTranslation(index, markup) {
    const chapter = this.chapters[index];
    if (!chapter) return;
    chapter.translated = markup;
    this.rewrites.set(chapter.path, markup);
  }

  /** Blob URL for an embedded resource (images, fonts, audio …). */
  async resourceUrl(path) {
    if (this.resourceUrls.has(path)) return this.resourceUrls.get(path);
    const entry = this.zip.file(path);
    if (!entry) return null;
    const blob = await entry.async('blob');
    const typed = blob.type ? blob : new Blob([blob], { type: guessMime(path) });
    const url = URL.createObjectURL(typed);
    this.resourceUrls.set(path, url);
    return url;
  }

  /** Replace the OPF `<dc:language>` so the exported book advertises the target language. */
  async setLanguage(code) {
    if (!code) return;
    const opf = await this.readText(this.opfPath).catch(() => null);
    if (!opf) return;
    let updated;
    if (/<dc:language[\s>][\s\S]*?<\/dc:language>/i.test(opf)) {
      updated = opf.replace(/(<dc:language[^>]*>)[\s\S]*?(<\/dc:language>)/i, `$1${code}$2`);
    } else if (/<language[^>]*>[\s\S]*?<\/language>/i.test(opf)) {
      updated = opf.replace(/(<language[^>]*>)[\s\S]*?(<\/language>)/i, `$1${code}$2`);
    } else {
      updated = opf.replace(/<metadata([^>]*)>/i, `<metadata$1><dc:language>${code}</dc:language>`);
    }
    this.rewrites.set(this.opfPath, updated);
  }

  /**
   * Repackage the whole book into a downloadable EPUB blob.
   * `mimetype` is written first and stored uncompressed per the OCF spec.
   */
  async buildEpubBlob() {
    const out = new JSZip();
    out.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    for (const name of Object.keys(this.zip.files)) {
      if (name === 'mimetype') continue;
      const entry = this.zip.files[name];
      if (entry.dir) {
        out.folder(name);
        continue;
      }
      const replacement = this.rewrites.get(name);
      if (replacement != null) {
        out.file(name, replacement, { compression: 'DEFLATE' });
      } else {
        out.file(name, await entry.async('uint8array'), { binary: true, compression: 'DEFLATE' });
      }
    }

    return out.generateAsync({
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
  }

  /** Release blob URLs created for reading. */
  dispose() {
    for (const url of this.resourceUrls.values()) URL.revokeObjectURL(url);
    this.resourceUrls.clear();
  }
}
