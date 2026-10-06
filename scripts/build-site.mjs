// Renders the social preview image (site/og.png, 1200×630) from the real before/after pair.
//
//   npm run site      (packages the zip into site/download/inkflip.zip first)
//
// Deploys happen on push: the Vercel project has Root Directory `site`, and site/vercel.json
// holds its install and build commands, which package the zip. For a manual deploy run
// `vercel deploy --prod` from the repo root, never from site/.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../test/lib.mjs';

const data = async (rel, type) => `data:${type};base64,` + (await readFile(path.join(root, rel))).toString('base64');
const icon = await data('site/img/icon.svg', 'image/svg+xml');
const before = await data('site/img/flow-network-before.jpg', 'image/jpeg');
const after = await data('site/img/flow-network-after.jpg', 'image/jpeg');
const font = await data('site/fonts/atkinson-next-800.woff2', 'font/woff2');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(`<style>
  @font-face{font-family:A;src:url(${font})}
  html,body{margin:0}
  body{width:1200px;height:630px;background:#181a1b;color:#e8e6e3;font-family:A,system-ui;display:grid;
    grid-template-columns:520px 1fr;gap:40px;align-items:center;padding:0 56px;box-sizing:border-box}
  .brand{display:flex;align-items:center;gap:14px;font-size:30px;margin-bottom:28px}
  .brand img{width:46px;height:46px}
  h1{margin:0;font-size:58px;line-height:1.04;letter-spacing:-.03em}
  .pair{position:relative;border-radius:14px;overflow:hidden;border:1px solid #31353a;aspect-ratio:1096/654}
  .pair img{position:absolute;inset:0;width:100%;height:100%}
  .pair .a{clip-path:inset(0 0 0 42%)}
  .pair i{position:absolute;top:0;bottom:0;left:42%;width:3px;margin-left:-1px;background:#f2b45a}
</style>
<div><div class="brand"><img src="${icon}">Inkflip</div><h1>Dark mode for the images Dark Reader leaves white</h1></div>
<div class="pair"><img src="${before}"><img class="a" src="${after}"><i></i></div>`, { waitUntil: 'load' });
await page.screenshot({ path: path.join(root, 'site/og.png') });
await browser.close();
console.log('site/og.png');
