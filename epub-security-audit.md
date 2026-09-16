# EPUB Translator security audit

Date: 2026-09-15
Revision: 5744dcb
Scope: tracked application code, local HTTP server, Pages workflow, vendored JSZip, and existing tests. No application code changed.

## Summary

Two high-severity vulnerabilities were reproduced. A medium-severity resource exhaustion risk was identified, with bounded decompression verified. The most urgent issue is execution of attacker-controlled EPUB content in the application's origin, where it can read the DeepSeek API-key input.

## 1. High: EPUB content executes JavaScript with access to the API key

Locations: src/reader.js:209–224; src/reader.js:47; src/reader.js:84–89; src/reader.js:164–176; src/epub.js:289–295.

The renderer parses untrusted chapter HTML, removes script elements, and imports the remaining body nodes into its shadow root. Event-handler attributes remain executable. Nested iframe srcdoc documents are not sanitized. Embedded HTML resources become same-origin blob URLs and can execute in unsandboxed frames. The link handler also explicitly passes javascript: URLs through.

An EPUB supplier only needs to convince the user to open the file or navigate to its malicious chapter. The first chapter renders automatically. Shadow DOM provides style encapsulation, not an origin boundary. Remember-key being unchecked does not prevent access to the live input; a payload can also watch for a key entered later.

### Reproduction evidence

A temporary, fresh headless Chrome profile loaded this app. Generated EPUB archives were opened through EpubBook.open and rendered through Reader.render. The API-key input contained only a dummy value. Each probe copied that value to a temporary window property; no credential was sent anywhere.

| Payload | Result |
| --- | --- |
| Image with invalid data URL and onerror handler | Read parent API-key input automatically |
| iframe with script inside srcdoc | Read parent API-key input automatically |
| iframe loading embedded payload.html via generated blob URL | Read parent API-key input automatically |
| Anchor with javascript: URL | Read parent API-key input on click |

Minimal inert demonstration of the first route, as chapter body content:

```html
<img src="data:image/png;base64,AA=="
     onerror="window.auditProof=document.getElementById('api-key').value">
```

Impact: theft of current or subsequently entered API keys, access to origin storage, page tampering, and API requests using the victim's credentials. Computer or operating-system takeover was not demonstrated.

Remediation: render books behind an opaque-origin sandboxed iframe with scripts disabled and no same-origin permission. Sanitize untrusted markup with a maintained allowlist sanitizer; reject event attributes, executable URL schemes, srcdoc, and active embedded documents. Use a restrictive content security policy for book documents, including network/resource restrictions. Verify all four payload routes and ordinary EPUB navigation, images, and styling after implementation. Removing only event attributes leaves the iframe routes open.

Reference: [MDN DOMParser security considerations](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString) explains that inert parsed HTML can activate event handlers when inserted into the visible document.

## 2. High: local server exposes private project files

Locations: server.js:45–60 and server.js:73.

The static server permits any regular file beneath the repository root, including hidden and gitignored files. It binds to all interfaces. Files are reachable without authentication by clients that can connect to the port, subject to the machine's firewall/network configuration.

### Reproduction evidence

A temporary instance of the unchanged server returned:

| Request | Status | Response bytes |
| --- | --- | ---: |
| GET /.git/HEAD | 200 | 21 |
| GET /.git/config | 200 | 304 |
| GET /memories.db | 200 | 2,957,312 |
| GET /%2e%2e%2fpackage.json | 403 | 9 |

Only status codes and response sizes were recorded. Database contents and Git configuration were not printed or inspected. The database is explicitly described in .gitignore as a local agent memory store, not an application asset. Gitignore has no effect on HTTP serving.

Impact: disclosure of the memory database and repository metadata; other sensitive files placed in the served tree would also be exposed. This finding applies to npm start, not proof that GitHub Pages exposes the ignored database. GitHub checkout does not include this untracked database.

Remediation: bind to 127.0.0.1 by default and serve only explicitly approved static assets, preferably from a dedicated public directory. Resolve real paths before enforcing containment to prevent symlink escapes. Keep private working files and Git metadata outside the served directory. Apply the same explicit asset selection to the Pages artifact.

## 3. Medium: unbounded archive expansion can exhaust the browser tab

Locations: src/epub.js:121–125, src/epub.js:257–261, src/epub.js:293, src/epub.js:335; src/main.js:297–301 and src/main.js:545.

No compressed input size, entry count, per-entry expanded size, or cumulative expanded-byte limit is enforced. Text and blob reads fully decompress entries into memory. Opening a book automatically starts scanning every chapter to estimate tokens, so malicious large chapters need not be individually visited or translated. Export also decompresses untouched entries.

### Reproduction evidence and limits

A bounded ZIP containing 8,388,608 repeated characters compressed to 8,280 bytes and expanded successfully through EpubBook.readText. This verifies approximately 1,013-fold amplification with no application limit. The test deliberately did not crash the browser. A tab freeze or memory-exhaustion failure with a larger crafted book is inferred from the unbounded decompression and caching paths, not a demonstrated crash.

Remediation: enforce compressed-size and entry-count limits before processing; enforce per-entry and cumulative actual decompressed-byte budgets while inflating. Header sizes alone must not be trusted. Perform decompression and scanning in a worker that can be terminated, and support cancellation of background estimation.

## Additional observations

- External image/resource URLs and CSS URLs/imports are not consistently blocked. A book can trigger third-party requests when rendered, creating a reading-tracking/privacy risk. Include network restrictions in the reader redesign. This was assessed from code, not tested against an external endpoint.
- There are no declared npm dependencies, but vendor/jszip.min.js identifies JSZip 3.10.1. Its known historical path traversal and prototype-pollution fixes predate this version, per the [upstream changelog](https://github.com/Stuk/jszip/blob/main/CHANGES.md). Those historical bugs are not findings against this copy. This is not an exhaustive independent audit of the minified bundle or its bundled components.
- A pattern scan of all 21 tracked files found no private-key blocks, GitHub tokens, AWS access-key IDs, or long sk- API-key literals. It did not scan Git history or inspect the private database.
- Translation text is escaped before reinsertion; book metadata and activity messages use textContent in the relevant paths.

## Validation

- npm test: 28 checks passed.
- npm run test:e2e: 31/31 browser checks passed; API calls were stubbed by the existing suite.
- Four targeted EPUB script-execution probes: all reproduced access to a dummy API-key input.
- Three private-file HTTP probes: all returned 200.
- Encoded parent-directory traversal control: returned 403.
- Bounded archive expansion: 8,280 bytes to 8,388,608 bytes accepted.
- Git working tree remained clean after testing. Temporary test server and Chrome processes were stopped.

Passing functional tests do not address the reproduced security flaws. No fixes, deployment changes, or key rotations were performed.
