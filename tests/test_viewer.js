// Runs the real viewer.js inside jsdom against each sample file, with fetch mocked
// to serve the file from disk. Verifies each renderer produces the expected DOM.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ASSETS = path.join(__dirname, 'uploadserver_preview', 'assets');
const SAMPLES = '/tmp/serve_test';

// Load order mirrors the page's <script defer> sequence (viewer.js runs last).
const LIBS = [
  'hljs.min.js', 'hljs-dockerfile.min.js', 'marked.umd.js', 'purify.min.js',
  'papaparse.min.js', 'diff2html.core.min.js', 'json-viewer.js',
];

const SHELL = `<!DOCTYPE html><html data-theme="dark"><head></head><body>
<header class="topbar">
  <a class="back" id="backlink" href="/"></a>
  <nav class="crumbs" id="crumbs"></nav>
  <span class="spacer"></span>
  <span class="badge" id="kind"></span>
  <span class="meta" id="meta"></span>
  <a class="raw" id="rawlink" href="#"></a>
</header>
<main id="content" class="content"><div class="loading">Loading</div></main>
</body></html>`;

const CASES = [
  { file: 'README.md',     expect: (h) => /markdown-body/.test(h) && /<h1/.test(h) && /class="hljs/.test(h), label: 'markdown + fenced code highlight' },
  { file: 'config.json',   expect: (h) => /andypf-json-viewer/.test(h) || /class="hljs/.test(h),            label: 'json (web component or fallback)' },
  { file: 'settings.yaml', expect: (h) => /codewrap/.test(h) && /class="hljs/.test(h),                       label: 'yaml as highlighted code' },
  { file: 'people.csv',    expect: (h) => /table class="data"/.test(h) && /<thead/.test(h) && /Ada/.test(h),  label: 'csv as table' },
  { file: 'change.diff',   expect: (h) => /d2h-/.test(h),                                                     label: 'unified diff' },
  { file: 'app.py',        expect: (h) => /codewrap/.test(h) && /class="gutter"/.test(h) && /class="hljs/.test(h), label: 'python code + line numbers' },
  { file: 'server.log',    expect: (h) => /codewrap/.test(h),                                                 label: 'plain log' },
  { file: 'diagram.md',    expect: (h) => /markdown-body/.test(h) && /mermaid-diagram/.test(h) && /mmd-stub/.test(h) && !/language-mermaid/.test(h) && /class="hljs/.test(h), label: 'markdown mermaid diagram (stubbed)' },
];

function runCase(tc) {
  return new Promise((resolve) => {
    const url = 'http://x/__view__?path=' + encodeURIComponent('/' + tc.file);
    const vc = new VirtualConsole(); // swallow noisy library logs
    const dom = new JSDOM(SHELL, { url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
    const { window } = dom;

    // matchMedia shim
    window.matchMedia = window.matchMedia || function () { return { matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; };

    // fetch shim -> serve the sample file
    window.fetch = function (p) {
      let rel = decodeURIComponent(String(p).split('?')[0]).replace(/^\//, '');
      const fp = path.join(SAMPLES, rel);
      return Promise.resolve().then(() => {
        const buf = fs.readFileSync(fp);
        return {
          ok: true, status: 200, statusText: 'OK',
          headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : null) },
          text: () => Promise.resolve(buf.toString('utf8')),
        };
      });
    };

    // Stub mermaid so the diagram renderer runs without the 3.5 MB bundle (and
    // without needing SVG layout, which jsdom lacks). Inert for non-mermaid files.
    window.mermaid = {
      initialize() {},
      render(id) { return Promise.resolve({ svg: '<svg class="mmd-stub"><text>' + id + '</text></svg>' }); },
    };

    const runIn = (code, name) => {
      const s = window.document.createElement('script');
      s.textContent = code;
      window.document.body.appendChild(s);
    };

    try {
      for (const lib of LIBS) runIn(fs.readFileSync(path.join(ASSETS, lib), 'utf8'), lib);
      runIn(fs.readFileSync(path.join(ASSETS, 'viewer.js'), 'utf8'), 'viewer.js');
    } catch (e) {
      return resolve({ file: tc.file, ok: false, err: 'script load: ' + e.message });
    }

    // allow the fetch microtasks + render to settle
    setTimeout(() => {
      const html = window.document.getElementById('content').innerHTML;
      const badge = window.document.getElementById('kind').textContent;
      const meta = window.document.getElementById('meta').textContent;
      let ok = false, err = null;
      try { ok = tc.expect(html); } catch (e) { err = e.message; }
      resolve({ file: tc.file, label: tc.label, ok, err, badge, meta, len: html.length,
                snippet: html.replace(/\s+/g, ' ').slice(0, 90) });
    }, 300);
  });
}

(async () => {
  let pass = 0;
  for (const tc of CASES) {
    const r = await runCase(tc);
    const status = r.ok ? 'PASS' : 'FAIL';
    if (r.ok) pass++;
    console.log(`[${status}] ${r.file.padEnd(15)} ${r.label || ''}`);
    console.log(`         badge="${r.badge}" meta="${r.meta}" ${r.err ? 'ERR=' + r.err : ''}`);
    if (!r.ok) console.log(`         snippet: ${r.snippet}`);
  }
  console.log(`\n${pass}/${CASES.length} renderers passed`);
  process.exit(pass === CASES.length ? 0 : 1);
})();
