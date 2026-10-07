/*
 * Inkflip image classifier.
 *
 * Shared by the content script, the service worker and the Node tests. Given the RGBA
 * pixels of an image sampled down to at most 128 px (nearest-neighbour, so hairlines
 * survive), it measures ten signals and returns one verdict:
 *
 *   flip  black-on-white line art (diagrams, plots, text screenshots)
 *   logo  dark ink on a transparent background (invisible on a dark page)
 *   dim   a photo or colourful graphic on white (never flipped: it would look like a negative)
 *   none  everything else
 *
 * A wrong flip is far worse than a missed one, so every uncertain case falls to dim or none.
 * The thresholds come from labelled real images: research/test-images.tsv (21) and
 * research/field-labels.tsv (393, from 48 field-tested pages; score with research/eval.mjs).
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

  /**
   * Pixels of a decoded image (img element, ImageBitmap, canvas) sampled down to at most
   * SAMPLE_MAX, nearest-neighbour. Vector images (`crisp`) are first rendered at their natural
   * size: drawn straight at 128 px their thin strokes would be anti-aliased into soft grey
   * gradients that look like a photograph. Throws a SecurityError if the source is tainted.
   */
  function pixels(source, w, h, crisp) {
    const [tw, th] = sampleSize(w, h);
    let src = source;
    if (crisp) {
      const s = Math.min(1, 2048 / Math.max(w, h));
      src = new OffscreenCanvas(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
      src.getContext('2d').drawImage(source, 0, 0, src.width, src.height);
    }
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, tw, th);
    return { data: ctx.getImageData(0, 0, tw, th).data, w: tw, h: th };
  }

  /** Signals for an RGBA buffer (Uint8ClampedArray or similar) of w × h pixels. */
  function measure(data, w, h) {
    const n = w * h;
    const Y = new Float32Array(n);
    const buckets = new Uint32Array(4096);
    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    let opaque = 0, light = 0, dark = 0, grey = 0, colorful = 0, border = 0, borderLight = 0;

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
        const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        if (y <= DARK) dark++;
        else if (sat < 0.1) grey++;
        if (sat >= 0.25) colorful++;
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

    // Outline: opaque pixels next to a transparent one, i.e. what meets the page's backdrop.
    // A white logo meets it in white; a diagram drawn for white paper, in dark lines.
    let edge = 0, edgeLight = 0;
    for (let row = 0; row < h; row++) {
      for (let x = 0; x < w; x++) {
        const i = row * w + x, yi = Y[i];
        if (yi < 0) continue;
        if ((x > 0 && Y[i - 1] < 0) || (x + 1 < w && Y[i + 1] < 0) ||
            (row > 0 && Y[i - w] < 0) || (row + 1 < h && Y[i + w] < 0)) {
          edge++;
          if (yi >= LIGHT) edgeLight++;
        }
      }
    }

    const o = Math.max(opaque, 1);
    return {
      transp: 1 - opaque / n,
      light: light / o,
      dark: dark / o,
      grey: grey / o, // neutral mid-tones: grey lines and labels
      color: colorful / o,
      fg90,
      tone: gentle / Math.max(pairs, 1),
      border: borderLight / Math.max(border, 1),
      rim: edgeLight / Math.max(edge, 1), // share of the outline that is light
      outline: edge / o, // share of the picture on its outline: thin strokes high, solid panels low
    };
  }

  /** Verdict for a set of signals. */
  function decide(s) {
    // Photos: continuous tone or a rich palette. With no dark ink at all (a white product on
    // white, say), even mild shading is enough: diagrams always carry some ink.
    const photo = s.tone >= 0.30 || s.fg90 >= 40 || (s.dark < 0.01 && s.tone >= 0.15);
    // A black-and-white or sepia photograph (a team portrait): with no colour to count, its
    // shading gives it away, softer than any flat diagram's.
    const monoPhoto = s.color <= 0.05 && s.fg90 >= 8 && s.tone >= 0.2;
    if (s.transp >= 0.2) {
      // A diagram with parts drawn faint (colah's LSTM "focus" figures): the soft edges of
      // pale lines on a pale panel read as shading, but the palette is tiny, nothing is
      // colourful or grey, and black ink is left. A cut-out photograph, even of a white
      // product, is shaded in neutral greys.
      const faint = s.fg90 <= 8 && s.color <= 0.05 && s.grey < 0.03 && s.dark >= 0.03 && s.light >= 0.75;
      if ((photo || monoPhoto) && !faint) return 'none'; // a cut-out photograph
      // Mostly dark ink, maybe with coloured nodes: black logos, formulas, line diagrams.
      if (s.dark >= 0.55 && s.color <= 0.6) return 'logo';
      // A white wordmark made for dark pages, maybe with dark details (Notability's outlined
      // icon): thin strokes, outlined in white. Flipping would erase the white. A light window
      // or panel with a shadow round it is outlined in white too, but it is one solid block.
      if (s.rim >= 0.85 && s.outline >= 0.2) return 'none';
      // Light or grey fills with dark lines and labels: a diagram drawn for white paper, whose
      // ink would vanish on a dark page. White logos made for dark pages carry no ink: left alone.
      if (s.color <= 0.3 && (s.dark >= 0.05 || (s.light >= 0.4 && s.dark >= 0.015))) return 'flip';
      // A light card drawn for white paper in grey instead of black (distill.pub's figure
      // previews): a near-solid light block with grey lines and labels inside. A white logo
      // has almost no grey: its pixels are white, only their transparency varies.
      if (s.light >= 0.75 && s.grey >= 0.04 && s.color <= 0.1 && s.outline < 0.12 && s.tone < 0.2) return 'flip';
      return 'none';
    }
    if (s.light >= 0.5 && s.border >= 0.6) {
      // Sits on white paper.
      if (photo || monoPhoto) return 'dim';
      // Unless the "paper" has a see-through outline and no ink on it: then the white is the
      // picture, a logo too dense to count as a cut-out (Hex's white one). Same ink test as above.
      if (s.transp >= 0.05 && s.dark < 0.015) return 'none';
      // Colour reaching the frame (a heatmap, a map) carries meaning in its lightness: dim it.
      if (s.color >= 0.15 && s.border < 0.8) return 'dim';
      return s.color <= 0.30 ? 'flip' : 'dim';
    }
    if (s.light >= 0.4 && !photo) return 'dim'; // light flat graphic with colour at the edges
    return 'none';
  }

  function classify(data, w, h) {
    const signals = measure(data, w, h);
    return { verdict: decide(signals), signals };
  }

  const api = { SAMPLE_MAX, LIGHT, DARK, sampleSize, pixels, measure, decide, classify };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InkflipClassifier = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
