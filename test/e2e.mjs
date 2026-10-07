// End-to-end test: loads the real extension into Playwright's Chromium and checks it on a
// local fixture page (same-origin, cross-origin and SVG images), on a second one with
// canvases and a video (including the right-click choices), on pages with picture cards and
// embedded frames, then again next to Dark Reader.
// `--live` adds LeetCode problem 973. `--shots` writes the README images.
//
//   node test/e2e.mjs [--live] [--shots] [--headed] [--only images,canvas,cards,frames,charts,shadow,pictures,boxes,darkreader]
//
// Runs headless by default (no windows, no focus stealing). A normal Chrome user agent
// gets LeetCode past Cloudflare's headless check.
//
// Needs test/real-images.mjs to have run once (it downloads the images) and, for the
// Dark Reader part, its MV3 build unpacked in test/.cache/darkreader.
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { root, EXT, DR, launch, settings, flashes, waitFor } from './lib.mjs';

const IMAGES = path.join(root, 'test/.cache/images');
const SHOTS = path.join(root, 'docs/images');
const argv = new Set(process.argv.slice(2));
// --only frames,cards runs just those parts: images, canvas, cards, frames, charts, shadow, pictures, boxes, darkreader.
const onlyArg = process.argv.slice(2).find((a, i, all) => all[i - 1] === '--only');
const part = (name) => !onlyArg || onlyArg.split(',').includes(name);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------------ fixture servers

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
<rect width="300" height="200" fill="#fff"/><path d="M20 180H280M20 180V20" stroke="#000" stroke-width="2"/>
<polyline points="20,160 80,100 140,130 200,60 280,40" stroke="#000" stroke-width="3" fill="none"/>
<circle cx="200" cy="60" r="5" fill="none" stroke="#000" stroke-width="2"/></svg>`;

function fixture(theme, other) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  h1{font-size:20px;margin:0 0 4px} p{margin:0 0 18px;opacity:.7}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px 18px;max-width:1240px}
  figure{margin:0} figcaption{font-size:12.5px;opacity:.7;margin-top:6px}
  img{display:block;width:100%;height:170px;object-fit:contain}
  </style></head><body class="${theme}">
  <h1>Inkflip test page</h1><p>Same-origin, cross-origin and SVG images on a ${theme} background.</p>
  <div class="grid">
  <figure><img id="same-diagram" src="/lc_closestplane.jpg"><figcaption>Diagram (JPEG, same origin)</figcaption></figure>
  <figure><img id="x-diagram" src="${other}/lc_tree.jpg"><figcaption>Diagram (cross-origin)</figcaption></figure>
  <figure><img id="x-svg" src="${other}/diagram.svg"><figcaption>Diagram (SVG, cross-origin)</figcaption></figure>
  <figure><img id="chart" src="/mpl_simpleplot.png"><figcaption>matplotlib chart</figcaption></figure>
  <figure><img id="logo" src="/logo_github.png"><figcaption>Black logo, transparent PNG</figcaption></figure>
  <figure><img id="product" src="${other}/prod_nikon.jpg"><figcaption>Product photo on white</figcaption></figure>
  <figure><img id="list" src="/lc_merge.jpg"><figcaption>Coloured diagram</figcaption></figure>
  <figure><img id="photo" src="/photo_b.jpg"><figcaption>Ordinary photo</figcaption></figure>
  </div>
  <p style="margin-top:18px">Avatar-sized photo on white: <img id="avatar" src="${other}/prod_fly.jpg" style="display:inline-block;width:32px;height:32px;vertical-align:middle;object-fit:cover"></p>
  <h1 style="margin-top:28px">Panel painted by a sibling layer</h1>
  <div style="position:relative;width:420px;padding:16px">
    <div style="position:absolute;inset:0;background:#2a2d31;border-radius:10px"></div>
    <div style="position:relative"><img id="layered" src="/lc_tree.jpg" style="height:150px"></div>
  </div>
  <div style="height:2600px"></div>
  <img id="far" src="/wm_crossproduct.gif" style="width:400px">
  <script>window.setTheme = (t) => { document.body.className = t; };</script>
  </body></html>`;
}

// Canvases painted in every way the content script has to cope with, plus a video, and
// transparent overlays of the kind that hide them from Chrome's own right-click menu.
function canvasFixture(theme, other) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip canvas fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  h1{font-size:20px;margin:0 0 4px} p{margin:0 0 18px;opacity:.7}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:22px 18px;max-width:1240px}
  figure{margin:0;position:relative} figcaption{font-size:12.5px;opacity:.7;margin-top:6px}
  canvas,video,img{display:block;width:100%;height:170px;object-fit:contain}
  .overlay{position:absolute;left:0;right:0;top:0;height:170px}
  </style></head><body class="${theme}">
  <h1 id="title">Inkflip canvas and video test page</h1><p>Canvases painted in different ways, and a video, on a ${theme} background.</p>
  <div class="grid">
  <figure><canvas id="cv-chart" width="600" height="340"></canvas><figcaption>Chart on a white canvas</figcaption></figure>
  <figure><canvas id="cv-ink" width="600" height="340"></canvas><figcaption>Black ink, transparent canvas</figcaption></figure>
  <figure><canvas id="cv-photo" width="600" height="340"></canvas><figcaption>Photo drawn into a canvas</figcaption></figure>
  <figure><canvas id="cv-late" width="600" height="340"></canvas><figcaption>Painted after 1.2 s</figcaption></figure>
  <figure><canvas id="cv-tainted" width="600" height="340"></canvas><figcaption>Cross-origin image drawn in</figcaption></figure>
  <figure><canvas id="cv-webgl" width="600" height="340"></canvas><figcaption>WebGL, cleared to white</figcaption></figure>
  <figure><canvas id="cv-covered" width="600" height="340"></canvas><div class="overlay" id="cv-overlay"></div><figcaption>Chart under a transparent layer</figcaption></figure>
  <figure><img id="img-covered" src="/lc_tree.jpg"><div class="overlay"></div><figcaption>Image under a transparent layer</figcaption></figure>
  <figure><img id="img-plain" src="/lc_closestplane.jpg"><figcaption>Plain image</figcaption></figure>
  <figure><video id="vid" muted autoplay playsinline></video><div class="overlay" style="height:50px"></div><figcaption>Video of a white slide; a transparent strip on top</figcaption></figure>
  </div>
  <script>
  function chart(id, white) {
    const c = document.getElementById(id), g = c.getContext('2d');
    if (white) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    g.strokeStyle = '#000'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(40, 300); g.lineTo(570, 300); g.moveTo(40, 300); g.lineTo(40, 30); g.stroke();
    g.beginPath();
    [[40, 260], [140, 180], [240, 220], [340, 110], [440, 140], [560, 60]].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
    g.fillStyle = '#000'; g.font = 'bold 30px sans-serif'; g.fillText('Throughput', 70, 56);
    c.dataset.painted = '';
  }
  chart('cv-chart', true); chart('cv-ink', false); chart('cv-covered', true);
  setTimeout(() => chart('cv-late', true), 1200);
  const photo = new Image();
  photo.onload = () => {
    const c = document.getElementById('cv-photo');
    c.getContext('2d').drawImage(photo, 0, 0, c.width, c.height);
    c.dataset.painted = '';
  };
  photo.src = '/photo_b.jpg';
  const foreign = new Image(); // no CORS: drawing it taints the canvas
  foreign.onload = () => {
    const c = document.getElementById('cv-tainted'), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(foreign, 0, 0, c.width, c.height);
  };
  foreign.src = '${other}/lc_tree.jpg';
  const gl = document.getElementById('cv-webgl').getContext('webgl');
  gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  // The video plays a white "slide" drawn on a canvas that is never added to the page.
  const slides = document.createElement('canvas'); slides.width = 640; slides.height = 360;
  const sg = slides.getContext('2d');
  (function slide() {
    sg.fillStyle = '#fff'; sg.fillRect(0, 0, 640, 360);
    sg.fillStyle = '#000'; sg.font = 'bold 44px sans-serif'; sg.fillText('Quarterly review', 40, 90);
    sg.fillRect(40, 130, 420, 10); sg.fillRect(40, 170, 300, 10);
    requestAnimationFrame(slide);
  })();
  const vid = document.getElementById('vid');
  vid.srcObject = slides.captureStream(30);
  vid.play().catch(() => {});
  window.setTheme = (t) => { document.body.className = t; };
  </script>
  </body></html>`;
}

// Picture cards on a dark site: light panels that hold nothing but pictures (dimmed whole),
// and light panels that must stay as they are.
function cardFixture(theme) {
  const dot = '<span style="width:10px;height:10px;border-radius:50%;background:#c8c8c8"></span>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip card fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#0a0a0a;color:#e8e6e3} body.light{background:#fff;color:#222}
  h1{font-size:20px;margin:0 0 4px} p{margin:0 0 18px;opacity:.7}
  .row{display:flex;flex-wrap:wrap;gap:24px;max-width:1240px;margin-bottom:24px}
  .panel{display:block;position:relative;width:380px;height:260px;border-radius:16px;overflow:hidden;margin:0}
  .duo{display:flex;align-items:center;justify-content:center;gap:5%}
  .duo img{width:41%;height:70%;object-fit:cover;border-radius:10px}
  </style></head><body class="${theme}">
  <h1>Inkflip card test page</h1><p>Light panels holding pictures, on a ${theme} page.</p>
  <div class="row">
    <a class="panel" id="card-shot" style="background:#e3e7ff" aria-hidden="true">
      <img id="shot" src="/lc_closestplane.jpg" style="position:absolute;top:12%;left:7%;width:113%;height:auto"></a>
    <a class="panel" id="card-window" style="background:#ea5454" aria-hidden="true">
      <div id="window" style="position:absolute;top:12%;left:50%;width:62%;transform:translateX(-50%);background:#fff;border-radius:10px 10px 0 0;overflow:hidden">
        <div style="display:flex;gap:7px;padding:12px 14px">${dot}${dot}${dot}</div>
        <img id="window-img" src="/mpl_simpleplot.png" style="display:block;width:100%;height:auto"></div></a>
    <div class="panel duo" id="card-pair" style="background:linear-gradient(#dcebe1,#e8f2ec)">
      <img id="pair-a" src="/photo_b.jpg"><img id="pair-b" src="/lc_tree.jpg"></div>
  </div>
  <div class="row">
    <figure class="panel" id="reading" style="background:#fff;color:#222;height:auto;padding:12px">
      <img id="reading-img" src="/lc_tree.jpg" style="display:block;width:100%;height:200px;object-fit:contain">
      <figcaption>Figure 1. A binary tree.</figcaption></figure>
    <div class="panel" id="sparse" style="background:#f4f4f5">
      <img id="sparse-img" src="/lc_word.jpg" style="display:block;width:120px;height:90px;margin:20px"></div>
    <div class="panel" id="covered" style="background:#fff">
      <img id="covered-img" src="/photo_a.jpg" style="display:block;width:100%;height:100%;object-fit:cover"></div>
    <div class="panel" id="editor" style="background:#fff">
      <img id="editor-img" src="/lc_merge.jpg" style="display:block;width:100%;height:150px;object-fit:cover">
      <textarea placeholder="Write something" style="border:0;width:90%;margin:10px"></textarea></div>
    <div class="panel" id="teal" style="background:#0f4f4c">
      <img id="teal-img" src="/lc_closestplane.jpg" style="display:block;width:80%;margin:10%"></div>
  </div>
  <script>window.setTheme = (t) => { document.body.className = t; };</script>
  </body></html>`;
}

// Embedded pages, the kind Dark Reader leaves white on a site that is dark by itself: a white
// document, a transparent one in a white iframe (react.dev's live previews), a transparent one
// that the browser backs with white because the colour schemes differ, and ones to leave alone.
function frameFixture(theme, other) {
  const fr = (id, doc, style = '') => `<iframe id="${id}" src="${other}/doc/${doc}" style="${style}"></iframe>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip frame fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  h1{font-size:20px;margin:0 0 18px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px 18px;max-width:1240px}
  iframe{display:block;width:100%;height:240px;border:0;border-radius:8px}
  </style></head><body class="${theme}">
  <h1>Inkflip frame test page</h1>
  <div class="grid">
  ${fr('fr-white', 'white')}
  ${fr('fr-sandpack', 'transparent', 'background:#fff;box-shadow:0 2px 8px #0006')}
  ${fr('fr-scheme', 'transparent', 'color-scheme:dark')}
  ${fr('fr-dark', 'dark')}
  ${fr('fr-clear', 'transparent')}
  ${fr('fr-svg', 'svg-white')}
  <object id="ob-svg" type="image/svg+xml" data="${other}/doc/svg-white" style="display:block;width:100%;height:240px"></object>
  <object id="ob-svg-clear" type="image/svg+xml" data="${other}/doc/svg-clear" style="display:block;width:100%;height:240px"></object>
  <iframe id="fr-srcdoc" srcdoc="<body style='background:#fff;font:14px system-ui'><p>A srcdoc preview</p><button>Button</button></body>"></iframe>
  <iframe id="fr-blank"></iframe>
  </div>
  <p>A tiny white frame: ${fr('fr-tiny', 'white', 'display:inline-block;width:40px;height:30px')}</p>
  <script>window.setTheme = (t) => { document.body.className = t; };
  const blank = document.getElementById('fr-blank').contentDocument;
  blank.open(); blank.write("<body style='background:#fff;font:14px system-ui'><p>Written into about:blank by script</p></body>"); blank.close();</script>
  </body></html>`;
}

const svgDoc = (white) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240">${white ? '<rect width="400" height="240" fill="#fff"/>' : ''}
  <path d="M30 210H370M30 210V30" stroke="#000" stroke-width="2"/><polyline points="30,190 110,120 190,150 270,70 370,50" stroke="#000" stroke-width="3" fill="none"/>
  <text x="200" y="232" font-size="14" text-anchor="middle">An SVG file</text></svg>`;

const frameDoc = (kind) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:16px;font:14px/1.4 system-ui,sans-serif}
  img{display:inline-block;width:45%;height:120px;object-fit:contain;vertical-align:top}
  </style></head><body style="${{ white: 'background:#fff;color:#111', dark: 'background:#202124;color:#e8eaed', transparent: '' }[kind]}">
  <p>An embedded page (${kind}). <button>A button</button></p>
  ${kind === 'transparent' ? '' : '<img id="diagram" src="/lc_tree.jpg"> <img id="photo" src="/photo_b.jpg">'}
  </body></html>`;

// Charts drawn as inline SVG: on white, with a light plot area on dark paper (Plotly under
// Dark Reader), transparent ones that belong to a dark site's design, an icon, and one that a
// script draws late.
function chartFixture(theme) {
  const axes = (ink) => `<path d="M40 200H380M40 200V20" stroke="${ink}" stroke-width="2" fill="none"/>
    <polyline points="40,180 120,110 200,140 280,60 380,40" stroke="${ink}" stroke-width="3" fill="none"/>
    <text x="210" y="228" font-size="14" text-anchor="middle" fill="${ink}">year</text>`;
  const grid = [60, 100, 140, 180].map((y) => `<path d="M40 ${y}H380" stroke="#fff" stroke-width="1"/>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip chart fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  .grid{display:grid;grid-template-columns:repeat(3,420px);gap:22px} svg.chart{width:400px;height:240px;display:block}
  </style></head><body class="${theme}"><h1 style="font-size:20px">Inkflip chart test page</h1><div class="grid">
  <svg id="ch-white" class="chart" viewBox="0 0 400 240"><rect width="400" height="240" fill="#fff"/>${axes('#000')}</svg>
  <svg id="ch-paper" class="chart" viewBox="0 0 400 240"><rect width="400" height="240" fill="#1c1e22"/>
    <rect id="ch-plot" x="40" y="20" width="340" height="180" fill="#e5ecf6"/>${grid}<polyline points="40,180 120,110 200,140 280,60 380,40" stroke="#636efa" stroke-width="3" fill="none"/>
    <text x="210" y="228" font-size="14" text-anchor="middle" fill="#ccc">year</text></svg>
  <svg id="ch-clear" class="chart" viewBox="0 0 400 240">${axes('#ddd')}</svg>
  <svg id="ch-dark" class="chart" viewBox="0 0 400 240">${axes('#000')}</svg>
  <div><svg id="ch-icon" viewBox="0 0 24 24" style="width:24px;height:24px"><rect width="24" height="24" fill="#fff"/></svg></div>
  <svg id="ch-defs" class="chart" viewBox="0 0 400 240"><defs><symbol id="box" viewBox="0 0 100 60"><rect x="1" y="1" width="98" height="58" rx="8" fill="#e5daf2" stroke="#666" stroke-width="2"/></symbol></defs>
    <use href="#box" x="20" y="90" width="100" height="60"/><use href="#box" x="150" y="90" width="100" height="60"/><use href="#box" x="280" y="90" width="100" height="60"/>
    <path d="M120 120H150M250 120H280" stroke="#000" stroke-width="2"/>
    <text x="70" y="126" text-anchor="middle" font-size="16" fill="#000">read</text><text x="200" y="126" text-anchor="middle" font-size="16" fill="#000">write</text>
    <text x="330" y="126" text-anchor="middle" font-size="16" fill="#000">step</text><text x="20" y="40" font-size="16" fill="#000">A figure drawn for white paper</text></svg>
  <div id="late-box"></div>
  </div>
  <script>window.setTheme = (t) => { document.body.className = t; };
  const late = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  late.id = 'ch-late'; late.setAttribute('class', 'chart'); late.setAttribute('viewBox', '0 0 400 240');
  document.getElementById('late-box').append(late);
  setTimeout(() => { late.innerHTML = '<rect width="400" height="240" fill="#fff"/>' + ${JSON.stringify(axes('#000'))}; }, 700);</script>
  </body></html>`;
}

// Pictures inside web components: open and closed shadow roots, one nested in another, and a
// component defined late (its root appears a while after it is on the page).
function shadowFixture(theme) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip shadow fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  .grid{display:grid;grid-template-columns:repeat(3,360px);gap:22px}
  </style></head><body class="${theme}"><h1 style="font-size:20px">Inkflip shadow DOM test page</h1><div class="grid">
  <open-figure src="/lc_tree.jpg" pid="open-img"></open-figure>
  <closed-figure src="/lc_closestplane.jpg" pid="closed-img"></closed-figure>
  <outer-figure></outer-figure>
  <open-figure src="/photo_b.jpg" pid="shadow-photo"></open-figure>
  <late-figure src="/mpl_simpleplot.png" pid="late-img"></late-figure>
  </div>
  <script>
  const tpl = (src, id) => '<img id="' + id + '" src="' + src + '" style="display:block;width:340px;height:200px;object-fit:contain">';
  customElements.define('open-figure', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = tpl(this.getAttribute('src'), this.getAttribute('pid')); } });
  customElements.define('closed-figure', class extends HTMLElement { connectedCallback() { if (this.r) return; this.r = this.attachShadow({ mode: 'closed' }); this.r.innerHTML = tpl(this.getAttribute('src'), this.getAttribute('pid')); window.closedRoot = this.r; } });
  customElements.define('outer-figure', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = '<open-figure src="/lc_merge.jpg" pid="nested-img"></open-figure>'; } });
  setTimeout(() => customElements.define('late-figure', class extends HTMLElement { connectedCallback() { if (!this.shadowRoot) this.attachShadow({ mode: 'open' }).innerHTML = tpl(this.getAttribute('src'), this.getAttribute('pid')); } }), 1500);
  window.setTheme = (t) => { document.body.className = t; };
  // Finds an element by id through every shadow root (the closed one is kept on window for the test).
  window.deep = (id) => {
    const roots = [document, window.closedRoot];
    for (let i = 0; i < roots.length; i++) {
      const hit = roots[i] && roots[i].getElementById ? roots[i].getElementById(id) : roots[i]?.querySelector('#' + id);
      if (hit) return hit;
      for (const el of roots[i] ? roots[i].querySelectorAll('*') : []) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return null;
  };
  </script></body></html>`;
}

// Pictures that aren't <img>: a diagram as a CSS background (and one under text, which must be
// left alone), a picture in an SVG <image>, and video posters.
function pictureFixture(theme) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip picture fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  .grid{display:grid;grid-template-columns:repeat(3,360px);gap:22px} .cell{width:340px;height:200px}
  #bg-diagram{background:#fff url(/lc_tree.jpg) center/contain no-repeat}
  #bg-photo{background:url(/photo_b.jpg) center/cover}
  #bg-text{background:#fff url(/lc_tree.jpg) center/contain no-repeat;color:#000;padding:8px}
  </style></head><body class="${theme}"><h1 style="font-size:20px">Inkflip picture test page</h1><div class="grid">
  <div id="bg-diagram" class="cell"></div>
  <div id="bg-photo" class="cell"></div>
  <div id="bg-text" class="cell">A caption written over the picture</div>
  <div id="bg-inline" class="cell" style="background:#fff url(/mpl_simpleplot.png) center/contain no-repeat"></div>
  <svg class="cell" viewBox="0 0 340 200"><image id="svg-image" href="/lc_closestplane.jpg" width="340" height="200"/></svg>
  <video id="poster-diagram" class="cell" poster="/lc_merge.jpg" src="/none.mp4"></video>
  <video id="poster-photo" class="cell" poster="/photo_a.jpg"></video>
  <video id="poster-controls" class="cell" poster="/lc_tree.jpg" controls></video>
  </div><script>window.setTheme = (t) => { document.body.className = t; };</script></body></html>`;
}

// Light boxes a dark site paints itself: panels with text, cards with pictures, a box inside a
// box, a button, form fields left to the browser or coloured by the site, and a consent banner
// that a script adds later.
function boxFixture(theme) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Inkflip box fixture</title><style>
  body{margin:0;padding:32px 40px;font:15px/1.5 system-ui,sans-serif}
  body.dark{background:#181a1b;color:#e8e6e3} body.light{background:#fff;color:#222}
  .white{background:#fff;color:#222;border-radius:10px;padding:14px;box-shadow:0 4px 16px #0008}
  .grid{display:grid;grid-template-columns:repeat(3,380px);gap:22px;margin-top:20px}
  img{display:block;width:100%;height:150px;object-fit:contain}
  #banner{position:fixed;left:0;right:0;bottom:0;background:#fff;color:#111;padding:16px 24px}
  </style></head><body class="${theme}"><h1 style="font-size:20px">Inkflip box test page</h1>
  <div id="box-text" class="white" style="width:600px">A notice the site paints white. <a href="#">Read more</a></div>
  <div class="grid">
    <div id="box-photo" class="white">A card with a photo<img id="photo-in-box" src="/photo_b.jpg"></div>
    <div id="box-diagram" class="white">A card with a diagram<img id="diagram-in-box" src="/lc_tree.jpg"><div id="box-inner" class="white" style="height:60px">A box in a box</div></div>
    <div id="box-pictures" class="white" style="padding:0"><img id="only-picture" src="/lc_closestplane.jpg" style="height:220px"></div>
    <div><button id="box-button" style="background:#fff;color:#111;border:0;border-radius:6px;padding:8px 16px">Sign up</button></div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="field-plain" value="A text field">
      <select id="field-select"><option>A select</option></select>
      <input id="field-styled" value="Coloured by the site" style="background:#fff;color:#111;border:1px solid #ccc">
    </div>
  </div>
  <script>window.setTheme = (t) => { document.body.className = t; };
  setTimeout(() => { const b = document.createElement('div'); b.id = 'banner'; b.innerHTML = 'We use cookies. <button>Accept</button>'; document.body.append(b); }, 800);</script>
  </body></html>`;
}

function serve(handler) {
  return new Promise((resolve) => {
    const s = createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}

const imageServer = (req, res) => {
  const svg = /^\/doc\/svg-(white|clear)$/.exec(req.url);
  if (svg) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(svgDoc(svg[1] === 'white'));
  }
  const doc = /^\/doc\/(white|dark|transparent)$/.exec(req.url);
  if (doc) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(frameDoc(doc[1]));
  }
  const name = path.basename(decodeURIComponent(req.url.split('?')[0]));
  if (name === 'diagram.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(SVG);
  }
  readFile(path.join(IMAGES, name)).then((buf) => res.end(buf), () => { res.statusCode = 404; res.end(); });
};
const other = await serve(imageServer); // a second origin: its images taint the page canvas
const OTHER = `http://localhost:${other.address().port}`;
const main = await serve((req, res) => {
  const m = /^\/(page|canvas|cards|frames|charts|shadow|pictures|boxes)\/(dark|light)/.exec(req.url);
  if (m) {
    res.setHeader('Content-Type', 'text/html');
    return res.end({ page: fixture, canvas: canvasFixture, cards: cardFixture, frames: frameFixture, charts: chartFixture, shadow: shadowFixture, pictures: pictureFixture, boxes: boxFixture }[m[1]](m[2], OTHER));
  }
  imageServer(req, res);
});
const BASE = `http://127.0.0.1:${main.address().port}`;

// ---------------------------------------------------------------------- helpers

const verdictOf = (page, id) => page.evaluate((id) => {
  const el = document.getElementById(id);
  return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter };
}, id);


const settled = (page, ids) => waitFor(page, (ids) => ids.every((id) => {
  const el = document.getElementById(id);
  return el && el.hasAttribute('data-inkflip');
}), ids);

async function popupShot(context, id, pageUrlPart, file) {
  const ctl = context.pages().find((p) => p.url().startsWith('chrome-extension://'));
  const target = await ctl.evaluate(async (part) => (await chrome.tabs.query({})).find((t) => (t.url || "").includes(part))?.id, pageUrlPart);
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 340, height: 600 });
  await pop.goto(`chrome-extension://${id}/popup/popup.html?tab=${target}`);
  await pop.waitForTimeout(1300);
  const h = await pop.evaluate(() => document.documentElement.scrollHeight);
  await pop.setViewportSize({ width: 340, height: h });
  await pop.screenshot({ path: path.join(SHOTS, file) });
  const text = await pop.evaluate(() => ({
    status: document.querySelector('#status span').textContent,
    flip: document.getElementById('n-flip').textContent,
  }));
  await pop.close();
  return text;
}

// ------------------------------------------------------------- part 1: Inkflip only

await access(path.join(IMAGES, 'lc_closestplane.jpg')).catch(() => {
  console.error('Run `npm run test:real` once first: it downloads the test images.');
  process.exit(2);
});

console.log('Inkflip on a dark fixture page');
if (part('images')) {
  const { context, id, ctl } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/page/dark');
  const ids = ['same-diagram', 'x-diagram', 'x-svg', 'chart', 'logo', 'product', 'list', 'photo'];
  check('every visible image gets a verdict', await settled(page, ids));
  await page.waitForTimeout(300);
  const f1 = await flashes(page);
  check('no image ever shows white first (first visit, empty cache)', !Object.keys(f1).length, JSON.stringify(f1));
  check('photos are revealed once checked', (await page.evaluate(() => getComputedStyle(document.getElementById('photo')).opacity)) === '1');
  const expect = { 'same-diagram': 'flip', 'x-diagram': 'flip', 'x-svg': 'flip', chart: 'flip', logo: 'logo', product: 'dim', list: 'flip', photo: 'none' };
  for (const [el, want] of Object.entries(expect)) {
    const got = await verdictOf(page, el);
    const styled = want === 'none' ? got.filter === 'none' : got.l !== null && got.filter !== 'none';
    check(`${el}: ${want}`, got.v === want && styled, JSON.stringify(got));
  }
  check('flip lands white just under the page colour (#181a1b → invert 0.92, lighten)', await waitFor(page,
    () => {
      const cs = getComputedStyle(document.getElementById('same-diagram'));
      return cs.filter.startsWith('invert(0.92)') && cs.mixBlendMode === 'lighten';
    }, null, 2000),
  (await verdictOf(page, 'same-diagram')).filter);

  await settled(page, ['avatar']);
  const avatar = await page.evaluate(() => {
    const el = document.getElementById('avatar');
    const cs = getComputedStyle(el);
    return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: cs.filter, opacity: cs.opacity };
  });
  check('a photo at avatar size is classified but never flipped, dimmed or hidden',
    avatar.v === 'dim' && avatar.l === null && avatar.filter === 'none' && avatar.opacity === '1', JSON.stringify(avatar));

  await settled(page, ['layered']);
  const layered = await verdictOf(page, 'layered');
  check('backdrop comes from what is painted behind, not the parent chain (#2a2d31 → 16)', layered.l === '16', JSON.stringify(layered));

  const far = await verdictOf(page, 'far');
  check('images far below the fold wait until scrolled near', far.v === null, JSON.stringify(far));
  await page.evaluate(() => document.getElementById('far').scrollIntoView());
  check('…and are classified once they are', await waitFor(page, () => document.getElementById('far').getAttribute('data-inkflip') === 'flip'));
  await page.evaluate(() => scrollTo(0, 0));

  if (argv.has('--shots')) {
    await page.waitForTimeout(400);
    await settings(ctl, { badges: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, 'badges.png') });
    await settings(ctl, { badges: false });
  }

  await page.reload();
  check('reload: verdicts come straight from the cache', await settled(page, ids));
  await page.waitForTimeout(300);
  const f2 = await flashes(page);
  check('reload: still no white frame', !Object.keys(f2).length, JSON.stringify(f2));

  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → Inkflip stands by', await waitFor(page, () => !document.getElementById('same-diagram').hasAttribute('data-inkflip-l')));
  check('…and nothing is hidden on a light page', (await page.evaluate(() => getComputedStyle(document.getElementById('same-diagram')).opacity)) === '1');
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → flips return', await waitFor(page, () => document.getElementById('same-diagram').hasAttribute('data-inkflip-l')));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the original', peeked);
  check('releasing Alt flips it back', await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter !== 'none'));

  await settings(ctl, { disabledHosts: ['127.0.0.1'] });
  check('turning the site off removes every filter', await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter === 'none'));
  await settings(ctl, { disabledHosts: [] });
  check('turning it back on restores them', await waitFor(page, () => getComputedStyle(document.getElementById('same-diagram')).filter !== 'none'));

  await settings(ctl, { dim: false });
  check('switching off Dim leaves photos alone', await waitFor(page, () => getComputedStyle(document.getElementById('product')).filter === 'none'));
  await settings(ctl, { dim: true });

  await ctl.evaluate(async (src) => chrome.storage.local.set({ 'ovr:127.0.0.1': { [src]: 'flip' } }), BASE + '/photo_b.jpg');
  check('a right-click choice overrides the verdict', await waitFor(page, () => document.getElementById('photo').getAttribute('data-inkflip') === 'flip'));
  await ctl.evaluate(async () => chrome.storage.local.remove('ovr:127.0.0.1'));
  check('"Let Inkflip decide" undoes it', await waitFor(page, () => document.getElementById('photo').getAttribute('data-inkflip') === 'none'));

  const cached = await ctl.evaluate(async (url) => {
    const db = await new Promise((r) => { const q = indexedDB.open('inkflip', 1); q.onsuccess = () => r(q.result); });
    return new Promise((r) => { const q = db.transaction('verdicts').objectStore('verdicts').get(url); q.onsuccess = () => r(q.result?.verdict); });
  }, OTHER + '/lc_tree.jpg');
  check('cross-origin verdicts are cached', cached === 'flip', String(cached));

  await context.close();
}

// ---------------------------------------------- part 1b: canvases, video, right-click

console.log('\nCanvases and video on a dark fixture page');
if (part('canvas')) {
  const { context, ctl, sw } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/canvas/dark');
  const painted = ['cv-chart', 'cv-ink', 'cv-photo', 'cv-covered', 'cv-tainted'];
  check('every painted canvas gets a verdict', await settled(page, painted));
  await page.waitForTimeout(300);
  const f1 = await flashes(page);
  delete f1['cv-late']; // painted after the hold ran out: a short white moment is expected
  check('no canvas ever shows white first', !Object.keys(f1).length, JSON.stringify(f1));

  const shown = async (id) => page.evaluate((id) => {
    const el = document.getElementById(id);
    const cs = getComputedStyle(el);
    return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: cs.filter, opacity: cs.opacity };
  }, id);
  const styled = (s) => s.l !== null && s.filter.startsWith('invert(');
  let s = await shown('cv-chart');
  check('a chart on a white canvas is flipped', s.v === 'flip' && styled(s) && s.opacity === '1', JSON.stringify(s));
  s = await shown('cv-ink');
  check('black ink on a transparent canvas is made light', ['logo', 'flip'].includes(s.v) && styled(s), JSON.stringify(s));
  s = await shown('cv-covered');
  check('a canvas under a transparent layer is flipped too', s.v === 'flip' && styled(s), JSON.stringify(s));
  s = await shown('cv-photo');
  check('a photo drawn into a canvas is left alone', s.v === 'none' && s.filter === 'none' && s.opacity === '1', JSON.stringify(s));
  s = await shown('cv-tainted');
  check('a canvas holding a cross-origin picture is left alone and shown', s.v === 'none' && s.filter === 'none' && s.opacity === '1', JSON.stringify(s));
  check('a WebGL canvas is shown within a second and left alone', await waitFor(page, () => {
    const el = document.getElementById('cv-webgl');
    const cs = getComputedStyle(el);
    return cs.opacity === '1' && cs.filter === 'none' && el.getAttribute('data-inkflip') !== 'flip';
  }, null, 1500) && (await page.waitForTimeout(1000), (await shown('cv-webgl')).filter === 'none'),
  JSON.stringify(await shown('cv-webgl')));
  check('a canvas painted late is flipped once it is painted', await waitFor(page, () => {
    const el = document.getElementById('cv-late');
    return el.getAttribute('data-inkflip') === 'flip' && el.hasAttribute('data-inkflip-l');
  }, null, 5000), JSON.stringify(await shown('cv-late')));

  await page.evaluate(() => { document.getElementById('cv-chart').width = 500; window.chart('cv-chart', true); });
  s = await shown('cv-chart');
  check('resizing a canvas keeps its flip while it repaints', s.v === 'flip' && styled(s), JSON.stringify(s));
  await page.waitForTimeout(1200);
  s = await shown('cv-chart');
  check('…and it is still flipped after the recheck', s.v === 'flip' && styled(s), JSON.stringify(s));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('cv-chart')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the original canvas', peeked);

  // The right-click menu. Chrome's native menu can't be opened headless, so the test checks
  // that Chrome accepted every entry, moves and right-clicks the real mouse, then calls the
  // service worker's click handler directly.
  const missing = await sw.evaluate(async () => {
    const ids = ['', ':flip', ':dim', ':none', ':sep', ':auto'].map((c) => `inkflip${c}`);
    const errors = [];
    for (const id of ids) {
      await new Promise((done) => chrome.contextMenus.update(id, {}, () => {
        if (chrome.runtime.lastError) errors.push(`${id}: ${chrome.runtime.lastError.message}`);
        done();
      }));
    }
    return errors;
  });
  check('the Inkflip menu exists with its five entries', !missing.length, missing.join('; '));
  const under = () => sw.evaluate(() => self.inkflipTest.menuShown());
  const point = async (sel, fy = 0.5) => {
    const b = await page.locator(sel).boundingBox();
    return [b.x + b.width / 2, b.y + b.height * fy];
  };
  async function hover(sel, fy) {
    const [x, y] = await point(sel, fy);
    await page.mouse.move(x - 3, y);
    await page.mouse.move(x, y);
  }
  async function untilUnder(want) {
    for (let i = 0; i < 30; i++) {
      if ((await under()) === want) return true;
      await page.waitForTimeout(50);
    }
    return false;
  }
  await hover('#title');
  check('menu: nothing extra over text', await untilUnder(null), String(await under()));
  await hover('#cv-chart');
  check('menu: a canvas gets the Inkflip menu', await untilUnder('image'), String(await under()));
  await hover('#title');
  await untilUnder(null);
  await hover('#img-plain');
  check('menu: so does a plain image', await untilUnder('image'), String(await under()));
  await hover('#vid', 0.85);
  check('menu: a video gets it worded for video', await untilUnder('video'), String(await under()));
  await hover('#cv-overlay');
  check('menu: a canvas under a transparent layer gets it', await untilUnder('image'), String(await under()));
  await hover('#vid', 0.1);
  check('menu: so does a video under a transparent layer', await untilUnder('video'), String(await under()));

  async function choose(sel, menuItemId, info = {}, fy) {
    const [x, y] = await point(sel, fy);
    await page.mouse.move(x, y);
    await page.mouse.click(x, y, { button: 'right' });
    await sw.evaluate(async ({ menuItemId, info }) => {
      const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').includes('/canvas/'));
      await self.inkflipTest.menuClick({ menuItemId, frameId: 0, pageUrl: tab.url, ...info }, tab);
    }, { menuItemId, info });
  }
  const verdictIs = (id, v, filtered) => waitFor(page, ({ id, v, filtered }) => {
    const el = document.getElementById(id);
    return el.getAttribute('data-inkflip') === v && (getComputedStyle(el).filter !== 'none') === filtered;
  }, { id, v, filtered }, 4000);

  await choose('#cv-overlay', 'inkflip:none');
  check('right-click › Show as is, on a covered canvas', await verdictIs('cv-covered', 'none', false), JSON.stringify(await shown('cv-covered')));
  check('…changes that canvas only', (await shown('cv-chart')).v === 'flip');
  await choose('#cv-overlay', 'inkflip:auto');
  check('right-click › Let Inkflip decide flips it again', await verdictIs('cv-covered', 'flip', true), JSON.stringify(await shown('cv-covered')));

  await choose('#img-covered', 'inkflip:none');
  check('right-click › Show as is, on an image under a transparent layer', await verdictIs('img-covered', 'none', false), JSON.stringify(await shown('img-covered')));
  const stored = await ctl.evaluate(async () => (await chrome.storage.local.get('ovr:127.0.0.1'))['ovr:127.0.0.1'] || {});
  check('…remembered by the image\'s URL, like any image', stored[BASE + '/lc_tree.jpg'] === 'none', JSON.stringify(stored));
  await choose('#img-covered', 'inkflip:auto');
  check('…and undone', await verdictIs('img-covered', 'flip', true), JSON.stringify(await shown('img-covered')));

  await choose('#cv-webgl', 'inkflip:flip');
  check('right-click › Flip works on a WebGL canvas', await verdictIs('cv-webgl', 'flip', true), JSON.stringify(await shown('cv-webgl')));
  await choose('#cv-webgl', 'inkflip:auto');
  check('…and Let Inkflip decide leaves it alone again', await waitFor(page, () => {
    const el = document.getElementById('cv-webgl');
    return getComputedStyle(el).filter === 'none';
  }, null, 4000), JSON.stringify(await shown('cv-webgl')));

  await choose('#vid', 'inkflip:flip', { mediaType: 'video', srcUrl: '' }, 0.85);
  check('right-click › Flip this video', await verdictIs('vid', 'flip', true), JSON.stringify(await shown('vid')));
  await choose('#cv-chart', 'inkflip:none');
  check('right-click › Show as is, on a canvas', await verdictIs('cv-chart', 'none', false), JSON.stringify(await shown('cv-chart')));

  await page.reload();
  check('reload: the video choice is remembered', await verdictIs('vid', 'flip', true), JSON.stringify(await shown('vid')));
  check('reload: the canvas choice is remembered', await verdictIs('cv-chart', 'none', false), JSON.stringify(await shown('cv-chart')));
  await choose('#vid', 'inkflip:auto', { mediaType: 'video', srcUrl: '' }, 0.85);
  check('Let Inkflip decide leaves a video alone again', await waitFor(page, () => {
    const el = document.getElementById('vid');
    return !el.hasAttribute('data-inkflip') && getComputedStyle(el).filter === 'none';
  }, null, 4000), JSON.stringify(await shown('vid')));
  await choose('#cv-chart', 'inkflip:auto');
  check('…and a canvas is judged again', await verdictIs('cv-chart', 'flip', true), JSON.stringify(await shown('cv-chart')));

  await page.goto(BASE + '/canvas/light');
  await page.waitForTimeout(800);
  s = await shown('cv-chart');
  check('light page: canvases are neither hidden nor filtered', s.opacity === '1' && s.filter === 'none' && s.l === null, JSON.stringify(s));
  await context.close();
}

// ------------------------------------------------------------ part 1c: picture cards

console.log('\nPicture cards on a dark fixture page');
if (part('cards')) {
  const { context, ctl } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/cards/dark');
  const imgs = ['shot', 'window-img', 'pair-a', 'pair-b', 'reading-img', 'sparse-img', 'covered-img', 'editor-img', 'teal-img'];
  check('every image on the card page gets a verdict', await settled(page, imgs));
  await page.waitForTimeout(300);
  const look = () => page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[id]')) {
      const cs = getComputedStyle(el);
      out[el.id] = { card: el.hasAttribute('data-inkflip-card'), filter: cs.filter, opacity: cs.opacity, l: el.getAttribute('data-inkflip-l') };
    }
    return out;
  });
  let s = await look();
  const dimmed = (id) => s[id].card && s[id].filter === 'brightness(0.8)';
  const plain = (id) => s[id].filter === 'none' && s[id].opacity === '1' && s[id].l === null;
  check('a screenshot on a pastel panel: the whole panel is dimmed', dimmed('card-shot'), JSON.stringify(s['card-shot']));
  check('…and the screenshot gets no filter of its own', plain('shot'), JSON.stringify(s.shot));
  check('an app window on a coloured slab: the outer slab is the card', dimmed('card-window') && !s.window.card, JSON.stringify([s['card-window'], s.window]));
  check('…and the window\'s picture is left as is inside it', plain('window-img'), JSON.stringify(s['window-img']));
  check('two shots on a gradient panel share one dimmed card', dimmed('card-pair') && plain('pair-a') && plain('pair-b'), JSON.stringify([s['card-pair'], s['pair-a'], s['pair-b']]));
  const left = ['reading', 'sparse', 'covered', 'editor', 'teal'].filter((id) => s[id].card);
  check('captioned, sparse, fully covered, editable and dark panels are not cards', !left.length, left.join(', '));
  const boxed = ['reading', 'editor'].filter((id) => !s[id].filter.startsWith('invert('));
  check('…the captioned and editable ones are light boxes with something to read: flipped', !boxed.length, boxed.join(', '));
  const plainPanels = ['sparse', 'covered', 'teal'].filter((id) => s[id].filter !== 'none');
  check('…and the others are left as they are', !plainPanels.length, plainPanels.join(', '));
  check('…and their light-backed images stay as they are', ['reading-img', 'sparse-img', 'covered-img', 'editor-img'].every(plain),
    JSON.stringify(['reading-img', 'sparse-img', 'covered-img', 'editor-img'].map((id) => s[id])));
  check('an image on a dark panel is still flipped on its own', s['teal-img'].l !== null && s['teal-img'].filter.startsWith('invert('), JSON.stringify(s['teal-img']));
  const f1 = await flashes(page);
  check('no white frame on the card page', !Object.keys(f1).length, JSON.stringify(f1));

  const cardFilter = () => page.evaluate(() => getComputedStyle(document.getElementById('card-shot')).filter);
  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('card-shot')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the card as it is', peeked);
  check('releasing Alt dims it again', await waitFor(page, () => getComputedStyle(document.getElementById('card-shot')).filter !== 'none'));

  await settings(ctl, { dim: false });
  check('switching off Dim lets the cards go', await waitFor(page, () => !document.querySelector('[data-inkflip-card]')), await cardFilter());
  await settings(ctl, { dim: true });
  check('switching it on finds them again', await waitFor(page, () => document.querySelectorAll('[data-inkflip-card]').length === 3));

  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → no cards', await waitFor(page, () => !document.querySelector('[data-inkflip-card]')));
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → the cards return', await waitFor(page, () => document.querySelectorAll('[data-inkflip-card]').length === 3));

  // A page re-renders and the screenshot moves out of its card onto the dark panel.
  await page.evaluate(() => { document.getElementById('teal').append(document.getElementById('shot')); window.setTheme('dark x'); });
  check('a card that loses its picture is let go', await waitFor(page, () => !document.getElementById('card-shot').hasAttribute('data-inkflip-card')));
  check('…and the picture is flipped on its new dark panel', await waitFor(page, () => {
    const el = document.getElementById('shot');
    return el.getAttribute('data-inkflip-l') !== null && getComputedStyle(el).filter.startsWith('invert(');
  }), JSON.stringify((await look()).shot));
  await context.close();
}

// ------------------------------------------------------------------ part 1d: frames

console.log('\nEmbedded pages on a dark fixture page');
if (part('frames')) {
  const { context, ctl } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/frames/dark');
  const frameOf = async (id) => (await page.$('#' + id)).contentFrame();
  const look = () => page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('iframe')) {
      const cs = getComputedStyle(el);
      out[el.id] = { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: cs.filter, shadow: cs.boxShadow };
    }
    return out;
  });
  const flippedIds = ['fr-white', 'fr-sandpack', 'fr-scheme'];
  check('light frames are flipped', await waitFor(page, (ids) => ids.every((id) =>
    getComputedStyle(document.getElementById(id)).filter.startsWith('invert(')), flippedIds), JSON.stringify(await look()));
  const changes = await page.evaluate(() => new Promise((resolve) => {
    const seen = [];
    const mo = new MutationObserver((muts) => {
      for (const m of muts) seen.push(`${m.target.id}.${m.attributeName}=${m.target.getAttribute(m.attributeName)}`);
    });
    for (const el of document.querySelectorAll('iframe,object')) mo.observe(el, { attributes: true, attributeFilter: ['data-inkflip', 'data-inkflip-l'] });
    setTimeout(() => { mo.disconnect(); resolve(seen); }, 1500);
  }));
  check('…and they stay flipped (no back and forth)', changes.length === 0, changes.join(' '));
  let s = await look();
  check('…a white page, a transparent one in a white iframe, and one the browser backs with white',
    flippedIds.every((id) => s[id].v === 'flip' && s[id].l === '8'), JSON.stringify(flippedIds.map((id) => s[id])));
  check('…with no drop shadow left to glow', s['fr-sandpack'].shadow === 'none', s['fr-sandpack'].shadow);
  check('a dark frame is left alone', s['fr-dark'].v === 'none' && s['fr-dark'].filter === 'none', JSON.stringify(s['fr-dark']));
  check('a see-through frame is left alone', s['fr-clear'].v === null && s['fr-clear'].filter === 'none', JSON.stringify(s['fr-clear']));
  check('a tiny frame is left alone', s['fr-tiny'].filter === 'none', JSON.stringify(s['fr-tiny']));

  // What actually reaches the screen: the frame's white turns into the page's own colour.
  const pixel = async (id, dx, dy) => {
    const box = await (await page.$('#' + id)).boundingBox();
    const buf = await page.screenshot({ clip: { x: box.x + dx, y: box.y + dy, width: 1, height: 1 } });
    return ctl.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const g = new OffscreenCanvas(img.width, img.height).getContext('2d');
      g.drawImage(img, 0, 0);
      return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    }, buf.toString('base64'));
  };
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
  for (const id of flippedIds) {
    const px = await pixel(id, 300, 230);
    check(`${id}: its background is the page colour (#181a1b) on screen`, near(px, [0x18, 0x1a, 0x1b]), JSON.stringify(px));
  }

  const inner = await frameOf('fr-white');
  check('the flipped frame is told so', await waitFor(inner, () => document.documentElement.hasAttribute('data-inkflip-flipped')));
  check('…and its pictures get verdicts', await waitFor(inner, () => ['diagram', 'photo'].every((id) => document.getElementById(id).hasAttribute('data-inkflip'))));
  const pics = () => inner.evaluate(() => Object.fromEntries(['diagram', 'photo'].map((id) => {
    const el = document.getElementById(id);
    return [id, { v: el.getAttribute('data-inkflip'), filter: getComputedStyle(el).filter, opacity: getComputedStyle(el).opacity }];
  })));
  let p = await pics();
  check('…its diagram stays flipped with the frame', p.diagram.v === 'flip' && p.diagram.filter === 'none' && p.diagram.opacity === '1', JSON.stringify(p.diagram));
  check('…and its photo is turned back', p.photo.filter === 'invert(1) hue-rotate(180deg)' && p.photo.opacity === '1', JSON.stringify(p.photo));
  const darkInner = await frameOf('fr-dark');
  check('a dark frame is not told it is flipped', !(await darkInner.evaluate(() => document.documentElement.hasAttribute('data-inkflip-flipped'))));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('fr-white')).filter === 'none', null, 2000) &&
    await waitFor(inner, () => getComputedStyle(document.getElementById('photo')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the frame and its photo as they are', peeked);
  check('releasing Alt flips them back', await waitFor(page, () => getComputedStyle(document.getElementById('fr-white')).filter !== 'none') &&
    await waitFor(inner, () => getComputedStyle(document.getElementById('photo')).filter !== 'none'));

  await settings(ctl, { flip: false });
  check('switching off Flip lets the frames go', await waitFor(page, () => getComputedStyle(document.getElementById('fr-white')).filter === 'none'));
  check('…and the frame turns its photo back to normal', await waitFor(inner, () => !document.documentElement.hasAttribute('data-inkflip-flipped') &&
    getComputedStyle(document.getElementById('photo')).filter === 'none'));
  await settings(ctl, { flip: true });
  check('switching it on flips them again', await waitFor(page, () => getComputedStyle(document.getElementById('fr-white')).filter !== 'none'));

  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → frames are left alone', await waitFor(page, () =>
    [...document.querySelectorAll('iframe')].every((el) => getComputedStyle(el).filter === 'none')));
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → they flip again', await waitFor(page, (ids) => ids.every((id) =>
    getComputedStyle(document.getElementById(id)).filter.startsWith('invert(')), flippedIds));

  // Documents this script couldn't reach before: SVG files, srcdoc and about:blank frames.
  await waitFor(page, () => ['fr-svg', 'ob-svg', 'ob-svg-clear', 'fr-srcdoc', 'fr-blank'].every((id) =>
    document.getElementById(id).hasAttribute('data-inkflip-l')), null, 5000);
  const ext = await look();
  const svgFlipped = (id) => ['flip', 'logo'].includes(ext[id].v) && ext[id].l === '8' && ext[id].filter.startsWith('invert(');
  check('an SVG file in an iframe is flipped', svgFlipped('fr-svg'), JSON.stringify(ext['fr-svg']));
  const objects = await page.evaluate(() => Object.fromEntries(['ob-svg', 'ob-svg-clear'].map((id) => {
    const el = document.getElementById(id);
    return [id, { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter }];
  })));
  check('an SVG file in an <object> is flipped', ['flip', 'logo'].includes(objects['ob-svg'].v) && objects['ob-svg'].filter.startsWith('invert('), JSON.stringify(objects['ob-svg']));
  check('a transparent SVG file\'s black lines are made light', ['flip', 'logo'].includes(objects['ob-svg-clear'].v) && objects['ob-svg-clear'].filter.startsWith('invert('), JSON.stringify(objects['ob-svg-clear']));
  check('a srcdoc frame is flipped', ext['fr-srcdoc'].v === 'flip' && ext['fr-srcdoc'].filter.startsWith('invert('), JSON.stringify(ext['fr-srcdoc']));
  check('an about:blank frame filled by script is flipped', ext['fr-blank'].v === 'flip' && ext['fr-blank'].filter.startsWith('invert('), JSON.stringify(ext['fr-blank']));
  for (const id of ['fr-svg', 'fr-srcdoc']) {
    const px = await pixel(id, 300, 200);
    check(`${id}: its background is the page colour on screen`, near(px, [0x18, 0x1a, 0x1b]), JSON.stringify(px));
  }

  // A new document in a flipped frame: told afresh.
  await page.evaluate((u) => { document.getElementById('fr-white').src = u; }, OTHER + '/doc/dark');
  check('a frame that navigates to a dark page is let go', await waitFor(page, () =>
    getComputedStyle(document.getElementById('fr-white')).filter === 'none', null, 5000));
  await context.close();
}

// ------------------------------------------------------------------ part 1e: charts

console.log('\nCharts drawn as inline SVG on a dark fixture page');
if (part('charts')) {
  const { context, ctl } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/charts/dark');
  const look = () => page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('svg[id]')) {
      out[el.id] = { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter, opacity: getComputedStyle(el).opacity };
    }
    const plot = document.getElementById('ch-plot');
    const m = getComputedStyle(plot).fill.match(/[\d.]+/g).map(Number);
    out.plot = { fillAttr: plot.getAttribute('data-inkflip-fill'), fill: getComputedStyle(plot).fill, L: (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 };
    return out;
  });
  check('a chart on white is flipped', await waitFor(page, () => getComputedStyle(document.getElementById('ch-white')).filter.startsWith('invert(')), JSON.stringify((await look())['ch-white']));
  let s = await look();
  check('…with its white taking the page colour (#181a1b → 8)', s['ch-white'].v === 'flip' && s['ch-white'].l === '8', JSON.stringify(s['ch-white']));
  check('a light plot area on dark paper gets a dark fill instead', await waitFor(page, () => {
    const p = document.getElementById('ch-plot');
    const m = getComputedStyle(p).fill.match(/[\d.]+/g).map(Number);
    return p.hasAttribute('data-inkflip-fill') && (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 < 0.3;
  }), JSON.stringify((await look()).plot));
  s = await look();
  check('…and that chart is not flipped as a whole', s['ch-paper'].filter === 'none', JSON.stringify(s['ch-paper']));
  check('transparent drawings on a dark site are part of its design: left alone',
    s['ch-clear'].filter === 'none' && s['ch-dark'].filter === 'none', JSON.stringify([s['ch-clear'], s['ch-dark']]));
  check('an icon is never touched', s['ch-icon'].v === null && s['ch-icon'].filter === 'none', JSON.stringify(s['ch-icon']));
  check('a chart a script draws late is flipped once drawn', await waitFor(page, () =>
    getComputedStyle(document.getElementById('ch-late')).filter.startsWith('invert(')), JSON.stringify((await look())['ch-late']));
  check('…and none is left hidden', Object.values(await look()).every((x) => x.opacity === undefined || x.opacity === '1'), JSON.stringify(await look()));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('ch-white')).filter === 'none' &&
    getComputedStyle(document.getElementById('ch-plot')).fill === 'rgb(229, 236, 246)', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the charts as they are', peeked, JSON.stringify(await look()));
  check('releasing Alt darkens them again', await waitFor(page, () => getComputedStyle(document.getElementById('ch-white')).filter !== 'none' &&
    getComputedStyle(document.getElementById('ch-plot')).fill !== 'rgb(229, 236, 246)'));

  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → charts and fills are let go', await waitFor(page, () =>
    getComputedStyle(document.getElementById('ch-white')).filter === 'none' && !document.getElementById('ch-plot').hasAttribute('data-inkflip-fill')));
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → they return', await waitFor(page, () =>
    getComputedStyle(document.getElementById('ch-white')).filter !== 'none' && document.getElementById('ch-plot').hasAttribute('data-inkflip-fill')));
  await context.close();
}

// ------------------------------------------------------------------ part 1f: shadow roots

console.log('\nPictures inside shadow roots on a dark fixture page');
if (part('shadow')) {
  const { context } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/shadow/dark');
  const look = () => page.evaluate(() => Object.fromEntries(['open-img', 'closed-img', 'nested-img', 'shadow-photo', 'late-img'].map((id) => {
    const el = window.deep(id);
    return [id, el && { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter, opacity: getComputedStyle(el).opacity }];
  })));
  const flipped = (x) => x && x.v === 'flip' && x.l === '8' && x.filter.startsWith('invert(') && x.opacity === '1';
  check('an image in an open shadow root is flipped', await waitFor(page, () => getComputedStyle(window.deep('open-img')).filter.startsWith('invert(')), JSON.stringify((await look())['open-img']));
  let s = await look();
  check('…with its white taking the page colour', flipped(s['open-img']), JSON.stringify(s['open-img']));
  check('so is one in a closed shadow root', flipped(s['closed-img']), JSON.stringify(s['closed-img']));
  check('and one in a root inside another root', flipped(s['nested-img']), JSON.stringify(s['nested-img']));
  check('a photo in a shadow root is left alone and shown', s['shadow-photo']?.v === 'none' && s['shadow-photo'].filter === 'none' && s['shadow-photo'].opacity === '1', JSON.stringify(s['shadow-photo']));
  check('a component defined late is reached once its root appears', await waitFor(page, () => {
    const el = window.deep('late-img');
    return el && getComputedStyle(el).filter.startsWith('invert(');
  }, null, 6000), JSON.stringify((await look())['late-img']));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(window.deep('open-img')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows them as they are', peeked);
  check('releasing Alt flips them back', await waitFor(page, () => getComputedStyle(window.deep('open-img')).filter !== 'none'));
  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → they are let go', await waitFor(page, () => getComputedStyle(window.deep('closed-img')).filter === 'none'));
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → flipped again', await waitFor(page, () => getComputedStyle(window.deep('closed-img')).filter !== 'none'));
  await context.close();
}

// ------------------------------------------------------------- part 1g: other pictures

console.log('\nBackgrounds, SVG <image> and posters on a dark fixture page');
if (part('pictures')) {
  const { context } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/pictures/dark');
  const ids = ['bg-diagram', 'bg-photo', 'bg-text', 'svg-image', 'poster-diagram', 'poster-photo'];
  const look = () => page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const el = document.getElementById(id);
    return [id, { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter }];
  })), ids);
  const flipped = (x) => ['flip', 'logo'].includes(x.v) && x.l === '8' && x.filter.startsWith('invert(');
  check('a diagram set as a CSS background is flipped', await waitFor(page, () => getComputedStyle(document.getElementById('bg-diagram')).filter.startsWith('invert(')), JSON.stringify((await look())['bg-diagram']));
  await waitFor(page, () => ['svg-image', 'poster-diagram', 'poster-photo', 'bg-photo'].every((id) => document.getElementById(id).hasAttribute('data-inkflip')), null, 5000);
  let s = await look();
  check('…blending into the page colour', flipped(s['bg-diagram']), JSON.stringify(s['bg-diagram']));
  check('a photo as a background is left alone', s['bg-photo'].filter === 'none', JSON.stringify(s['bg-photo']));
  check('a background with text over it is never touched', s['bg-text'].v === null && s['bg-text'].filter === 'none', JSON.stringify(s['bg-text']));
  check('a picture in an SVG <image> is flipped', flipped(s['svg-image']), JSON.stringify(s['svg-image']));
  check('a video showing a diagram as its poster is flipped', flipped(s['poster-diagram']), JSON.stringify(s['poster-diagram']));
  check('a video with a photo as its poster is left alone', s['poster-photo'].filter === 'none', JSON.stringify(s['poster-photo']));
  // Its native controls must not turn light with it: their bar is turned back. Checked on screen.
  const ctl2 = context.pages().find((p) => p.url().startsWith('chrome-extension://'));
  await waitFor(page, () => getComputedStyle(document.getElementById('poster-controls')).filter.startsWith('invert('));
  await page.evaluate(() => document.getElementById('poster-controls').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(600);
  const vbox = await (await page.$('#poster-controls')).boundingBox();
  const bar = await page.screenshot({ clip: { x: vbox.x + 8, y: vbox.y + vbox.height - 6, width: 1, height: 1 } });
  const barL = await ctl2.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const g = new OffscreenCanvas(1, 1).getContext('2d');
    g.drawImage(img, 0, 0);
    const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
    return (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
  }, bar.toString('base64'));
  check('a flipped poster\'s video controls keep their dark bar', barL < 0.5, `bar lightness ${barL.toFixed(2)}`);
  await page.evaluate(() => document.getElementById('poster-diagram').dispatchEvent(new Event('playing')));
  check('…until it plays: then it is shown as it is', await waitFor(page, () => getComputedStyle(document.getElementById('poster-diagram')).filter === 'none'));

  // A background given by a stylesheet that arrives later.
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'bg-late';
    d.className = 'cell';
    document.querySelector('.grid').append(d);
    setTimeout(() => {
      const st = document.createElement('style');
      st.textContent = '#bg-late{background:#fff url(/mpl_simpleplot.png) center/contain no-repeat}';
      document.head.append(st);
    }, 300);
  });
  check('a background that a later stylesheet sets is found', await waitFor(page, () => getComputedStyle(document.getElementById('bg-late')).filter.startsWith('invert(')));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('bg-diagram')).filter === 'none' &&
    getComputedStyle(document.getElementById('svg-image')).filter === 'none', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows them as they are', peeked);
  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → let go', await waitFor(page, () => getComputedStyle(document.getElementById('bg-diagram')).filter === 'none'));
  await context.close();
}

// ------------------------------------------------------------------ part 1h: light boxes

console.log('\nLight boxes on a site that is dark by itself');
if (part('boxes')) {
  const { context, ctl } = await launch([EXT]);
  const page = await context.newPage();
  await page.goto(BASE + '/boxes/dark');
  const look = () => page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[id]')) {
      const cs = getComputedStyle(el);
      const m = cs.backgroundColor.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
      out[el.id] = { panel: el.getAttribute('data-inkflip-panel'), field: el.getAttribute('data-inkflip-field'), filter: cs.filter,
        bgL: m.length > 3 && m[3] === 0 ? null : +((0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255).toFixed(2), shadow: cs.boxShadow };
    }
    return out;
  });
  check('a light box with text is flipped', await waitFor(page, () => getComputedStyle(document.getElementById('box-text')).filter.startsWith('invert(')), JSON.stringify((await look())['box-text']));
  await waitFor(page, () => document.getElementById('photo-in-box').hasAttribute('data-inkflip') && document.getElementById('diagram-in-box').hasAttribute('data-inkflip'));
  await page.waitForTimeout(1200);
  let s = await look();
  check('…to just under the page colour, with no glow left from its shadow', s['box-text'].panel === '8' && s['box-text'].shadow === 'none', JSON.stringify(s['box-text']));
  check('a card with a photo is flipped, and the photo turned back', s['box-photo'].panel === '8' && s['photo-in-box'].filter === 'invert(1) hue-rotate(180deg)',
    JSON.stringify([s['box-photo'], s['photo-in-box']]));
  check('a diagram in a flipped card goes dark with it', s['box-diagram'].panel === '8' && s['diagram-in-box'].filter === 'none', JSON.stringify([s['box-diagram'], s['diagram-in-box']]));
  check('a box inside a flipped box is flipped with it, not again', s['box-inner'].panel === null && s['box-inner'].filter === 'none', JSON.stringify(s['box-inner']));
  check('a panel holding only a picture is not a box', s['box-pictures'].panel === null, JSON.stringify(s['box-pictures']));
  check('a button is left as it is', s['box-button'].panel === null && s['box-button'].filter === 'none', JSON.stringify(s['box-button']));
  check('a plain field and select switch to the dark controls', s['field-plain'].field === 'scheme' && s['field-plain'].bgL < 0.4 &&
    s['field-select'].field === 'scheme', JSON.stringify([s['field-plain'], s['field-select']]));
  check('a field the site coloured itself is flipped', s['field-styled'].field === 'flip' && s['field-styled'].filter.startsWith('invert('), JSON.stringify(s['field-styled']));
  check('a consent banner added later is flipped', await waitFor(page, () => getComputedStyle(document.getElementById('banner')).filter.startsWith('invert(')));

  await page.keyboard.down('Alt');
  const peeked = await waitFor(page, () => getComputedStyle(document.getElementById('box-text')).filter === 'none' &&
    getComputedStyle(document.getElementById('field-plain')).backgroundColor === 'rgb(255, 255, 255)', null, 2000);
  await page.keyboard.up('Alt');
  check('holding Alt shows the boxes as they are', peeked, JSON.stringify((await look())['field-plain']));
  check('releasing Alt darkens them again', await waitFor(page, () => getComputedStyle(document.getElementById('box-text')).filter !== 'none'));

  await settings(ctl, { panels: false });
  check('switching off "Darken light boxes" lets them go', await waitFor(page, () => !document.querySelector('[data-inkflip-panel],[data-inkflip-field]')));
  check('…but leaves the pictures to the other switches', (await look())['diagram-in-box'].filter === 'none');
  await settings(ctl, { panels: true });
  check('switching it on finds them again', await waitFor(page, () => getComputedStyle(document.getElementById('box-text')).filter.startsWith('invert(')));
  await page.evaluate(() => window.setTheme('light'));
  check('page turns light → boxes are let go', await waitFor(page, () => !document.querySelector('[data-inkflip-panel],[data-inkflip-field]')));
  await page.evaluate(() => window.setTheme('dark'));
  check('page turns dark again → they return', await waitFor(page, () => getComputedStyle(document.getElementById('box-text')).filter.startsWith('invert(')));
  await context.close();
}

// ------------------------------------------------------- part 2: next to Dark Reader

let haveDr = true;
await access(path.join(DR, 'manifest.json')).catch(() => { haveDr = false; });
if (!part('darkreader')) {
  // skipped
} else if (!haveDr) {
  console.log('\n(skipping Dark Reader checks: unpack its MV3 build into test/.cache/darkreader)');
} else {
  console.log('\nInkflip next to Dark Reader on a light page');
  const { context, id, ctl } = await launch([EXT, DR]);
  const page = await context.newPage();
  await page.goto(BASE + '/page/light');
  check('Dark Reader darkens the page', await waitFor(page, () => {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return c[0] < 60;
  }, null, 10000));
  check('…and Inkflip flips the diagram', await waitFor(page, () => document.getElementById('same-diagram').getAttribute('data-inkflip-l') !== null, null, 10000));
  const dr = await verdictOf(page, 'x-svg');
  check('cross-origin SVG flips under Dark Reader too', dr.v === 'flip' && dr.l !== null, JSON.stringify(dr));
  const photo = await verdictOf(page, 'photo');
  check('photos stay untouched', photo.v === 'none' && photo.filter === 'none', JSON.stringify(photo));
  await page.waitForTimeout(300);
  const f3 = await flashes(page);
  check('no white frame while Dark Reader and Inkflip start together', !Object.keys(f3).length, JSON.stringify(f3));

  const cvPage = await context.newPage();
  await cvPage.goto(BASE + '/canvas/light');
  check('a white canvas chart flips under Dark Reader', await waitFor(cvPage, () => {
    const el = document.getElementById('cv-chart');
    return el.getAttribute('data-inkflip') === 'flip' && getComputedStyle(el).filter.startsWith('invert(');
  }, null, 10000));
  await cvPage.close();

  const chPage = await context.newPage();
  await chPage.goto(BASE + '/charts/light');
  await chPage.waitForTimeout(2500);
  const ch = await chPage.evaluate(() => ['ch-white', 'ch-clear', 'ch-dark'].map((id) => {
    const el = document.getElementById(id);
    return { id, v: el.getAttribute('data-inkflip'), filter: getComputedStyle(el).filter, fill: getComputedStyle(el.querySelector('rect,path')).fill };
  }));
  check('charts Dark Reader darkens are left to it', ch.every((c) => c.filter === 'none'), JSON.stringify(ch));
  // A figure whose boxes Dark Reader keeps light (it takes SVG fills for text): recoloured
  // shape by shape, the boxes it draws with <use> included. Checked on screen.
  const shot = async (id, dx, dy) => {
    const box = await (await chPage.$('#' + id)).boundingBox();
    const buf = await chPage.screenshot({ clip: { x: box.x + dx, y: box.y + dy, width: 1, height: 1 } });
    return ctl.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const g = new OffscreenCanvas(1, 1).getContext('2d');
      g.drawImage(img, 0, 0);
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
      return (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
    }, buf.toString('base64'));
  };
  const boxL = await shot('ch-defs', 52, 100);
  check('a figure\'s light boxes drawn by <use> are made dark', boxL < 0.35, `box lightness ${boxL.toFixed(2)}`);
  const words = await chPage.evaluate(() => getComputedStyle(document.querySelector('#ch-defs text')).fill);
  check('…and its black labels light', (() => { const m = words.match(/[\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.6; })(), words);
  await chPage.close();

  const bxPage = await context.newPage();
  await bxPage.goto(BASE + '/boxes/light');
  await bxPage.waitForTimeout(2500);
  check('where Dark Reader darkens the page, boxes are left to it', await bxPage.evaluate(() => !document.querySelector('[data-inkflip-panel],[data-inkflip-field]')));
  await bxPage.close();

  const pcPage = await context.newPage();
  await pcPage.goto(BASE + '/pictures/light');
  check('a background picture in a style attribute, which Dark Reader leaves, is flipped', await waitFor(pcPage, () =>
    getComputedStyle(document.getElementById('bg-inline')).filter.startsWith('invert('), null, 10000));
  check('…while one from a stylesheet is left to Dark Reader', await pcPage.evaluate(() => getComputedStyle(document.getElementById('bg-diagram')).filter === 'none'));
  await pcPage.close();

  const frPage = await context.newPage();
  await frPage.goto(BASE + '/frames/light');
  const inner = await (await frPage.$('#fr-white')).contentFrame();
  check('Dark Reader darkens a white frame itself', await waitFor(inner, () => {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return c[0] < 60;
  }, null, 10000));
  await frPage.waitForTimeout(1000);
  check('…and Inkflip leaves the frames to it', await frPage.evaluate(() =>
    [...document.querySelectorAll('iframe')].filter((el) => el.id !== 'fr-svg')
      .every((el) => !el.hasAttribute('data-inkflip-l') && getComputedStyle(el).filter === 'none')));
  check('…except SVG files, which it doesn\'t reach', await waitFor(frPage, () =>
    ['fr-svg', 'ob-svg'].every((id) => getComputedStyle(document.getElementById(id)).filter.startsWith('invert('))));
  await frPage.close();

  if (argv.has('--live')) {
    console.log('\nLeetCode 973, Dark Reader + Inkflip');
    const lc = await context.newPage();
    await lc.goto('https://leetcode.com/problems/k-closest-points-to-origin/description/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const sel = 'img[src*="closestplane1"]';
    const found = await lc.waitForSelector(sel, { timeout: 30000 }).then(() => true, () => false);
    check('the diagram is on the page', found, await lc.title());
    if (found) {
      const flipped = await waitFor(lc, (sel) => document.querySelector(sel)?.getAttribute('data-inkflip-l') !== null &&
        document.querySelector(sel)?.getAttribute('data-inkflip') === 'flip', sel, 20000);
      const info = await lc.evaluate((sel) => {
        const el = document.querySelector(sel);
        return { v: el.getAttribute('data-inkflip'), l: el.getAttribute('data-inkflip-l'), filter: getComputedStyle(el).filter };
      }, sel);
      check('Inkflip flips it', flipped, JSON.stringify(info));
      await lc.waitForTimeout(500);
      const lf1 = await flashes(lc);
      check('first visit: the diagram never shows white', !Object.keys(lf1).length, JSON.stringify(lf1));
      await lc.reload({ waitUntil: 'domcontentloaded' });
      await lc.waitForSelector(sel, { timeout: 30000 });
      await waitFor(lc, (sel) => document.querySelector(sel)?.getAttribute('data-inkflip-l') !== null, sel, 20000);
      await lc.waitForTimeout(500);
      const lf2 = await flashes(lc);
      check('reload: the diagram never shows white', !Object.keys(lf2).length, JSON.stringify(lf2));
      if (argv.has('--shots')) {
        await lc.locator(sel).scrollIntoViewIfNeeded();
        await lc.waitForTimeout(800);
        await lc.screenshot({ path: path.join(SHOTS, 'leetcode-after.png') });
        console.log('  · popup:', JSON.stringify(await popupShot(context, id, 'leetcode.com', 'popup-leetcode.png')));
        await settings(ctl, { disabledHosts: ['leetcode.com'] });
        await lc.waitForTimeout(800);
        await lc.screenshot({ path: path.join(SHOTS, 'leetcode-before.png') });
        await settings(ctl, { disabledHosts: [] });
      }
    }
  }
  await context.close();
}

main.close();
other.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
