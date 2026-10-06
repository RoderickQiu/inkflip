/*
 * Inkflip image classifier.
 *
 * Shared by the content script, the service worker and the Node tests. Given the RGBA
 * pixels of an image sampled down to at most 128 px (nearest-neighbour, so hairlines
 * survive), it measures seven signals and returns one verdict:
 *
 *   flip  black-on-white line art (diagrams, plots, text screenshots)
 *   logo  dark ink on a transparent background (invisible on a dark page)
 *   dim   a photo or colourful graphic on white (never flipped: it would look like a negative)
 *   none  everything else
 *
 * A wrong flip is far worse than a missed one, so every uncertain case falls to dim or none.
 * The thresholds come from the labelled set in research/test-images.tsv.
 */
(function (root) {
  'use strict';

  const SAMPLE_MAX = 128;
  const LIGHT = 0.85; // luma at or above this counts as "paper"
  const DARK = 0.35; // luma at or below this counts as "ink"

  /** Size of the sample canvas for an image of w × h: fits in SAMPLE_MAX, keeps aspect. */
  function sampleSize(w, h) {
    const s = Math.min(1, SAMPLE_MAX / Math.max(w, h));
    return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
  }

  /** Signals for an RGBA buffer (Uint8ClampedArray or similar) of w × h pixels. */
  function measure(data, w, h) {
    const n = w * h;
    const Y = new Float32Array(n);
    const buckets = new Uint32Array(4096);
    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    let opaque = 0, light = 0, dark = 0, colorful = 0, border = 0, borderLight = 0;

    for (let i = 0; i < n; i++) {
      const p = i * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2], a = data[p + 3];
      if (a < 128) { Y[i] = -1; continue; }
      opaque++;
      const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      Y[i] = y;
      if (y >= LIGHT) {
        light++;
      } else {
        buckets[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
        if (y <= DARK) dark++;
        if ((Math.max(r, g, b) - Math.min(r, g, b)) / 255 >= 0.25) colorful++;
      }
      const x = i % w, row = (i / w) | 0;
      if (x < ring || row < ring || x >= w - ring || row >= h - ring) {
        border++;
        if (y >= LIGHT) borderLight++;
      }
    }

    // Foreground palette: how many of the 4096 colour buckets cover 90% of the non-paper
    // pixels. Diagrams use a handful; photos use dozens.
    const counts = [];
    for (let k = 0; k < 4096; k++) if (buckets[k]) counts.push(buckets[k]);
    counts.sort((a, b) => b - a);
    const total = counts.reduce((s, v) => s + v, 0);
    let acc = 0, fg90 = 0;
    for (const v of counts) {
      if (acc >= 0.9 * total) break;
      acc += v;
      fg90++;
    }

    // Continuous tone: among neighbouring pairs that touch the foreground, the share whose
    // brightness step is small but non-zero, i.e. a gradient. Flat graphics are either
    // perfectly flat or hard edges; photos are full of gentle steps.
    let pairs = 0, gentle = 0;
    const step = (yi, yj) => {
      if (yj < 0 || (yi >= LIGHT && yj >= LIGHT)) return;
      pairs++;
      const d = Math.abs(yi - yj);
      if (d >= 0.012 && d < 0.10) gentle++;
    };
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < w; x++) {
        const i = row * w + x, yi = Y[i];
        if (yi < 0) continue;
        if (x + 1 < w) step(yi, Y[i + 1]);
        if (row + 1 < h) step(yi, Y[i + w]);
      }
    }

    const o = Math.max(opaque, 1);
    return {
      transp: 1 - opaque / n,
      light: light / o,
      dark: dark / o,
      color: colorful / o,
      fg90,
      tone: gentle / Math.max(pairs, 1),
      border: borderLight / Math.max(border, 1),
    };
  }

  /** Verdict for a set of signals. */
  function decide(s) {
    const photo = s.tone >= 0.30 || s.fg90 >= 40;
    if (s.transp >= 0.2) {
      // Cut-out image: only rescue it if it is plain dark ink.
      return s.dark >= 0.6 && s.color <= 0.1 && !photo ? 'logo' : 'none';
    }
    if (s.light >= 0.5 && s.border >= 0.6) {
      // Sits on white paper.
      if (photo) return 'dim';
      return s.color <= 0.30 ? 'flip' : 'dim';
    }
    if (s.light >= 0.4 && !photo) return 'dim'; // light flat graphic with colour at the edges
    return 'none';
  }

  function classify(data, w, h) {
    const signals = measure(data, w, h);
    return { verdict: decide(signals), signals };
  }

  const api = { SAMPLE_MAX, LIGHT, DARK, sampleSize, measure, decide, classify };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InkflipClassifier = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
