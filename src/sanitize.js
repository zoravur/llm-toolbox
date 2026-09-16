// Allowlist sanitizer for untrusted EPUB chapter markup.
//
// Chapters are rendered inside a sandboxed <iframe> whose scripts are disabled,
// so book content can never execute JavaScript against the app. This sanitizer
// is defence in depth: it strips active content (scripts, event handlers,
// executable URL schemes, active embedded documents) and anything not on the
// allowlist, so even if the sandbox were ever weakened the markup that reaches
// the reader still carries no payloads.
//
// The rules mirror the issues in epub-security-audit.md:
//   * event-handler attributes (onerror, onload, …) are removed,
//   * <iframe>/<object>/<embed>/<srcdoc> and other active documents are removed,
//   * javascript:/vbscript:/data:text/html URLs are rejected,
//   * external resource URLs are dropped so a book cannot phone home.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ELEMENT_NODE = 1;
const COMMENT_NODE = 8;

// Curated allowlist of safe, primarily presentational HTML elements. Anything
// else is unwrapped (children kept) unless it is in DROP_ELEMENTS.
const HTML_ALLOWED = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big',
  'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'data', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
  'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hgroup', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'map', 'area', 'mark',
  'nav', 'ol', 'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'section', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt',
  'u', 'ul', 'var', 'wbr', 'audio', 'video', 'track',
]);

// Elements whose entire subtree is discarded: active content, form controls and
// document-level metadata that has no place inside chapter markup.
const DROP_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'portal', 'canvas', 'base', 'link', 'meta',
  'head', 'title', 'form', 'input', 'button', 'select', 'option', 'optgroup',
  'textarea', 'label', 'fieldset', 'legend', 'output', 'progress', 'meter',
  'dialog', 'marquee', 'plaintext', 'xmp', 'listing', 'math', 'mathml',
]);

// Dangerous SVG elements. `script`/`on*` are handled generically elsewhere.
const SVG_DROP = new Set([
  'script', 'foreignobject', 'use', 'animate', 'animatemotion',
  'animatetransform', 'set', 'handler', 'listener', 'discard', 'mpath',
  'cursor', 'a',
]);

const GLOBAL_ATTRS = new Set([
  'id', 'class', 'title', 'lang', 'dir', 'role', 'align', 'valign', 'width',
  'height', 'color', 'face', 'size', 'border', 'cellpadding', 'cellspacing',
  'start', 'reversed', 'open', 'datetime', 'colspan', 'rowspan', 'scope',
  'headers', 'abbr', 'axis', 'char', 'charoff', 'span', 'summary', 'cite',
  'alt', 'loading', 'decoding', 'coords', 'shape', 'usemap', 'name',
]);

const ELEMENT_ATTRS = {
  a: ['href'],
  img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
  source: ['src', 'srcset', 'sizes', 'type', 'media'],
  track: ['src', 'srclang', 'kind', 'label', 'default'],
  video: ['src', 'poster', 'controls', 'preload', 'muted', 'loop', 'width', 'height', 'playsinline'],
  audio: ['src', 'controls', 'preload', 'muted', 'loop'],
  area: ['href', 'alt', 'coords', 'shape', 'target'],
  ol: ['type'],
  li: ['value'],
  time: ['datetime'],
  del: ['datetime', 'cite'],
  ins: ['datetime', 'cite'],
  blockquote: ['cite'],
  q: ['cite'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  table: ['border', 'cellpadding', 'cellspacing', 'summary', 'width'],
};

// Attributes holding a resource URL (fetched automatically) — external values
// are stripped so a book cannot make third-party requests.
const RESOURCE_ATTRS = new Set([
  'src', 'poster', 'data', 'background', 'dynsrc', 'lowsrc', 'longdesc',
]);
// Attributes holding a link URL (only followed on user action).
const LINK_ATTRS = new Set(['href', 'cite']);

// Attributes that are simply never allowed, whatever element they appear on.
const DANGEROUS_ATTRS = new Set([
  'srcdoc', 'sandbox', 'target', 'download', 'ping', 'formaction', 'action',
  'http-equiv', 'content', 'xmlns:xlink', 'xml:base',
]);

const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
// data: media types that are safe to render as a resource.
const SAFE_DATA_URL = /^data:\s*(?:image\/(?!svg\+xml)|audio\/|video\/|font\/|application\/(?:font|octet-stream|vnd\.ms-fontobject))/i;

/** Extract the URL scheme, ignoring whitespace/control characters that browsers skip. */
function schemeOf(value) {
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  return scheme ? scheme[1].toLowerCase() : '';
}

/** True when a leading `//` or `/\` (or `\\`) makes an href protocol-relative. */
function isProtocolRelative(value) {
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, '');
  return /^\/\/|^\/(?=\\)|^\\\\/.test(compact);
}

/**
 * Decide whether a URL is safe to keep.
 * @param {string} value
 * @param {'link'|'resource'} kind
 */
export function isSafeUrl(value, kind) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;

  const scheme = schemeOf(trimmed);
  const protocolRelative = isProtocolRelative(trimmed);
  if (!scheme) {
    // Relative reference or bare fragment.
    return kind === 'link' ? true : !protocolRelative;
  }
  if (kind === 'link') {
    return LINK_SCHEMES.has(scheme);
  }
  if (scheme === 'blob') return true;
  if (scheme === 'data') return SAFE_DATA_URL.test(trimmed);
  return false;
}

/** Filter a `srcset` value, keeping only safe candidate URLs. */
function sanitizeSrcset(value) {
  const out = [];
  for (const part of String(value).split(',')) {
    const match = /^\s*(\S+)(\s+[^,]*)?\s*$/.exec(part);
    if (!match) continue;
    if (!isSafeUrl(match[1], 'resource')) continue;
    out.push(`${match[1]}${match[2] || ''}`.trim());
  }
  return out.join(', ');
}

/** Strip active constructs from an inline `style` attribute. */
export function sanitizeStyle(value) {
  return String(value)
    .replace(/expression\s*\(/gi, '')
    .replace(/(?:javascript|vbscript)\s*:/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _quote, url) => (
      isSafeUrl(url, 'resource') ? whole : 'none'
    ))
    .replace(/[<>]/g, '');
}

/** Strip `@import` and unsafe `url(...)` from a stylesheet. */
export function sanitizeCss(css) {
  return String(css)
    .replace(/@import[^;{}]*(?:;|$)/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/(?:javascript|vbscript)\s*:/gi, '')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _quote, url) => (
      isSafeUrl(url, 'resource') ? whole : 'none'
    ));
}

function hasAllowedPrefix(name) {
  return name.startsWith('aria-') || name.startsWith('data-') || name.startsWith('xml:');
}

function sanitizeAttributes(el, svg) {
  const tag = el.localName.toLowerCase();
  const extra = ELEMENT_ATTRS[tag] || [];

  for (const attr of Array.from(el.attributes)) {
    const raw = attr.name;
    const name = raw.toLowerCase();

    // Event handlers and explicitly dangerous attributes always go.
    if (name.startsWith('on') || DANGEROUS_ATTRS.has(name)) {
      el.removeAttribute(raw);
      continue;
    }
    if (name === 'style') {
      const cleaned = sanitizeStyle(attr.value);
      if (cleaned.trim()) el.setAttribute(raw, cleaned);
      else el.removeAttribute(raw);
      continue;
    }
    if (name === 'srcset' || name === 'imagesrcset') {
      const cleaned = sanitizeSrcset(attr.value);
      if (cleaned) el.setAttribute(raw, cleaned);
      else el.removeAttribute(raw);
      continue;
    }
    if (name === 'href' || name.endsWith(':href')) {
      const kind = tag === 'a' ? 'link' : 'resource';
      if (!isSafeUrl(attr.value, kind)) el.removeAttribute(raw);
      continue;
    }
    if (RESOURCE_ATTRS.has(name)) {
      if (!isSafeUrl(attr.value, 'resource')) el.removeAttribute(raw);
      continue;
    }
    if (LINK_ATTRS.has(name)) {
      if (!isSafeUrl(attr.value, 'link')) el.removeAttribute(raw);
      continue;
    }

    // SVG attributes are presentational and inert; keep them apart from the
    // checks above. HTML attributes fall back to the allowlist.
    if (svg || GLOBAL_ATTRS.has(name) || extra.includes(name) || hasAllowedPrefix(name)) {
      continue;
    }
    el.removeAttribute(raw);
  }
}

function cleanNode(node, parent) {
  if (node.nodeType === COMMENT_NODE) {
    parent.removeChild(node);
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return; // keep text nodes

  const el = node;
  const svg = el.namespaceURI === SVG_NS;
  const tag = el.localName.toLowerCase();

  if (!svg && DROP_ELEMENTS.has(tag)) {
    parent.removeChild(el);
    return;
  }
  if (svg && SVG_DROP.has(tag)) {
    parent.removeChild(el);
    return;
  }

  // Sanitize children before deciding what to do with this node.
  for (const child of Array.from(el.childNodes)) cleanNode(child, el);

  if (svg) {
    sanitizeAttributes(el, true);
    return;
  }
  if (!HTML_ALLOWED.has(tag)) {
    // Unknown element: unwrap it, keeping its (already sanitized) children.
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    return;
  }
  sanitizeAttributes(el, false);
}

/** Sanitize the body of a parsed document in place. */
export function sanitizeDocument(doc) {
  const body = doc && doc.body;
  if (!body) return doc;
  for (const child of Array.from(body.childNodes)) cleanNode(child, body);
  return doc;
}
