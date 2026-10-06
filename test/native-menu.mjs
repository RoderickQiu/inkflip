// Checks Chrome's real right-click menu, which headless Chrome never draws (test/e2e.mjs can
// only call the menu's click handler). Runs headed Chromium on a virtual screen inside a Linux
// container, so nothing appears on your screen and nothing takes focus. It right-clicks the
// page, photographs the screen, reads the menu with OCR, clicks the entries with a real
// mouse (xdotool), and checks that the page changed.
//
//   npm run test:menu          needs Docker; screenshots go to screenshots/menu-*.png
//
// On the host this builds the image in test/native-menu/ (once) and runs itself inside it.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

if (!process.argv.includes('--inside')) {
  const { version } = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("playwright/package.json"))'], { cwd: root }));
  const tag = `inkflip-menu-test:${version}`;
  if (spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status !== 0) {
    execFileSync('docker', ['build', '-t', tag, '--build-arg', `PW=${version}`, path.join(root, 'test/native-menu')], { stdio: 'inherit' });
  }
  const run = spawnSync('docker', ['run', '--rm', '--init', '--ipc=host', '-v', `${root}:/work`, '-w', '/work', tag,
    'timeout', '300', 'node', 'test/native-menu.mjs', '--inside'], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

// ------------------------------------------------------------------ inside the container

const { chromium } = await import('playwright');
const { createServer } = await import('node:http');
const { readFile, mkdtemp, access } = await import('node:fs/promises');
const { spawn } = await import('node:child_process');
const os = await import('node:os');

// The virtual screen. Started here rather than with xvfb-run, whose start-up handshake
// sometimes never arrives when it runs as a container's first process.
const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
for (let i = 0; i < 100 && !(await access('/tmp/.X11-unix/X99').then(() => true, () => false)); i++) {
  await new Promise((r) => setTimeout(r, 100));
}
process.env.DISPLAY = ':99';

const EXT = path.join(root, 'extension');
const SHOTS = path.join(root, 'screenshots');
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

// The page must not contain the extension's name anywhere: the OCR looks for it in the menu.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Menu check</title><style>
body{margin:0;padding:24px 30px;background:#181a1b;color:#e8e6e3;font:15px system-ui,sans-serif}
.row{display:flex;gap:24px;margin-bottom:24px} figure{margin:0;position:relative}
canvas,img,video{display:block;width:280px;height:160px;object-fit:contain}
.layer{position:absolute;inset:0} .strip{position:absolute;left:0;right:0;top:0;height:40px}
</style></head><body>
<p id="text">Plain text, far from any picture.</p>
<div class="row">
  <figure><img id="img" src="/lc_tree.jpg"></figure>
  <figure><canvas id="cv" width="560" height="320"></canvas></figure>
  <figure><canvas id="cv2" width="560" height="320"></canvas><div class="layer"></div></figure>
  <figure><video id="vid" muted autoplay></video><div class="strip"></div></figure>
</div>
<script>
for (const id of ['cv', 'cv2']) {
  const c = document.getElementById(id), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 560, 320);
  g.strokeStyle = '#000'; g.lineWidth = 5; g.beginPath();
  g.moveTo(30, 290); g.lineTo(540, 290); g.moveTo(30, 290); g.lineTo(30, 20);
  [[30, 250], [150, 170], [270, 210], [390, 90], [530, 60]].forEach(([x, y]) => g.lineTo(x, y));
  g.stroke();
}
const s = document.createElement('canvas'); s.width = 640; s.height = 360;
const sg = s.getContext('2d');
(function slide() {
  sg.fillStyle = '#fff'; sg.fillRect(0, 0, 640, 360);
  sg.fillStyle = '#000'; sg.fillRect(40, 60, 420, 30); sg.fillRect(40, 130, 300, 14);
  requestAnimationFrame(slide);
})();
const v = document.getElementById('vid'); v.srcObject = s.captureStream(30); v.play().catch(() => {});
</script></body></html>`;

const server = await new Promise((resolve) => {
  const s = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(PAGE); }
    readFile(path.join(root, 'test/.cache/images', path.basename(req.url)))
      .then((b) => res.end(b), () => { res.statusCode = 404; res.end(); });
  }).listen(0, '127.0.0.1', () => resolve(s));
});
const BASE = `http://127.0.0.1:${server.address().port}`;

const context = await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(), 'menu-')), {
  channel: 'chromium', headless: false, viewport: null, timeout: 60000,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--window-position=0,0', '--window-size=1440,900', '--lang=en-US'],
});
const page = context.pages()[0] || await context.newPage();
await page.goto(BASE + '/');
await page.waitForFunction(() => document.getElementById('cv').getAttribute('data-inkflip') === 'flip', null, { timeout: 15000 });
const top = await page.evaluate(() => outerHeight - innerHeight); // browser chrome above the page

function grab(name) {
  const file = `/tmp/${name}.png`;
  sh('import', ['-window', 'root', file]);
  return file;
}

/**
 * The words of whatever appeared on screen between two screenshots (a menu, a submenu),
 * grouped into lines, in screen pixels. Reading only that region keeps the page behind it
 * (a flipped chart, say) from confusing the OCR.
 */
function readMenu(before, name) {
  const file = grab(name);
  const box = sh('convert', [before, file, '-compose', 'difference', '-composite',
    '-colorspace', 'Gray', '-threshold', '4%', '-format', '%@', 'info:']).trim();
  const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(box);
  const [w, h, x0, y0] = m && +m[1] > 20 ? m.slice(1).map(Number) : [1440, 900, 0, 0];
  const S = 3;
  sh('convert', [file, '-crop', `${w}x${h}+${x0}+${y0}`, '+repage', '-resize', `${S * 100}%`, '-colorspace', 'Gray', '/tmp/ocr.png']);
  const ocr = (img) => sh('tesseract', [img, '-', '--psm', '11', 'tsv']).trim().split('\n').slice(1)
    .map((l) => l.split('\t')).filter((c) => c.length >= 12 && c[11].trim())
    .map((c) => ({ text: c[11].trim(), conf: +c[10], left: +c[6], x: x0 + (+c[6] + +c[8] / 2) / S, y: y0 + (+c[7] + +c[9] / 2) / S }));
  let words = ocr('/tmp/ocr.png');
  // Menu labels line up in one column; an icon just left of a label garbles it ("44 nkflip").
  // White out everything left of that column and read again.
  const lefts = words.filter((w) => w.conf > 80).map((w) => w.left);
  if (lefts.length) {
    sh('convert', ['/tmp/ocr.png', '-fill', 'white', '-draw', `rectangle 0,0 ${Math.max(0, Math.min(...lefts) - 8)},${h * S}`, '/tmp/ocr.png']);
    words = ocr('/tmp/ocr.png');
  }
  words = words.filter((w) => w.conf > 30);
  // Rebuild menu lines: words whose centres sit within 8 px vertically, left to right.
  const lines = [];
  for (const w of words.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => Math.abs(l.y - w.y) < 8);
    if (line) line.words.push(w);
    else lines.push({ y: w.y, words: [w] });
  }
  for (const l of lines) {
    l.words.sort((a, b) => a.x - b.x);
    l.text = l.words.map((w) => w.text).join(' ');
    l.x = l.words[0].x;
  }
  return { file, lines: lines.filter((l) => /[A-Za-z]{2}/.test(l.text)) };
}

const find = (screen, re) => screen.lines.find((l) => re.test(l.text));

async function centre(id, fy = 0.5) {
  const b = await page.locator('#' + id).boundingBox();
  return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height * fy)];
}

/** Hover, then right-click for real, and read the menu Chrome draws. */
async function openMenu(id, fy, name) {
  const [x, y] = await centre(id, fy);
  await page.mouse.move(x - 4, y);
  await page.mouse.move(x, y);
  await sleep(500); // the pointer report reaches the service worker
  const before = grab(name + '-before');
  sh('xdotool', ['mousemove', String(x), String(y + top)]);
  sh('xdotool', ['click', '3']);
  await sleep(700);
  return readMenu(before, name);
}

const closeMenu = async () => { sh('xdotool', ['key', 'Escape']); await sleep(200); sh('xdotool', ['key', 'Escape']); await sleep(300); };
const clickLine = async (line) => {
  const w = line.words[0];
  sh('xdotool', ['mousemove', String(Math.round(w.x)), String(Math.round(w.y))]);
  await sleep(150);
  sh('xdotool', ['click', '1']);
  await sleep(900);
};
const state = (id) => page.evaluate((id) => {
  const el = document.getElementById(id);
  return { v: el.getAttribute('data-inkflip'), filter: getComputedStyle(el).filter };
}, id);

/** Right-click an element, pick Inkflip › entry, and return what the element became. */
async function choose(id, fy, entry, name) {
  const menu = await openMenu(id, fy, name + '-menu');
  const ink = find(menu, /^Inkflip$/);
  if (!ink) { await closeMenu(); return { error: 'no Inkflip entry', lines: menu.lines.map((l) => l.text) }; }
  await clickLine(ink);
  const sub = readMenu(menu.file, name + '-submenu');
  sh('cp', [sub.file, path.join(SHOTS, `menu-${name}.png`)]);
  const item = find(sub, entry);
  if (!item) { await closeMenu(); return { error: 'no entry ' + entry, lines: sub.lines.map((l) => l.text) }; }
  await clickLine(item);
  await sleep(600);
  return state(id);
}

console.log('Chrome\'s real right-click menu, headed Chromium on a virtual screen');

const where = [
  ['text', 0.5, false, 'plain text: no Inkflip entry'],
  ['img', 0.5, true, 'an image: one "Inkflip" entry, not nested under the extension name'],
  ['cv', 0.5, true, 'a canvas: one "Inkflip" entry'],
  ['cv2', 0.5, true, 'a canvas under a transparent layer: one "Inkflip" entry'],
  ['vid', 0.8, true, 'a video: one "Inkflip" entry'],
  ['vid', 0.1, true, 'a video under a transparent strip: one "Inkflip" entry'],
];
for (const [id, fy, want, label] of where) {
  const menu = await openMenu(id, fy, `open-${id}`);
  const ink = menu.lines.filter((l) => /\bInkflip\b/.test(l.text));
  const grouped = menu.lines.some((l) => /Dark Mode for Images/.test(l.text));
  const ok = want ? ink.length === 1 && /^Inkflip$/.test(ink[0].text) && !grouped : ink.length === 0;
  check(label, ok, menu.lines.map((l) => l.text).join(' | '));
  if (id === 'cv') sh('cp', [menu.file, path.join(SHOTS, 'menu-canvas.png')]);
  await closeMenu();
}

let s = await choose('cv', 0.5, /^Show this image as is/, 'canvas-show');
check('canvas › Inkflip › Show this image as is', s.v === 'none' && s.filter === 'none', JSON.stringify(s));
s = await choose('cv', 0.5, /^Let Inkflip decide/, 'canvas-auto');
check('canvas › Inkflip › Let Inkflip decide', s.v === 'flip' && s.filter.startsWith('invert('), JSON.stringify(s));
s = await choose('vid', 0.8, /^Flip this video/, 'video-flip');
check('video › Inkflip › Flip this video', s.v === 'flip' && s.filter.startsWith('invert('), JSON.stringify(s));
s = await choose('img', 0.5, /^Show this image as is/, 'image-show');
check('image › Inkflip › Show this image as is', s.v === 'none' && s.filter === 'none', JSON.stringify(s));
s = await choose('cv2', 0.5, /^Dim this image/, 'covered-dim');
check('covered canvas › Inkflip › Dim this image', s.v === 'dim' && s.filter.startsWith('brightness('), JSON.stringify(s));

await context.close();
server.close();
xvfb.kill();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
