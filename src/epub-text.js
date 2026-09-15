// Text segmentation for chapter (X)HTML.
//
// Why not just parse the DOM and re-serialize? Because EPUB chapters frequently
// contain named entities (`&nbsp;`), custom namespaces, conditional comments and
// hand-tuned markup. A DOM round-trip can silently drop or "fix" all of that and
// produce a technically-valid-but-different book.
//
// Instead we scan the raw markup, remember the exact byte range of every
// translatable text run, and splice translations back in while leaving every
// other character untouched.

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

/** Elements whose textual content should never be translated. */
const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'textarea']);

/** HTML void elements: they never open a scope even when written as `<br>`. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'frame', 'isindex',
]);

/** The subset of HTML named entities that realistically shows up in books. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', deg: '\u00b0', plusmn: '\u00b1',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', horbar: '\u2015',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  sbquo: '\u201a', bdquo: '\u201e', laquo: '\u00ab', raquo: '\u00bb',
  lsaquo: '\u2039', rsaquo: '\u203a', middot: '\u00b7', bull: '\u2022',
  dagger: '\u2020', Dagger: '\u2021', sect: '\u00a7', para: '\u00b6', permil: '\u2030', prime: '\u2032', Prime: '\u2033',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', curren: '\u00a4', brvbar: '\u00a6',
  times: '\u00d7', divide: '\u00f7', minus: '\u2212', micro: '\u00b5', oplus: '\u2295',
  iexcl: '\u00a1', iquest: '\u00bf', ordf: '\u00aa', ordm: '\u00ba', not: '\u00ac', macr: '\u00af',
  acute: '\u00b4', uml: '\u00a8', cedil: '\u00b8', sup: '\u02c7', szlig: '\u00df',
  agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6', ccedil: '\u00e7',
  egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb',
  igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  eth: '\u00f0', ntilde: '\u00f1', ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6', oslash: '\u00f8',
  ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc', yacute: '\u00fd', thorn: '\u00fe', yuml: '\u00ff',
  Agrave: '\u00c0', Aacute: '\u00c1', Auml: '\u00c4', Aring: '\u00c5', AElig: '\u00c6', Ccedil: '\u00c7',
  Egrave: '\u00c8', Eacute: '\u00c9', Euml: '\u00cb', Ntilde: '\u00d1', Ouml: '\u00d6', Oslash: '\u00d8',
  Ugrave: '\u00d9', Uacute: '\u00da', Uuml: '\u00dc',
};

/** Decode HTML entities so the model receives clean, plain text. */
export function decodeEntities(text) {
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const decoded = NAMED_ENTITIES[body];
    return decoded === undefined ? match : decoded;
  });
}

/** Escape plain text so it can be embedded safely in markup. */
export function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findTagEnd(source, start) {
  let i = start + 1;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

/**
 * Find every translatable text run in a markup string.
 *
 * @param {string} source raw chapter markup
 * @returns {{start: number, end: number, raw: string, plain: string}[]}
 */
export function extractSegments(source) {
  /** @type {{start: number, end: number, raw: string, plain: string}[]} */
  const segments = [];
  /** @type {{name: string, skip: boolean}[]} */
  const stack = [];
  let skipDepth = 0;
  let i = 0;
  const length = source.length;

  const pushText = (raw, start) => {
    if (skipDepth > 0) return;
    if (!/\p{L}/u.test(raw)) return; // nothing to translate (whitespace/punctuation/digits only)
    const plain = decodeEntities(raw);
    if (!/\p{L}/u.test(plain)) return;
    segments.push({ start, end: start + raw.length, raw, plain });
  };

  while (i < length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      pushText(source.slice(i), i);
      break;
    }
    if (lt > i) pushText(source.slice(i, lt), i);

    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      i = close === -1 ? length : close + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const close = source.indexOf(']]>', lt + 9);
      i = close === -1 ? length : close + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const close = source.indexOf('>', lt);
      i = close === -1 ? length : close + 1;
      continue;
    }

    const tagEnd = findTagEnd(source, lt);
    const tag = source.slice(lt, tagEnd);
    const match = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(tag);

    if (match) {
      const closing = match[1] === '/';
      const name = match[2].toLowerCase();
      const selfClosing = /\/\s*>$/.test(tag);

      if (closing) {
        for (let k = stack.length - 1; k >= 0; k -= 1) {
          if (stack[k].name === name) {
            for (let j = stack.length - 1; j >= k; j -= 1) {
              if (stack[j].skip) skipDepth -= 1;
            }
            stack.length = k;
            break;
          }
        }
      } else if (!selfClosing && !VOID_TAGS.has(name)) {
        if (RAW_TEXT_TAGS.has(name)) {
          // Jump straight past raw-text content (which may contain `<` etc.)
          const closeRe = new RegExp(`</\\s*${name}\\s*>`, 'i');
          const tail = source.slice(tagEnd);
          const found = closeRe.exec(tail);
          i = found ? tagEnd + found.index : length;
          continue;
        }
        const skip = SKIP_TAGS.has(name);
        stack.push({ name, skip });
        if (skip) skipDepth += 1;
      }
    }

    i = tagEnd;
  }

  return segments;
}

/**
 * Rebuild markup with translations spliced back in.
 *
 * @param {string} source original markup
 * @param {{start: number, end: number, raw: string, plain: string}[]} segments from {@link extractSegments}
 * @param {(string|null|undefined)[]} translations one entry per segment
 */
export function applySegments(source, segments, translations) {
  if (!segments || segments.length === 0) return source;
  const parts = [];
  let cursor = 0;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    parts.push(source.slice(cursor, segment.start));

    const translation = translations?.[i];
    if (translation == null || translation === '') {
      parts.push(segment.raw); // keep the original if we have no translation
    } else {
      // Preserve the original leading/trailing whitespace so inline layout
      // (e.g. `He said <em>hello</em> quietly`) is not mangled.
      const lead = /^\s*/.exec(segment.raw)[0];
      const trail = /\s*$/.exec(segment.raw)[0];
      const core = String(translation).replace(/^\s+|\s+$/g, '');
      parts.push(escapeText(lead + core + trail));
    }

    cursor = segment.end;
  }

  parts.push(source.slice(cursor));
  return parts.join('');
}

/** Total number of translatable characters across a set of segments. */
export function countCharacters(segments) {
  return segments.reduce((sum, segment) => sum + segment.plain.length, 0);
}
