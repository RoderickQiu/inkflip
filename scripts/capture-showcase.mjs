// Captures the before/after pairs used on the website and in the README: each page is
// loaded headless with Dark Reader + Inkflip (dark OS scheme), the chosen image is framed,
// and the same region is captured at 2× with Inkflip on (after) and off (before).
//
//   node scripts/capture-showcase.mjs [id ...]       → site/img/<id>-before.jpg, <id>-after.jpg
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { root, EXT, DR, launch, settings, waitFor } from '../test/lib.mjs';

const SHOWCASE = [
  { id: 'transformer', url: 'https://arxiv.org/html/1706.03762v7', pick: 'ModalNet-21', pad: 28 },
  { id: 'flow-network', url: 'https://cp-algorithms.com/graph/edmonds_karp.html', pick: 'Flow1.png', pad: 24 },
  { id: 'readme-logo', url: 'https://github.com/cosmos/gravity-bridge', pick: 'gravity', pad: 28 },
  { id: 'leetcode', url: 'https://leetcode.com/problems/k-closest-points-to-origin/description/', pick: 'closestplane1', pad: 24 },
  { id: 'sequence-diagram', url: 'https://stulle123.github.io/posts/kakaotalk/secret-chat/', pick: 'e2e.svg', pad: 20 },
];

const only = process.argv.slice(2);
const OUT = path.join(root, 'site/img');
await mkdir(OUT, { recursive: true });
const env = await launch([EXT, DR], { colorScheme: 'dark' });
const { context, ctl } = env;

for (const s of SHOWCASE.filter((s) => !only.length || only.includes(s.id))) {
  const page = await context.newPage();
  await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  const sel = `img[src*="${s.pick}"]`;
  await page.waitForSelector(sel, { timeout: 20000 }).catch(() => {});
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), sel);
  const ok = await waitFor(page, (sel) => document.querySelector(sel)?.hasAttribute('data-inkflip-l'), sel, 15000);
  await page.waitForTimeout(900);
  const box = await page.evaluate(({ sel, pad }) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
    // The capture clip is in page coordinates, not viewport coordinates.
    return { x: x + scrollX, y: y + scrollY, width: Math.min(innerWidth, r.right + pad) - x, height: Math.min(innerHeight, r.bottom + pad) - y, scale: 2 };
  }, { sel, pad: s.pad });
  const cdp = await context.newCDPSession(page);
  const shoot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88, clip: box });
    await writeFile(path.join(OUT, `${s.id}-${name}.jpg`), Buffer.from(data, 'base64'));
  };
  await shoot('after');
  await settings(ctl, { disabledHosts: [new URL(s.url).hostname] });
  await page.waitForTimeout(700);
  await shoot('before');
  await settings(ctl, { disabledHosts: [] });
  console.log(`${s.id.padEnd(18)} ${ok ? 'flipped' : 'NOT FLIPPED'}  ${Math.round(box.width)}×${Math.round(box.height)} css px`);
  await page.close();
}
await context.close();
