// Composes the README hero and the Chrome Web Store images from the real screenshots that
// `node test/e2e.mjs --live --shots` writes into docs/images. dist/store holds everything the
// store listing needs; the numbers in the file names are the upload order.
//
//   docs/images/hero.png             README header (from site/img, see scripts/capture-showcase.mjs)
//   dist/store/1-leetcode.jpg        1280×800, LeetCode before / after (Chrome Web Store)
//   dist/store/4-popup.jpg           1280×800, the popup and verdict badges
//   dist/store/promo-440x280.png     small promo tile
//   dist/store/icon-128.png          store icon, copied from the extension
import { chromium } from 'playwright';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const img = async (rel) => 'data:image/png;base64,' + (await readFile(path.join(root, rel))).toString('base64');
const icon = 'data:image/svg+xml;base64,' + (await readFile(path.join(root, 'extension/icons/icon.svg'))).toString('base64');

const before = await img('docs/images/leetcode-before.png');
const after = await img('docs/images/leetcode-after.png');
const popup = await img('docs/images/popup-leetcode.png');
const badges = await img('docs/images/badges.png');
const jpg = async (rel) => 'data:image/jpeg;base64,' + (await readFile(path.join(root, rel))).toString('base64');
const flowBefore = await jpg('site/img/flow-network-before.jpg');
const flowAfter = await jpg('site/img/flow-network-after.jpg');

// A window onto a 1440×900 (CSS px) screenshot: region x,y,w,h shown at scale s.
const crop = (src, x, y, w, h, s) =>
  `<div class="shot" style="width:${w * s}px;height:${h * s}px;background-image:url(${src});` +
  `background-size:${1440 * s}px ${900 * s}px;background-position:-${x * s}px -${y * s}px"></div>`;

const base = `
  *{box-sizing:border-box} html,body{margin:0}
  body{background:#0e0f11;color:#ecebe8;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  .shot{border-radius:12px;background-repeat:no-repeat;box-shadow:0 0 0 1px #2a2e34,0 18px 50px #0009}
  .label{font-size:14px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9da1a8;margin:0 0 12px 2px}
  .label b{color:#f2b45a;font-weight:600}
  .brand{display:flex;align-items:center;gap:14px}
  .brand img{width:52px;height:52px}
  .brand h1{margin:0;font-size:34px;font-weight:700;letter-spacing:-.02em}
  .brand p{margin:2px 0 0;color:#9da1a8;font-size:17px}
`;

const pages = {
  'docs/images/hero.png': {
    w: 1400, h: 470, scale: 1.5, html: `
    <style>${base} body{background:#181a1b} .wrap{padding:40px 48px}
      .label{text-transform:none;letter-spacing:0;font-size:17px;color:#c4c0ba}
      .row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:30px}
      .row .shot{border-radius:12px}</style>
    <div class="wrap">
      <div class="row" style="margin-top:0">
        <div><div class="label">Dark Reader alone</div><img class="shot" style="width:100%;display:block" src="${flowBefore}"></div>
        <div><div class="label">Dark Reader <b>+ Inkflip</b></div><img class="shot" style="width:100%;display:block" src="${flowAfter}"></div>
      </div>
    </div>`,
  },
  'dist/store/1-leetcode.jpg': {
    w: 1280, h: 800, scale: 1, html: `
    <style>${base} .wrap{padding:40px 48px} .row{display:flex;gap:32px;margin-top:30px}
      h2{margin:26px 0 0;font-size:19px;font-weight:500;color:#c9c6c0}</style>
    <div class="wrap">
      <div class="brand"><img src="${icon}"><div><h1>White diagrams, gone</h1><p>LeetCode with Dark Reader: before and after Inkflip</p></div></div>
      <div class="row">
        <div><div class="label">Dark Reader alone</div>${crop(before, 10, 395, 560, 470, 1.0)}</div>
        <div><div class="label">Dark Reader <b>+ Inkflip</b></div>${crop(after, 10, 395, 560, 470, 1.0)}</div>
      </div>
    </div>`,
  },
  'dist/store/4-popup.jpg': {
    w: 1280, h: 800, scale: 1, html: `
    <style>${base} .wrap{padding:40px 48px} .row{display:flex;gap:36px;margin-top:30px;align-items:flex-start}
      .pop{width:330px;border-radius:14px;box-shadow:0 0 0 1px #2a2e34,0 18px 50px #0009}</style>
    <div class="wrap">
      <div class="brand"><img src="${icon}"><div><h1>Diagrams flip. Photos never do.</h1><p>Each image is checked on its own; right-click to correct any call</p></div></div>
      <div class="row">
        ${crop(badges, 36, 96, 934, 600, 0.84)}
        <img class="pop" src="${popup}" style="width:286px">
      </div>
    </div>`,
  },
  'dist/store/promo-440x280.png': {
    w: 440, h: 280, scale: 1, html: `
    <style>${base} body{display:flex;align-items:center;justify-content:center;height:280px;
      background:radial-gradient(120% 140% at 0% 0%,#1d1f23 0%,#0e0f11 60%)}
      .brand img{width:64px;height:64px} .brand h1{font-size:38px} .brand p{font-size:15px;max-width:230px}</style>
    <div class="brand"><img src="${icon}"><div><h1>Inkflip</h1><p>Turns white-background diagrams dark. Works with Dark Reader.</p></div></div>`,
  },
};

await mkdir(path.join(root, 'dist/store'), { recursive: true });
await copyFile(path.join(root, 'extension/icons/icon-128.png'), path.join(root, 'dist/store/icon-128.png'));
const browser = await chromium.launch();
for (const [out, { w, h, scale, html }] of Object.entries(pages)) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: 'load' });
  const jpeg = out.endsWith('.jpg');
  await page.screenshot({ path: path.join(root, out), type: jpeg ? 'jpeg' : 'png', quality: jpeg ? 92 : undefined });
  await page.close();
  console.log(out);
}
await browser.close();
