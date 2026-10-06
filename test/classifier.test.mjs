// Unit tests for the classifier on synthetic images: no browser, no network.
// Real-world images are covered by test/real-images.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const C = createRequire(import.meta.url)('../extension/classifier.js');

// ------------------------------------------------------------------ tiny raster kit

function image(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { w, h, data };
}

function put(img, x, y, rgba) {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  img.data.set(rgba.length === 3 ? [...rgba, 255] : rgba, (y * img.w + x) * 4);
}

function rect(img, x0, y0, x1, y1, rgba) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(img, x, y, rgba);
}

function line(img, x0, y0, x1, y1, rgba, width = 1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n);
    rect(img, x - (width >> 1), y - (width >> 1), x + (width >> 1) + 1, y + (width >> 1) + 1, rgba);
  }
}

function ring(img, cx, cy, radius, rgba) {
  for (let t = 0; t < 360; t += 2) {
    put(img, Math.round(cx + radius * Math.cos((t * Math.PI) / 180)), Math.round(cy + radius * Math.sin((t * Math.PI) / 180)), rgba);
  }
}

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** Light JPEG-style noise and ringing: near-white wobble, grey halo next to ink. */
function jpegify(img) {
  const out = new Uint8ClampedArray(img.data);
  for (let y = 1; y < img.h - 1; y++) {
    for (let x = 1; x < img.w - 1; x++) {
      const i = (y * img.w + x) * 4;
      const v = img.data[i];
      const nearInk = [-1, 1].some((d) => img.data[i + d * 4] < 100 || img.data[i + d * img.w * 4] < 100);
      const n = v > 200 && nearInk ? 200 + rand() * 40 : v + (rand() - 0.5) * 6;
      out[i] = out[i + 1] = out[i + 2] = n;
    }
  }
  return { ...img, data: out };
}

const verdict = (img) => C.classify(img.data, img.w, img.h).verdict;

// ---------------------------------------------------------------------- fixtures

function plotDiagram() {
  // Axes, ticks and two points: the LeetCode 973 picture in miniature.
  const img = image(128, 128, [255, 255, 255]);
  const ink = [20, 20, 20];
  line(img, 8, 64, 120, 64, ink);
  line(img, 64, 8, 64, 120, ink);
  for (let t = 16; t <= 112; t += 12) { line(img, t, 62, t, 66, ink); line(img, 62, t, 66, t, ink); }
  ring(img, 46, 46, 3, ink);
  ring(img, 76, 40, 3, ink);
  return img;
}

function photo() {
  // Smooth colour gradients with sensor noise, mostly mid-to-dark tones.
  const img = image(128, 96, [0, 0, 0]);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 128; x++) {
      const base = 40 + 90 * Math.sin(x / 23) * Math.cos(y / 17) ** 2 + x * 0.4;
      put(img, x, y, [base + 30 + rand() * 8, base + rand() * 8, base * 0.6 + rand() * 8]);
    }
  }
  return img;
}

function productOnWhite() {
  // A shaded object on a white studio backdrop.
  const img = image(128, 128, [255, 255, 255]);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const dx = (x - 64) / 40, dy = (y - 70) / 30;
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        const shade = 30 + 160 * (1 - d) * (0.6 + 0.4 * (x / 128)) + rand() * 10;
        put(img, x, y, [shade, shade * 0.85, shade * 0.3]);
      }
    }
  }
  return img;
}

function transparentLogo() {
  const img = image(96, 96, [0, 0, 0, 0]);
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) if ((x - 48) ** 2 + (y - 48) ** 2 < 34 ** 2) put(img, x, y, [24, 24, 28]);
  }
  rect(img, 40, 30, 56, 66, [0, 0, 0, 0]); // a cut-out so it isn't a plain disc
  return img;
}

function infographic() {
  const img = image(128, 128, [255, 255, 255]);
  rect(img, 10, 10, 60, 60, [220, 40, 40]);
  rect(img, 68, 10, 118, 60, [30, 90, 220]);
  rect(img, 10, 68, 118, 100, [240, 170, 20]);
  return img;
}

function darkScreenshot() {
  const img = image(128, 80, [24, 26, 30]);
  for (let y = 10; y < 70; y += 8) rect(img, 10, y, 10 + ((y * 7) % 90), y + 3, [200, 200, 200]);
  return img;
}

function whiteProductRender() {
  // A white bookcase rendered on white: soft grey shading, no dark ink at all (IKEA).
  const img = image(128, 128, [255, 255, 255]);
  for (let y = 12; y < 120; y++) {
    for (let x = 44; x < 84; x++) {
      const v = 200 + 30 * Math.sin(x / 9) + (y % 18 < 2 ? -12 : 0) + rand() * 4;
      put(img, x, y, [v, v, v - 2]);
    }
  }
  return img;
}

function transparentGraph({ fill, edge = [10, 10, 10] }) {
  // Nodes and edges on a transparent canvas, drawn for white paper (cp-algorithms, Wikipedia).
  const img = image(128, 96, [0, 0, 0, 0]);
  const nodes = [[20, 48], [64, 16], [64, 80], [108, 48]];
  for (const [a, b] of [[0, 1], [0, 2], [1, 3], [2, 3], [1, 2]]) {
    line(img, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], edge, 3);
  }
  for (const [cx, cy] of nodes) {
    for (let y = -10; y <= 10; y++) for (let x = -10; x <= 10; x++) if (x * x + y * y <= 100) put(img, cx + x, cy + y, fill);
    ring(img, cx, cy, 10, edge);
  }
  return img;
}

function whiteLogo() {
  // A white logo made for dark backgrounds: no ink, must stay as it is.
  const img = image(128, 64, [0, 0, 0, 0]);
  rect(img, 10, 16, 40, 48, [255, 255, 255]);
  rect(img, 50, 24, 118, 40, [250, 250, 250]);
  return img;
}

function heatmap() {
  // Pastel cells reaching the edges: lightness encodes the data.
  const img = image(120, 120, [255, 255, 255]);
  const cells = [[250, 235, 235], [240, 190, 180], [200, 40, 40], [215, 230, 245], [245, 245, 245], [230, 120, 100]];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) rect(img, c * 20, r * 20, c * 20 + 20, r * 20 + 20, cells[(r * 7 + c * 3) % 6]);
  return img;
}

// ------------------------------------------------------------------------- tests

test('black-on-white diagram flips', () => {
  assert.equal(verdict(plotDiagram()), 'flip');
});

test('the same diagram saved as a noisy JPEG still flips', () => {
  assert.equal(verdict(jpegify(plotDiagram())), 'flip');
});

test('a photo is left alone', () => {
  assert.equal(verdict(photo()), 'none');
});

test('a photo on a white backdrop is dimmed, never flipped', () => {
  const s = C.measure(productOnWhite().data, 128, 128);
  assert.ok(s.tone >= 0.3 || s.fg90 >= 40, `photo signal missing: ${JSON.stringify(s)}`);
  assert.equal(C.decide(s), 'dim');
});

test('dark ink on a transparent background is a logo', () => {
  assert.equal(verdict(transparentLogo()), 'logo');
});

test('a colourful infographic on white is dimmed, not flipped', () => {
  assert.equal(verdict(infographic()), 'dim');
});

test('an image that is already dark is left alone', () => {
  assert.equal(verdict(darkScreenshot()), 'none');
});

test('a fully transparent image is left alone', () => {
  assert.equal(verdict(image(32, 32, [0, 0, 0, 0])), 'none');
});

test('a white product rendered on white is dimmed, never flipped', () => {
  const s = C.measure(whiteProductRender().data, 128, 128);
  assert.ok(s.dark < 0.01, JSON.stringify(s));
  assert.equal(C.decide(s), 'dim');
});

test('a transparent diagram with light nodes and black edges is flipped', () => {
  assert.equal(verdict(transparentGraph({ fill: [235, 235, 235] })), 'flip');
});

test('coloured nodes with black edges on transparent are brightened', () => {
  assert.equal(verdict(transparentGraph({ fill: [30, 60, 200] })), 'logo');
});

test('a white logo on transparent is left alone', () => {
  assert.equal(verdict(whiteLogo()), 'none');
});

test('a heatmap is dimmed, not flipped', () => {
  assert.equal(verdict(heatmap()), 'dim');
});

test('sampleSize keeps aspect ratio and caps at 128', () => {
  assert.deepEqual(C.sampleSize(939, 939), [128, 128]);
  assert.deepEqual(C.sampleSize(1306, 275), [128, 27]);
  assert.deepEqual(C.sampleSize(60, 40), [60, 40]);
  assert.deepEqual(C.sampleSize(5000, 1), [128, 1]);
});

test('decide: the photo guard wins over every flip condition', () => {
  const paper = { transp: 0, light: 0.9, border: 1, dark: 0.05, color: 0, fg90: 10, tone: 0.05 };
  assert.equal(C.decide(paper), 'flip');
  assert.equal(C.decide({ ...paper, tone: 0.31 }), 'dim');
  assert.equal(C.decide({ ...paper, fg90: 40 }), 'dim');
  assert.equal(C.decide({ ...paper, transp: 0.5, dark: 0.9, light: 0, tone: 0.31 }), 'none');
});
