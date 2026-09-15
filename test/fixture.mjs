// Builds a small, valid EPUB fixture used by the browser end-to-end test.

import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const jszipSource = readFileSync(new URL('../vendor/jszip.min.js', import.meta.url), 'utf8');
const sandbox = {};
new Function('window', 'global', 'self', jszipSource)(sandbox, sandbox, sandbox);
const JSZip = sandbox.JSZip;

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:sample-0001</dc:identifier>
    <dc:title>Le Petit Livre</dc:title>
    <dc:creator>Sample Author</dc:creator>
    <dc:language>fr</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles/main.css" media-type="text/css"/>
    <item id="img" href="images/pic.png" media-type="image/png"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="chapter1.xhtml">Le Premier Chapitre</a></li>
      <li><a href="chapter2.xhtml">Le Deuxi\u00e8me Chapitre</a></li>
    </ol>
  </nav>
</body>
</html>`;

const CSS = `body { font-family: serif; }
p { text-indent: 1.2em; }
.cover { background-image: url("../images/pic.png"); }
`;

const chapter = (n, title) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>${title}</title>
  <link rel="stylesheet" type="text/css" href="styles/main.css"/>
</head>
<body>
  <section>
    <h1>${title}</h1>
    <p>Il \u00e9tait une fois &nbsp;un petit livre que l'on voulait traduire &amp; partager.</p>
    <p>Ceci est le <em>chapitre</em> num\u00e9ro ${n} de notre histoire.</p>
    <figure class="cover"><img src="images/pic.png" alt="illustration"/></figure>
  </section>
</body>
</html>`;

export async function buildFixture() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  zip.file('OEBPS/content.opf', OPF);
  zip.file('OEBPS/nav.xhtml', NAV);
  zip.file('OEBPS/styles/main.css', CSS);
  zip.file('OEBPS/images/pic.png', PNG, { binary: true });
  zip.file('OEBPS/chapter1.xhtml', chapter(1, 'Le Premier Chapitre'));
  zip.file('OEBPS/chapter2.xhtml', chapter(2, 'Le Deuxi\u00e8me Chapitre'));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function writeFixture(path) {
  const buffer = await buildFixture();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = fileURLToPath(new URL('./fixtures/sample.epub', import.meta.url));
  await writeFixture(out);
  console.log(`wrote ${out}`);
}
