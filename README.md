# EPUB Translator

Upload an EPUB, read it right in the browser, translate it to **any** language with the
**DeepSeek** API, and download the translated book as a new `.epub`.

Everything runs client-side. There is no backend, no build step and no npm
dependencies — just static files plus a tiny static server for local development.

## Security

> ⚠ **Treat every EPUB as untrusted content.** An EPUB can contain active markup.
> Only paste a DeepSeek API key into a copy of this app you trust, and prefer a
> restricted, rotated key.

A security audit (`epub-security-audit.md`) reviewed this project and reported
the issues below. All of them have been addressed:

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | High | A malicious EPUB could execute JavaScript in the app's origin and read the DeepSeek API-key input — via event-handler attributes, nested `srcdoc` iframes, embedded HTML served as same-origin blob URLs, and `javascript:` links. | **Fixed.** Chapters now render inside a sandboxed `<iframe>` with **scripts disabled**, and the markup is passed through an allowlist sanitizer (`src/sanitize.js`). Event handlers, `iframe`/`object`/`embed`/`srcdoc`, executable URL schemes and external resources are all removed, and each book document carries a restrictive CSP. |
| 2 | High | The local static server served any file under the repository root (`.git/`, the local `memories.db`, …) and listened on all interfaces. | **Fixed.** The server binds to `127.0.0.1` by default and serves only an explicit allowlist of public assets, resolving real paths so symlinks cannot escape. The GitHub Pages artifact is assembled from the same allowlist. |
| 3 | Medium | Archive expansion was unbounded, so a crafted EPUB could exhaust the browser tab. | **Mitigated.** Input size, entry count, per-entry expanded size and cumulative expanded bytes are all bounded (`ARCHIVE_LIMITS` in `src/epub.js`). |

Remaining caveats worth knowing:

- The reader sandbox disables **scripts** but keeps `allow-same-origin` so the app
  can drive in-book navigation and scroll position. With scripts disabled, book
  content still cannot run code or read the API key. See `src/reader.js`.
- Decompression limits check the zip's declared sizes first and the real byte
  count while reading. This bounds abuse but is deliberately not a worker-based
  hard kill-switch, and it caps very large (mostly image-heavy) books.
- Please report security problems privately rather than in a public issue tracker.

```
┌───────────────────────────┬───────────────────────────────────────────┐
│  1 · Book                 │  Original │ Translated      ‹  TOC  ›  A− A+ │
│  [ drop / browse EPUB ]   │ ┌───────────────────────────────────────┐ │
│                           │ │                                       │ │
│  2 · DeepSeek             │ │   Chapter rendered in a sandboxed      │ │
│  API key  [sk-…]  Show    │ │   frame without scripts, styled by     │ │
│  Model    [deepseek-chat] │ │   the book, images inlined.            │ │
│                           │ │                                       │ │
│  3 · Languages            │ │                                       │ │
│  From [Auto] → To [English]│ │                                       │ │
│  [ Translate ]            │ └───────────────────────────────────────┘ │
│  4 · Export  [ Download ] │                                           │
└───────────────────────────┴───────────────────────────────────────────┘
```

## Features

- **In-browser EPUB reader** — parses the container, OPF manifest, spine and the
  EPUB&nbsp;3 nav / EPUB&nbsp;2 NCX table of contents. Chapters render inside a
  sandboxed iframe with scripts disabled and are sanitised, and images, fonts
  and CSS `url(...)` references are rewritten to same-origin blob URLs so they just work.
- **Left control panel** — paste your DeepSeek API key, choose a model, pick
  **From → To** languages (source defaults to *Auto-detect*), and choose whether to
  translate the **whole book** or just the **current section**.
- **Faithful translation** — chapter markup is scanned (not DOM-reserialized) so
  entities, comments, namespaces and every untouched byte of the original file are
  preserved. Only text runs are replaced, then re-escaped.
- **Efficient + resilient** — identical strings are de-duplicated across the whole
  book, segments are batched, requests run with limited concurrency, and the client
  retries with exponential backoff. A mismatched model reply is split and retried so
  a paragraph is never lost.
- **Live progress + cancel** — a progress bar, a running activity log, and a cancel
  button (via `AbortController`).
- **Token & cost meters** — a pre-flight estimate for the whole book (segments ·
  tokens · API requests), then the *actual* prompt/completion totals reported by the
  API, plus an estimated USD cost using DeepSeek's published peak/off-peak and
  cache-hit rates.
- **Export a translated EPUB** — repackages the original zip, swapping only the
  translated chapters, keeps `mimetype` first & uncompressed per the OCF spec, and
  updates `<dc:language>` to the target language.
- **Reader niceties** — original/translated toggle, chapter navigation, TOC
  dropdown, font size, light/dark theme, RTL support, and internal-link handling.

## Quick start

```bash
npm start           # serves http://127.0.0.1:3000 (set HOST=0.0.0.0 to share)
```

No install step is required (there are no dependencies). Then:

1. Open <http://127.0.0.1:3000>.
2. Drop an `.epub` onto the drop zone.
3. Paste your DeepSeek API key (get one at <https://platform.deepseek.com>).
4. Pick **From** and **To** languages and press **Translate**.
5. Read the result with the *Translated* toggle, then **Download translated EPUB**.

You can also serve the folder with any static server, e.g.
`python3 -m http.server 3000`.

## Deploy to GitHub Pages

The app is a static site — plain HTML, CSS and ES modules with **no build step**.
The workflow copies only the public assets (`index.html`, `src/`, `styles/`,
`vendor/`, plus `epub-security-audit.md` for reference) into the Pages artifact,
so working files such as `server.js` and the tests are not published. All asset
references are **relative** (`styles/main.css`, `src/main.js`, `./epub.js`, …), so
it works unchanged under a project subpath such as `https://<user>.github.io/<repo>/`.

A workflow is included at `.github/workflows/pages.yml`. To turn on publishing:

1. Push this repository to GitHub.
2. In **Settings → Pages → Build and deployment**, set **Source** to
   **GitHub Actions**.
3. Push to `main` (or run the *Deploy to GitHub Pages* workflow manually). The
   site goes live at `https://<user>.github.io/<repo>/`.

Notes:

- A `.nojekyll` file is included so GitHub serves the files verbatim instead of
  running them through Jekyll.
- Pages serves over **HTTPS**, and the DeepSeek API is called directly from the
  browser over HTTPS with permissive CORS — no proxy is needed. You provide your
  own API key at runtime; nothing is stored on the server.
- `server.js` is only a convenience for local development and is not needed on
  Pages.

## How it works

| File | Responsibility |
| --- | --- |
| `index.html` | App shell: control panel + reader toolbar. |
| `styles/main.css` | App chrome, themes and layout. |
| `src/main.js` | Wiring: file loading, translation pipeline, export, UI state. |
| `src/epub.js` | EPUB parsing (container/OPF/spine/TOC) and re-packaging. |
| `src/epub-text.js` | Markup scanner that segments translatable text and splices translations back. |
| `src/deepseek.js` | DeepSeek chat-completions client: batching, JSON mode, retries. |
| `src/reader.js` | Sandboxed-iframe chapter renderer with resource/CSS rewriting. |
| `src/sanitize.js` | Allowlist sanitizer for untrusted EPUB markup. |
| `src/languages.js` | Language catalog + normalization helpers. |
| `src/tokens.js` | Token estimation, peak/off-peak pricing and cost maths. |
| `vendor/jszip.min.js` | Vendored JSZip (read/write zip in the browser). |
| `server.js` | Zero-dependency static file server for local use. |

### Translation pipeline

1. Extract translatable text runs from every selected chapter (skipping
   `<head>`, `<script>`, `<style>`, comments and CDATA).
2. De-duplicate identical strings, then batch by characters-per-request.
3. Send each batch to DeepSeek with JSON mode, asking for
   `{"translations": [...]}` with one entry per input.
4. Splice the results back into the original markup, keeping unreplaced bytes
   intact and HTML-escaping the translated text.
5. Store the new chapter content and stamp the target language into the OPF.

## What the translation preserves

Because we splice translations into the *original* markup (rather than rebuilding
the document from a DOM), formatting survives very well:

- **Block structure** — paragraphs, headings, lists, tables, blockquotes, sections
  and their nesting are untouched. Only the text inside them changes.
- **Inline markup** — `<em>`, `<strong>`, `<a>`, `<span>`, footnotes, etc. remain,
  and the text runs around them are translated independently.
- **Styling** — every stylesheet is passed through unchanged, so indents, drop caps,
  alignment and fonts still apply in the reader and in the exported book.
- **Entities & encoding** — HTML entities are decoded before sending and re-escaped
  on the way back, so `&nbsp;` / `&amp;` never leak into the output.
- **Everything else stays byte-identical** — images, fonts, the OPF, the NCX/nav,
  the cover, and any markup we did not translate are copied across verbatim.

Known limitations worth knowing:

- **Split sentences.** If one sentence is fragmented across inline tags (e.g.
  `He <em>really</em> liked it`), each fragment is translated *on its own*, since the
  model only sees the text runs. Grammar can suffer in those cases.
- **Attributes are not translated** (`alt`, `title`, `aria-label`), and neither is
  `<head>`/metadata (including `<title>`), by design.
- **`<pre>`/`<code>` are translated too**, as they are ordinary text nodes. In
  technical books that means code samples get translated — use *Current section only*
  to limit the blast radius on chapters you care about.

## Notes on the DeepSeek API

- The browser calls `https://api.deepseek.com/chat/completions` directly. DeepSeek
  sends permissive CORS headers, so no proxy is needed.
- **Your key never leaves the browser**: it is only sent to DeepSeek. It is *not*
  persisted unless you tick *Remember key on this device* (then it goes into
  `localStorage`).
- **Models** are the current API ids: `deepseek-flash` (DeepSeek-V4.1-Flash, the
  default) and `deepseek-v4-pro`. The retired `deepseek-chat` / `deepseek-reasoner`
  names are no longer offered.
- **Thinking is explicitly disabled** for translation — `thinking: {"type":"disabled"}`.
  Chain-of-thought costs extra output tokens and latency for no quality gain on a
  single-shot transformation, and it would otherwise make `temperature` a no-op. With
  thinking off, temperature `1.3` (DeepSeek's translation recommendation) applies.
- **JSON output** (`response_format: {"type":"json_object"}`) is used for every
  request, together with the required literal "json" instruction in the prompt.

## Testing

```bash
npm test            # 28 headless checks: segmentation, entities, tokens/cost, API contract, repackaging
npm run test:e2e    # drives real headless Chrome through the whole flow (42 checks, incl. security)
python -m pytest test   # the Node suite via the portable harness
```

- `test/smoke.mjs` — pure logic: HTML entity handling, the text scanner, path
  resolution, JSON reply parsing, and a real EPUB round-trip that asserts
  `mimetype` is the first entry and stored uncompressed.
- `test/e2e.mjs` — boots `server.js` and headless Chrome over the DevTools
  Protocol, loads a generated fixture EPUB through the real file input, translates
  it against a **stubbed** DeepSeek endpoint, and inspects the exported zip. It is
  skipped automatically if no Chrome/Chromium is found (set `CHROME_PATH` to point
  at one).

## Limitations

- Very large books produce many API calls and cost tokens; use *Current section
  only* to translate incrementally.
- Archives are bounded (see `ARCHIVE_LIMITS`); extremely large image-heavy books
  may be refused.
- Book scripts, external resources and popups are disabled by the sandbox; a
  chapter that depends on JavaScript to lay itself out will not run that script.
- Text inside images (covers, plates) is not OCR'd.
- Page-break/`page-progression` RTL heuristics are basic.
- The exported EPUB is repackaged with JSZip; most readers accept it, but a strict
  validator may flag minor header differences.

## License

MIT.
