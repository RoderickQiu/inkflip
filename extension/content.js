/*
 * Inkflip content script.
 *
 * Finds <img> and <canvas> elements, gets a verdict for each one (from the user's right-click
 * choice, the shared cache, or by sampling its pixels), and tags it with
 * data-inkflip="flip|logo|dim|none". A <video> is only ever tagged by a right-click choice.
 * A single injected stylesheet turns those tags into CSS filters, but only while the element
 * actually sits on a dark background, which is what data-inkflip-l (the backdrop's lightness)
 * records. Page colours, CSS background images and inline SVG are left to Dark Reader, with
 * two exceptions: a light panel on a dark page that holds nothing but pictures is dimmed as a
 * whole, pictures included (data-inkflip-card), and a light <iframe> on a dark page that Dark
 * Reader isn't darkening is flipped like an image (see "frames").
 *
 * No white flash: on dark pages a new image carries data-inkflip-wait (opacity 0) from the
 * moment it enters the DOM until its verdict is in, so it first appears already flipped.
 * A canvas is held the same way while it is still blank, but for at most CANVAS_HOLD once it
 * is on screen: a WebGL canvas reads back blank forever and must not stay hidden.
 */
(() => {
  'use strict';
  if (globalThis.__inkflipLoaded) return;
  globalThis.__inkflipLoaded = true;
  const svgDocument = document.contentType === 'image/svg+xml';
  if (!svgDocument && !(document.documentElement instanceof HTMLElement)) return;

  const C = globalThis.InkflipClassifier;
  const DEFAULTS = globalThis.INKFLIP_DEFAULTS;
  const ATTR = 'data-inkflip';
  const ATTR_L = 'data-inkflip-l';
  const WAIT = 'data-inkflip-wait';
  const PEEK = 'data-inkflip-peek';
  const CARD = 'data-inkflip-card';
  const FLIPPED = 'data-inkflip-flipped'; // on this frame's <html>: the page around flips it
  const FILL = 'data-inkflip-fill'; // a shape in a chart, given the other lightness (index into swapTable)
  const STROKE = 'data-inkflip-stroke'; // likewise its outline
  const PANEL = 'data-inkflip-panel'; // a light box on a dark site, flipped (the backdrop's lightness)
  const FIELD = 'data-inkflip-field'; // a light form control on a dark site: 'scheme' or 'flip'
  const MSG = '__inkflip'; // tags the messages between a page and its frames
  const DARK_PAGE = 0.40; // a backdrop at or below this lightness counts as dark
  const MAX_WAIT = 2500; // ms a loaded, on-screen image may stay hidden while it is checked
  const SMALL = 48; // px: avatars, swatches, icons. Too few pixels to judge reliably and too small
                    // to glare: never hidden, never flipped or dimmed, only rescued if dark ink
  const CANVAS_HOLD = 500; // ms a blank canvas on screen may stay hidden, waiting to be painted
  const RECHECK = [300, 1000, 2500, 6000]; // ms after a canvas verdict: charts animate in,
                                           // PDF pages render in passes

  const HOST = topHost();
  const OVR_KEY = 'ovr:' + HOST;
  const DARK_KEY = 'dark:' + HOST;
  const isTop = window === window.top;

  if (svgDocument) { svgFrame(); return; }

  let settings = { ...DEFAULTS };
  let overrides = {}; // image URL, canvas or video key -> 'flip' | 'dim' | 'none', from the right-click menu
  let ready = false; // settings have been read
  let knownDark = false; // this site was dark last time, so hold images from the first byte
  let hold = true; // hide unchecked images (true until settings say otherwise)
  let filterMode = false; // the whole page is inverted (Dark Reader's Filter mode or similar)
  let flipped = false; // this is a frame, and the page around it flips it (see "frames")
  let peeking = false; // the originals are shown (Alt held)

  const state = new WeakMap(); // element -> { kind, verdict, signals, source, provisional, ... }
  const tracked = new Set();
  const near = new WeakSet(); // elements within the IntersectionObserver margin
  const visible = new WeakSet(); // elements actually on screen: checked first

  const isImg = (el) => el instanceof HTMLImageElement;
  const isCanvas = (el) => el instanceof HTMLCanvasElement;
  const isVideo = (el) => el instanceof HTMLVideoElement;
  const isChart = (el) => el instanceof SVGSVGElement && !el.ownerSVGElement; // an inline <svg>, outermost
  /** The parent in the composed tree: out of a shadow root, its host. */
  const up = (n) => n.parentElement || (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const isMedia = (el) => isImg(el) || isCanvas(el) || isVideo(el) || isChart(el);
  const FRAMES = 'iframe,object,embed'; // elements that hold a document of their own
  const isFrame = (el) => el instanceof HTMLIFrameElement || el instanceof HTMLObjectElement || el instanceof HTMLEmbedElement;

  // ---------------------------------------------------------------- stylesheet

  const style = document.createElement('style');
  style.id = 'inkflip-style';
  // Dark Reader rewrites the colours in every stylesheet on the page, and would turn the dark
  // fills below light again. It leaves user styles alone, which carry this class (Stylus's).
  style.className = 'stylus';

  function isActive() {
    return ready && settings.enabled && !filterMode && !settings.disabledHosts.includes(HOST);
  }

  /**
   * The stylesheet for this document, or for a shadow root inside it (`shadow`), whose rules
   * can't see <html>: there peek and a flipped frame are written into the text instead.
   */
  function buildCss(shadow = false) {
    let css = '';
    if (!ready || (isActive() && settings.hold)) css += `:is(img,canvas,svg,${FRAMES})[${WAIT}]{opacity:0 !important}\n`;
    if (!isActive() || (shadow && peeking)) return css;
    const hover = settings.peek === 'hover' ? ':not(:hover)' : '';
    const top = shadow ? '' : `html:not([${PEEK}]) `;
    const on = (v, tags) => `${top}${tags ? `:is(${tags})` : ''}[${ATTR}="${v}"]`;
    // A light frame that the page around it flips: turn its pictures back, except the ones
    // Inkflip would flip anyway. Pointing into the frame hovers both, so `hover` stays in step.
    const back = `:is(img,canvas,video):not([${ATTR}="flip"],[${ATTR}="logo"])`;
    if (!shadow) css += `html[${FLIPPED}]:not([${PEEK}])${hover} ${back}{filter:invert(1) hue-rotate(180deg) !important}\n`;
    else if (flipped) css += `${back}{filter:invert(1) hue-rotate(180deg) !important}\n`;
    if (settings.flip || settings.logo) {
      // Invert so white lands just below the backdrop's darkest channel, then blend with
      // `lighten`: the image's background takes the backdrop's exact colour (tinted panels
      // included) while the now-light ink stays on top.
      for (let l = 0; l <= 40; l += 2) {
        const sel = [];
        if (settings.flip) sel.push(`${on('flip')}[${ATTR_L}="${l}"]${hover}`);
        if (settings.logo) sel.push(`${on('logo')}[${ATTR_L}="${l}"]${hover}`);
        css += `${sel.join(',')}{filter:invert(${(1 - l / 100).toFixed(2)}) hue-rotate(180deg) !important;` +
          'mix-blend-mode:lighten !important}\n';
      }
      // An image's own background colour goes: sites give transparent images one (Wikipedia:
      // white, darkened by Dark Reader), and the filter would invert it into a light box. A
      // frame keeps its own: it is part of what the frame shows, so it is what decides the
      // flip, and the blend takes its white to the backdrop's colour anyway. A frame's drop
      // shadow would invert into a pale glow around it.
      const sel = [];
      if (settings.flip) sel.push(`${on('flip', 'img,canvas,video')}[${ATTR_L}]${hover}`);
      if (settings.logo) sel.push(`${on('logo', 'img,canvas,video')}[${ATTR_L}]${hover}`);
      css += `${sel.join(',')}{background-color:transparent !important}\n`;
      if (settings.flip) css += `${on('flip', FRAMES)}[${ATTR_L}]${hover},${on('logo', FRAMES)}[${ATTR_L}]${hover}{box-shadow:none !important}\n`;
      // A flipped video's own controls are turned back, or their dark bar would turn light.
      css += `${on('flip', 'video')}[${ATTR_L}]${hover}::-webkit-media-controls-enclosure,` +
        `${on('logo', 'video')}[${ATTR_L}]${hover}::-webkit-media-controls-enclosure{filter:invert(1) hue-rotate(180deg) !important}\n`;
    }
    if (settings.flip) {
      // No html ancestor in these selectors: shapes drawn by <use> are copies in a shadow tree
      // that has none. Peek leaves these rules out instead (setPeek rebuilds the stylesheet).
      if (!peeking) {
        swapTable.forEach((c, k) => {
          // The repeated attribute outranks Dark Reader's own rule for inline fills.
          css += `[${FILL}="${k}"][${FILL}]${hover}{fill:${c} !important}\n[${STROKE}="${k}"][${STROKE}]${hover}{stroke:${c} !important}\n`;
        });
      }
    }
    if (settings.panels) {
      // A light box: flipped like a picture but without the blend (it may sit over other
      // content), its pictures turned back, its drop shadow gone (it would invert into a glow).
      for (let l = 0; l <= 40; l += 2) {
        css += `${top}[${PANEL}="${l}"]${hover}{filter:invert(${(1 - l / 100).toFixed(2)}) hue-rotate(180deg) !important;box-shadow:none !important}\n`;
      }
      css += `${top}[${PANEL}] :is(img,video,canvas,[${ATTR}]):not([${ATTR}="flip"],[${ATTR}="logo"])${hover}` +
        '{filter:invert(1) hue-rotate(180deg) !important}\n';
      css += `${top}[${FIELD}="scheme"]{color-scheme:dark !important}\n`;
      css += `${top}[${FIELD}="flip"]${hover}{filter:invert(0.9) hue-rotate(180deg) !important}\n`;
    }
    if (settings.dim) {
      css += `${on('dim')}[${ATTR_L}]${hover}{filter:brightness(${settings.dimLevel}) !important}\n`;
      css += `${top}[${CARD}]${hover}{filter:brightness(${settings.dimLevel}) !important}\n`;
    }
    return css;
  }

  function refreshStyle() {
    style.textContent = buildCss();
    if (!style.isConnected) document.documentElement.appendChild(style);
    if (!shadowStyles.size) return;
    const css = buildCss(true);
    for (const [root, s] of shadowStyles) {
      if (s.textContent !== css) s.textContent = css;
      if (!s.isConnected) root.appendChild(s);
    }
  }

  // ------------------------------------------------------------ surroundings

  const colorCtx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  /** Any CSS colour string (rgb, oklch, color(), ...) -> {r, g, b, a} in sRGB, or null. */
  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
    let c = colorCache.get(str);
    if (c !== undefined) return c;
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(str);
    if (m) {
      c = { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    } else {
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = '#000';
      colorCtx.fillStyle = str;
      colorCtx.fillRect(0, 0, 1, 1);
      const d = colorCtx.getImageData(0, 0, 1, 1).data;
      c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    colorCache.set(str, c);
    return c;
  }

  const luma = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  /** Whether a computed color-scheme value comes out dark. */
  function schemeDark(scheme = '') {
    return scheme.includes('dark') &&
      (!scheme.includes('light') || matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** Lightness of the browser canvas when nothing on the page paints a background. */
  function canvasLightness() {
    return schemeDark(getComputedStyle(document.documentElement).colorScheme) ? 0.07 : 1;
  }

  /**
   * What the image sits on: the backdrop colour behind it, and whether anything above it
   * is already inverted (a Dark Reader INVERT rule, Filter mode, or the site's own trick).
   * Inverting inside an inverted subtree would undo it.
   *
   * The visible backdrop is often a sibling layer rather than an ancestor (LeetCode's panels
   * are), so when the image is on screen we ask the hit-test stack what is underneath it.
   * Off screen we fall back to the nearest ancestor background and look again on arrival.
   */
  function surroundings(img, rect) {
    let bg = null, inverted = false;
    for (let n = up(img); n; n = up(n)) {
      const cs = getComputedStyle(n);
      if (!inverted && cs.filter !== 'none' && cs.filter.includes('invert')) inverted = true;
      if (bg === null) {
        const c = parseColor(cs.backgroundColor);
        if (c && c.a >= 0.5) bg = c;
      }
    }
    const onScreen = rect.width > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth;
    let measured = false;
    if (onScreen) {
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
      const root = img.getRootNode();
      const stack = (root instanceof ShadowRoot ? root : document).elementsFromPoint(x, y);
      let i = stack.indexOf(img);
      i = i >= 0 ? i + 1 : stack.findIndex((e) => e.contains(img)); // img may not be hit-testable
      for (let k = Math.max(i, 0); i >= 0 && k < stack.length; k++) {
        const c = parseColor(getComputedStyle(stack[k]).backgroundColor);
        if (c && c.a >= 0.5) { bg = c; measured = true; break; }
      }
    }
    if (bg === null) {
      const v = canvasLightness() * 255;
      bg = { r: v, g: v, b: v, a: 1 };
    }
    return { L: luma(bg), floor: Math.min(bg.r, bg.g, bg.b) / 255, inverted, measured };
  }

  function pageLightness() {
    for (const n of [document.body, document.documentElement]) {
      if (!n) continue;
      const c = parseColor(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.5) return luma(c);
    }
    return canvasLightness();
  }

  function detectFilterMode() {
    filterMode = getComputedStyle(document.documentElement).filter.includes('invert');
  }

  function detectDarkReader() {
    const html = document.documentElement;
    if (html.hasAttribute('data-darkreader-mode')) return html.getAttribute('data-darkreader-mode');
    if (document.querySelector('style.darkreader, #dark-reader-style, meta[name="darkreader"]')) return 'on';
    return null;
  }

  /** Dark Reader is darkening this page (it may not have painted the background yet). */
  function darkReaderDark() {
    const scheme = document.documentElement.getAttribute('data-darkreader-scheme');
    return scheme ? scheme === 'dark' : detectDarkReader() !== null;
  }

  // ------------------------------------------------------------------- cards
  //
  // A product shot on a pastel card, an app window on a coloured slab: a light panel on a dark
  // page that holds nothing but pictures. Flipping the picture would leave the bright panel
  // around it, and the picture sits on light, so on its own it is left alone. Instead the whole
  // panel is dimmed, the pictures in it with it, and they keep their colours.

  const CARD_FILL = 0.35; // pictures cover at least this share of the panel...
  const CARD_HIDDEN = 0.95; // ...but less than this: a panel they cover is never seen
  const cards = new Map(); // panel -> the elements that found it
  let textCache = new WeakMap(); // panel -> it holds readable text

  /** Lightness of an element's own background: null if it paints none, undefined if a picture. */
  function backgroundLightness(cs) {
    const image = cs.backgroundImage;
    if (image.includes('url(')) return undefined;
    if (image.includes('gradient(')) {
      const stops = (image.match(/(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/g) || [])
        .map(parseColor).filter((c) => c && c.a >= 0.5);
      if (stops.length) return stops.reduce((s, c) => s + luma(c), 0) / stops.length;
    }
    const c = parseColor(cs.backgroundColor);
    return c && c.a >= 0.5 ? luma(c) : null;
  }

  /** Something to read or type into: text, a form field, an editor (placeholders aren't text). */
  function hasText(el) {
    let t = textCache.get(el);
    if (t === undefined) {
      t = el.innerText.trim() !== '' || el.isContentEditable ||
        !!el.querySelector('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])');
      textCache.set(el, t);
    }
    return t;
  }

  /** Share of a panel covered by the pictures inside it. */
  function pictureShare(el) {
    const r = el.getBoundingClientRect();
    let area = 0;
    for (const m of el.querySelectorAll('img,canvas,video')) {
      const b = m.getBoundingClientRect();
      area += Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left)) *
        Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
    }
    return area / Math.max(1, r.width * r.height);
  }

  /**
   * The card around el: walking out from it through light panels to the dark page, the
   * outermost one that is big enough and mostly pictures. None if a light panel on the way
   * holds text (a page column or a captioned figure: something to read, not a frame) or has
   * a background picture whose lightness we can't know.
   */
  function findCard(el) {
    if (!isActive() || !settings.dim || pageLightness() > DARK_PAGE) return null;
    const panels = [];
    for (let n = up(el); n && n !== document.body && n !== document.documentElement; n = up(n)) {
      const cs = getComputedStyle(n);
      const L = backgroundLightness(cs);
      if (L === undefined) return null;
      if (L === null) continue;
      if (L <= DARK_PAGE) break;
      if (hasText(n)) return null;
      // A panel with its own filter keeps it: ours would replace it.
      if ((cs.filter === 'none' || n.hasAttribute(CARD)) && pictureShare(n) < CARD_HIDDEN) panels.push(n);
    }
    for (let i = panels.length - 1; i >= 0; i--) {
      const r = panels[i].getBoundingClientRect();
      if (r.width >= 120 && r.height >= 80 && pictureShare(panels[i]) >= CARD_FILL) return panels[i];
    }
    return null;
  }

  function setCard(el, st, panel) {
    if (st.card === panel) return;
    if (st.card) {
      const users = cards.get(st.card);
      if (users) {
        users.delete(el);
        if (!users.size) { cards.delete(st.card); st.card.removeAttribute(CARD); }
      }
    }
    st.card = panel;
    if (!panel) return;
    let users = cards.get(panel);
    if (!users) { cards.set(panel, (users = new Set())); panel.setAttribute(CARD, ''); }
    users.add(el);
  }

  /** Whether el belongs to a card, judged before its verdict is in: then it needs none. */
  function placeCard(el, st) {
    if (st.kind === 'video' || st.source === 'you') return;
    const r = el.getBoundingClientRect();
    setCard(el, st, r.width > SMALL || r.height > SMALL ? findCard(el) : null);
    if (st.card) el.removeAttribute(WAIT);
  }

  // -------------------------------------------------------------------- hold

  function holding() {
    if (!ready) return true; // a few ms before settings arrive: assume a dark page
    if (!isActive() || !settings.hold) return false;
    return knownDark || flipped || darkReaderDark() || pageLightness() <= DARK_PAGE;
  }

  function updateHold() {
    const next = holding();
    if (next === hold) return;
    hold = next;
    for (const img of tracked) {
      const st = state.get(img);
      if (next && st && !st.verdict && !st.card) wait(img);
      else if (!next) img.removeAttribute(WAIT);
    }
  }

  function wait(img) {
    if (isVideo(img) || img.hasAttribute(WAIT)) return;
    img.setAttribute(WAIT, '');
    if (!watchdog) watchdog = setInterval(checkWaits, 250);
  }

  // Never keep a loaded, on-screen image hidden for long, whatever happens to its check.
  let watchdog = 0;
  function checkWaits() {
    const now = performance.now();
    let waiting = 0;
    for (const img of tracked) {
      if (!img.hasAttribute(WAIT)) continue;
      const st = state.get(img);
      if (!st || !img.isConnected) { img.removeAttribute(WAIT); continue; }
      waiting++;
      if (st.kind === 'canvas' || st.kind === 'svg') {
        // Its own polling reveals it after CANVAS_HOLD; this is the backstop.
        if (visible.has(img)) {
          st.t0 = st.t0 || now;
          if (now - st.t0 > CANVAS_HOLD + 1000) img.removeAttribute(WAIT);
        }
      } else if (near.has(img) && img.complete) {
        st.clock = st.clock || now;
        if (now - st.clock > MAX_WAIT) img.removeAttribute(WAIT);
      }
    }
    if (!waiting) { clearInterval(watchdog); watchdog = 0; }
  }

  // ------------------------------------------------------------------ apply

  function apply(img) {
    const st = state.get(img);
    if (!st || !st.verdict || !img.isConnected) return;
    if (st.ownInverted === undefined) {
      // Checked once, before our own filter is on the element.
      st.ownInverted = !img.hasAttribute(ATTR_L) && getComputedStyle(img).filter.includes('invert');
    }
    const r = img.getBoundingClientRect();
    const ctx = surroundings(img, r);
    st.dark = ctx.L <= DARK_PAGE;
    st.inverted = ctx.inverted || st.ownInverted;
    st.provisional = !ctx.measured;
    st.stale = false;
    const [nw, nh] = natural(img);
    const tiny = (nw > 0 && (nw < 8 || nh < 8)) || (r.width > 0 && (r.width < 8 || r.height < 8));
    const small = r.width > 0 && r.width <= SMALL && r.height <= SMALL;
    const card = st.kind !== 'video' && st.kind !== 'bg' && st.kind !== 'image' && st.source !== 'you' &&
      !st.inverted && !tiny && !small ? findCard(img) : null;
    setCard(img, st, card);

    img.setAttribute(ATTR, st.verdict);
    const on = !card && st.verdict !== 'none' && st.dark && !st.inverted && !tiny && !(small && st.verdict !== 'logo');
    if (on) {
      const l = Math.min(40, Math.floor(ctx.floor * 50) * 2); // rounded down: stays under the backdrop
      if (img.getAttribute(ATTR_L) !== String(l)) img.setAttribute(ATTR_L, String(l));
    } else if (img.hasAttribute(ATTR_L)) {
      img.removeAttribute(ATTR_L);
    }
    // Reveal now, unless the page is about to turn dark (Dark Reader still loading) and this
    // image would then need flipping: it stays hidden until then, or until the watchdog. A page
    // that is dark on its own, with no Dark Reader, won't change: its light panels stay light.
    if (st.kind === 'svg') {
      const ok = !on && st.dark && !st.inverted && st.source !== 'you' && settings.flip;
      recolor(img, ok ? (st.full ? 'full' : 'panels') : null);
    }
    // In a frame that the page around it flips, every verdict is final.
    const native = !st.dark && detectDarkReader() === null && pageLightness() <= DARK_PAGE;
    if (on || card || native || flipped || st.verdict === 'none' || !hold || st.dark || st.inverted || tiny || small) img.removeAttribute(WAIT);
    queueBadges();
  }

  function clearTags(img) {
    img.removeAttribute(ATTR);
    img.removeAttribute(ATTR_L);
  }

  /** Intrinsic size: an image's pixels, a canvas's bitmap, a video's frames, an SVG's box. */
  function natural(el) {
    if (isCanvas(el)) return [el.width, el.height];
    if (isVideo(el)) return [el.videoWidth, el.videoHeight];
    if (!isImg(el)) { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }
    return [el.naturalWidth, el.naturalHeight];
  }

  // ---------------------------------------------------------------- analysis

  /** Classify a decoded image element on our own canvas; null if the canvas is tainted. */
  function sampleElement(img, svg) {
    const w = img.naturalWidth || img.width || 300;
    const h = img.naturalHeight || img.height || 150;
    try {
      const px = C.pixels(img, w, h, svg);
      return C.classify(px.data, px.w, px.h);
    } catch (e) {
      return null; // cross-origin without CORS: the service worker reads it instead
    }
  }

  /** SVG fetched by the service worker: rasterise it here, where there is a DOM. */
  function sampleSvg(text) {
    return new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(sampleElement(im, true));
      im.onerror = () => resolve(null);
      im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    });
  }

  const cacheable = (url) => /^https?:/.test(url) && url.length <= 2048;
  const isSvg = (url) => /^data:image\/svg|\.svg([?#]|$)/i.test(url);
  const loaded = (img, st) => img.complete && (img.naturalWidth > 0 || isSvg(st.src));

  function sameOrigin(url) {
    try { return new URL(url).origin === location.origin; } catch (e) { return false; }
  }

  /** Cross-origin http(s) images are read by the service worker, which needn't wait for load. */
  const remote = (url) => cacheable(url) && !sameOrigin(url);

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // extension was reloaded; this page keeps its last state
    }
  }

  async function analyze(img) {
    const st = state.get(img);
    if (!st) return;
    const src = st.src;
    let res = null, source = 'page';
    if (st.kind !== 'img') {
      // A CSS background, an SVG <image> or a video poster: only its address is known. A
      // same-origin one is drawn here from a detached image; the rest go to the service worker.
      if (!remote(src)) {
        try {
          const im = new Image();
          im.src = src;
          await im.decode();
          res = sampleElement(im, isSvg(src));
          if (res && cacheable(src)) send({ type: 'remember', url: src, result: res });
        } catch (e) { /* unreadable */ }
      }
    } else if (loaded(img, st) && (!remote(src) || img.crossOrigin !== null)) {
      res = sampleElement(img, isSvg(src));
      if (res && cacheable(src)) send({ type: 'remember', url: src, result: res });
    }
    if (!res && cacheable(src)) {
      source = 'fetched';
      const r = await send({ type: 'analyze', url: src, page: location.href });
      if (r && r.svg) {
        res = await sampleSvg(r.svg);
        if (res) send({ type: 'remember', url: src, result: res });
      } else if (r && r.verdict) {
        res = r;
      }
    }
    if (state.get(img) !== st || st.src !== src) return; // the image changed while we waited
    st.pending = false;
    if (st.verdict) return; // the cache or your right-click choice got there first
    st.verdict = res ? res.verdict : 'none';
    st.signals = res ? res.signals : null;
    st.source = res ? source : 'unreadable';
    apply(img);
  }

  const queue = [];
  let running = 0;

  function schedule(img) {
    const st = state.get(img);
    if (!st || st.verdict || st.pending || !isActive() || !st.src) return;
    if (st.kind === 'img' && !loaded(img, st) && !remote(st.src)) return; // same-origin: the load listener calls back
    st.pending = true;
    queue.push(img);
    pump();
  }

  function pump() {
    while (running < 6 && queue.length) {
      const first = queue.findIndex((q) => visible.has(q));
      const img = queue.splice(first >= 0 ? first : 0, 1)[0];
      running++;
      analyze(img).finally(() => { running--; pump(); });
    }
  }

  // Before an image has even loaded, ask the cache: a hit means it is ready on first paint.
  const lookups = new Map(); // url -> Set<img>
  let lookupTimer = 0;

  function lookup(img, st) {
    if (!cacheable(st.src)) return;
    let set = lookups.get(st.src);
    if (!set) lookups.set(st.src, (set = new Set()));
    set.add(img);
    if (!lookupTimer) lookupTimer = setTimeout(flushLookups, 0);
  }

  async function flushLookups() {
    lookupTimer = 0;
    const batch = new Map(lookups);
    lookups.clear();
    const hits = (await send({ type: 'lookup', urls: [...batch.keys()] })) || {};
    for (const [url, imgs] of batch) {
      const hit = hits[url];
      if (!hit) continue;
      for (const img of imgs) {
        const st = state.get(img);
        if (!st || st.src !== url || st.verdict) continue;
        st.verdict = hit.verdict;
        st.signals = hit.signals;
        st.source = 'cache';
        apply(img);
      }
    }
  }

  // ---------------------------------------------------------------- canvases
  //
  // A canvas has no load event and no URL: the page paints it whenever it likes, and may paint
  // it again. So it is sampled when it comes near the screen, polled while it is still blank,
  // and looked at a few more times after its verdict (charts animate in, PDF pages render in
  // passes, a resize clears it). Once it has a verdict, two samples in a row must agree before
  // it changes. A canvas holding a cross-origin picture can't be read, and WebGL reads back
  // blank or a stray frame: both are left alone (a right-click choice still applies).

  /** Verdict for a canvas's current pixels, or 'blank' (nothing painted) or 'tainted'. */
  function sampleCanvas(cv) {
    const w = cv.width, h = cv.height;
    if (w < 8 || h < 8) return 'blank';
    const [tw, th] = C.sampleSize(w, h);
    try {
      // Shrink it on the GPU first: reading a full-size canvas back into memory is slow.
      const small = new OffscreenCanvas(tw, th);
      const g = small.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(cv, 0, 0, tw, th);
      const px = C.pixels(small, tw, th, false);
      const res = C.classify(px.data, px.w, px.h);
      return res.signals.transp > 0.998 ? 'blank' : res;
    } catch (e) {
      return 'tainted'; // a cross-origin image was drawn into it
    }
  }

  /**
   * Whether a canvas keeps its pixels between frames, so that a sample means something.
   * WebGL and WebGPU drop each frame once it is on screen: a sample reads blank, or whichever
   * frame it happened to catch. Only asked once the canvas has shown content, so it already
   * has a context and asking for another one creates nothing: it just returns null.
   */
  function steady(cv) {
    try {
      return !!(cv.getContext('2d') || cv.getContext('bitmaprenderer'));
    } catch (e) {
      return true; // stands in for an OffscreenCanvas, and shows its last committed frame
    }
  }

  function later(cv, st, ms) {
    clearTimeout(st.timer);
    st.timer = setTimeout(canvasTick, ms, cv);
  }

  /** Start sampling a canvas; `fresh` starts its checks over (after a resize, say). */
  function startCanvas(cv, fresh) {
    const st = state.get(cv);
    if (!st || st.source === 'you' || st.gl || !isActive()) return;
    if (fresh) {
      st.checks = 0;
      st.t0 = 0;
    }
    if (!st.timer) later(cv, st, 0);
  }

  function settle(cv, st, verdict, signals, source) {
    st.verdict = verdict;
    st.signals = signals;
    st.source = source;
    apply(cv);
  }

  function recheck(cv, st) {
    const ms = RECHECK[st.checks];
    if (ms === undefined) return;
    st.checks++;
    later(cv, st, ms);
  }

  function canvasTick(cv) {
    const st = state.get(cv);
    if (!st) return;
    st.timer = 0;
    if (!cv.isConnected || !isActive() || st.source === 'you') return;
    const mine = overrideFor(cv, st); // its parents' classes may have changed since it was found
    if (mine) {
      settle(cv, st, mine, null, 'you');
      return;
    }
    const now = performance.now();
    const res = sampleCanvas(cv);
    st.sampled = now;
    if (res === 'tainted') {
      if (!st.verdict || st.source === 'blank') settle(cv, st, 'none', null, 'unreadable');
      return;
    }
    if (res === 'blank') {
      if (st.verdict && st.source !== 'blank') { recheck(cv, st); return; } // cleared for a redraw
      if (!visible.has(cv)) { st.t0 = 0; return; } // polled again once it is on screen
      st.t0 = st.t0 || now;
      const age = now - st.t0;
      if (age >= CANVAS_HOLD) cv.removeAttribute(WAIT);
      if (age < (st.gaveUp ? 2000 : 15000)) {
        later(cv, st, age < CANVAS_HOLD ? 16 : age < 3000 ? 200 : 1000);
      } else {
        st.gaveUp = true;
        st.t0 = 0;
        settle(cv, st, 'none', null, 'blank');
      }
      return;
    }
    if (st.gl === undefined) st.gl = !steady(cv);
    if (st.gl) {
      settle(cv, st, 'none', null, 'webgl');
      cv.removeAttribute(WAIT);
      return;
    }
    const firm = st.verdict && st.source === 'page';
    if (firm && res.verdict !== st.verdict && st.candidate !== res.verdict) {
      st.candidate = res.verdict; // maybe caught mid-redraw: look again before switching
      later(cv, st, 150);
      return;
    }
    st.candidate = null;
    settle(cv, st, res.verdict, res.signals, 'page');
    recheck(cv, st);
  }

  /** Setting a canvas's width or height clears it: watch it repaint. */
  function canvasResized(cv) {
    const st = state.get(cv);
    if (!st || (cv.width === st.w && cv.height === st.h)) return;
    st.w = cv.width;
    st.h = cv.height;
    if (near.has(cv)) startCanvas(cv, true);
  }

  // -------------------------------------------------------------- inline SVG
  //
  // Charts and diagrams drawn as inline <svg> (Plotly, D3, distill.pub's figures) aren't
  // pictures to Dark Reader: it recolours their fills and strokes where it can, and a chart
  // whose colours are set by script stays light. Each large one is drawn into an image in the
  // colours it shows (its computed styles copied onto a clone) and judged like a picture, as
  // it comes near the screen and a few times after, while it animates in. A light one is
  // flipped as a whole; otherwise its large light shapes get dark fills (below). On a site that
  // is dark by itself an inline SVG is part of its design, so only one painted on its own
  // light background, a chart with a white plot area, is flipped there.

  const SVG_MIN_W = 100, SVG_MIN_H = 60; // smaller ones are icons and wordmarks
  const SVG_MAX_NODES = 4000; // a scatter plot with more points is left alone
  const SVG_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'display', 'visibility', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
    'stop-color', 'stop-opacity', 'paint-order'];
  const svgSize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const st = state.get(e.target);
      if (!st || st.kind !== 'svg') continue;
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      const first = st.w === undefined;
      if (w === st.w && h === st.h) continue;
      st.w = w;
      st.h = h;
      if (!first && st.verdict && st.source !== 'you') svgChanged(e.target);
    }
  });

  /** The chart drawn into an image, as a data: URL; null if it can't be (too big, pictures in it). */
  function svgPicture(svg, w, h) {
    const src = svg.getElementsByTagName('*');
    if (src.length > SVG_MAX_NODES || svg.querySelector('image,foreignObject')) return null;
    const clone = svg.cloneNode(true);
    const dst = clone.getElementsByTagName('*');
    const copy = (from, to) => {
      const cs = getComputedStyle(from);
      let text = '';
      for (const p of SVG_PROPS) text += `${p}:${cs.getPropertyValue(p)};`;
      to.setAttribute('style', text);
    };
    copy(svg, clone);
    clone.style.opacity = 1; // it may be held hidden (WAIT) while it is judged
    clone.style.backgroundColor = getComputedStyle(svg).backgroundColor; // Plotly paints its paper here
    for (let i = 0; i < src.length; i++) copy(src[i], dst[i]);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', w);
    clone.setAttribute('height', h);
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  }

  /** Verdict for an inline SVG as it is drawn now: a result, 'small', or null if unreadable. */
  async function sampleChart(svg) {
    const r = svg.getBoundingClientRect();
    const w = Math.round(r.width), h = Math.round(r.height);
    if (w < SVG_MIN_W || h < SVG_MIN_H) return 'small';
    const url = svgPicture(svg, w, h);
    if (!url) return null;
    const im = new Image();
    im.src = url;
    await im.decode();
    const px = C.pixels(im, w, h, true);
    const res = C.classify(px.data, px.w, px.h);
    // Flipped whole only on its own light paper. Otherwise, on a page Dark Reader darkens, it is
    // recoloured shape by shape (Dark Reader takes SVG fills for text and keeps them light); on
    // a site that is dark by itself, only its large light panels are.
    const flip = res.verdict === 'flip' && res.signals.transp < 0.2;
    return { verdict: flip ? 'flip' : 'none', full: !flip && darkReaderDark(), signals: res.signals };
  }

  function startSvg(svg, fresh) {
    const st = state.get(svg);
    if (!st || st.source === 'you' || !isActive()) return;
    if (fresh) st.checks = 0;
    if (!st.timer && !st.busy) st.timer = setTimeout(chartTick, 0, svg);
  }

  async function chartTick(svg) {
    const st = state.get(svg);
    if (!st) return;
    st.timer = 0;
    if (!svg.isConnected || !isActive() || st.source === 'you') return;
    st.busy = true;
    let res = null;
    try { res = await sampleChart(svg); } catch (e) { /* unreadable */ }
    st.busy = false;
    if (state.get(svg) !== st || st.source === 'you') return;
    st.sampled = performance.now();
    svg.removeAttribute(WAIT);
    if (res === 'small') return; // judged again if it grows
    svgSize.observe(svg);
    st.verdict = res ? res.verdict : 'none';
    st.full = !!(res && res.full);
    st.signals = res ? res.signals : null;
    st.source = res ? 'page' : 'unreadable';
    apply(svg);
    const ms = RECHECK[st.checks];
    if (ms !== undefined && res) {
      st.checks++;
      st.timer = setTimeout(chartTick, ms, svg);
    }
  }

  // A chart that isn't flipped as a whole is recoloured shape by shape, through the stylesheet
  // (so peek and the switches still work), each colour given the other lightness with its hue
  // kept. 'full', on a page Dark Reader darkens (it takes SVG fills for text and keeps them
  // light, Plotly's plot area and distill.pub's boxes among them): light shapes turn dark, and
  // dark text, lines and small marks turn light. 'panels', on a site that is dark by itself:
  // only large light shapes, a light plot area in a dark chart, say.
  const swapTable = []; // index -> colour
  const swapIndex = new Map(); // colour as computed -> index
  const DRAWN = new Set(['rect', 'path', 'polygon', 'polyline', 'line', 'circle', 'ellipse', 'use']);
  const WORDS = new Set(['text', 'tspan', 'textPath']);

  function swapLightness(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return `hsl(${Math.round(h * 60)} ${Math.round(s * 100)}% ${Math.round(Math.min(0.92, Math.max(0.08, 1 - l)) * 100)}%)`;
  }

  // Shapes in <defs> are drawn by <use> as copies in a shadow tree that no stylesheet reaches,
  // so their colour goes inline, where the copies pick it up. Their own inline value is kept.
  const inlined = new Map(); // element -> { fill?: [value, priority], stroke?: [...] }

  function setInline(el, prop, value) {
    let saved = inlined.get(el);
    if (!saved) inlined.set(el, (saved = {}));
    if (!(prop in saved)) saved[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
    el.style.setProperty(prop, value, 'important');
  }

  /** Inline colours off (peek, or let go) or back on. */
  function showInline(on) {
    for (const [el, saved] of inlined) {
      for (const prop of Object.keys(saved)) {
        const k = el.getAttribute(prop === 'fill' ? FILL : STROKE);
        if (on && k !== null) el.style.setProperty(prop, swapTable[k], 'important');
        else if (saved[prop][0]) el.style.setProperty(prop, saved[prop][0], saved[prop][1]);
        else el.style.removeProperty(prop);
      }
    }
  }

  /** The chart's elements, and those its <use> elements draw from elsewhere (other SVGs' defs). */
  function chartElements(svg) {
    const out = [...svg.querySelectorAll('*')];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      if (out[i].localName !== 'use') continue;
      const ref = (out[i].getAttribute('href') || out[i].getAttribute('xlink:href') || '').trim();
      const target = ref.startsWith('#') ? document.getElementById(ref.slice(1)) : null;
      if (!target || seen.has(target)) continue;
      for (const el of [target, ...target.querySelectorAll('*')]) if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    return out;
  }

  function recolor(svg, mode) {
    const els = chartElements(svg);
    if (!mode) {
      for (const el of els) {
        if (!el.hasAttribute(FILL) && !el.hasAttribute(STROKE)) continue;
        const saved = inlined.get(el);
        if (saved) {
          for (const prop of Object.keys(saved)) {
            if (saved[prop][0]) el.style.setProperty(prop, saved[prop][0], saved[prop][1]);
            else el.style.removeProperty(prop);
          }
          inlined.delete(el);
        }
        el.removeAttribute(FILL);
        el.removeAttribute(STROKE);
      }
      return;
    }
    const box = svg.getBoundingClientRect();
    const area = box.width * box.height;
    let added = false;
    const mark = (el, attr, value, c, defined) => {
      let k = swapIndex.get(value);
      if (k === undefined) {
        swapIndex.set(value, (k = swapTable.length));
        swapTable.push(swapLightness(c));
        added = true;
      }
      el.setAttribute(attr, k);
      if (defined && !peeking) setInline(el, attr === FILL ? 'fill' : 'stroke', swapTable[k]);
      else if (defined) setInline(el, attr === FILL ? 'fill' : 'stroke', el.style.getPropertyValue(attr === FILL ? 'fill' : 'stroke'));
    };
    for (const el of els) {
      const words = WORDS.has(el.localName);
      if (!words && !DRAWN.has(el.localName)) continue;
      if (el.hasAttribute(FILL) || el.hasAttribute(STROKE)) continue; // its computed colours are ours now
      // A shape in <defs> is drawn by <use> elsewhere, at a size it doesn't know itself.
      const defined = !!el.closest('defs,symbol') || !svg.contains(el);
      const cs = getComputedStyle(el);
      const fill = parseColor(cs.fill);
      let swapFill = false;
      if (fill && fill.a >= 0.5 && +cs.fillOpacity >= 0.5) {
        const L = luma(fill);
        const b = defined ? null : el.getBoundingClientRect();
        if (!words && L > 0.75) {
          swapFill = mode === 'full' ? defined || (b.width >= 8 && b.height >= 8)
            : !defined && b.width >= 48 && b.height >= 24 && b.width * b.height >= area * 0.1;
        } else if (mode === 'full' && L < 0.3) {
          swapFill = words || (!defined && b.width * b.height <= Math.max(576, area * 0.01)); // arrowheads, dots
        }
        if (swapFill) mark(el, FILL, cs.fill, fill, defined);
      }
      if (mode !== 'full') continue;
      // Lines: dark ones turn light. Text: its outline (a halo) swaps along with its fill, or not at all.
      const stroke = parseColor(cs.stroke);
      if (!stroke || stroke.a < 0.5 || +cs.strokeOpacity < 0.5) continue;
      if (words ? swapFill : luma(stroke) < 0.3) mark(el, STROKE, cs.stroke, stroke, defined);
    }
    if (added) refreshStyle();
  }

  /** Something was drawn into a chart, or it was resized: look at it again shortly. */
  function svgChanged(node) {
    let svg = node;
    while (svg.ownerSVGElement) svg = svg.ownerSVGElement;
    const st = state.get(svg);
    if (!st || st.kind !== 'svg' || st.source === 'you') return;
    clearTimeout(st.again);
    st.again = setTimeout(() => { if (!st.timer) startSvg(svg, true); }, 400);
  }

  // ------------------------------------------------------- right-click choices

  /**
   * What a right-click choice on a canvas is remembered by, for this site: its id, and the
   * tags and class names of the parents it sits in. Every page of a PDF viewer shares one,
   * as do the charts of one kind on a site. Class names with digits in them are left out,
   * because they tend to be generated, and so is the canvas's own class list, which chart
   * libraries change after they start.
   */
  function canvasKey(cv) {
    const id = cv.id && !/\d/.test(cv.id) ? '#' + cv.id : '';
    const kind = isChart(cv) ? 'svg' : 'canvas'; // an inline SVG is remembered the same way
    const parts = [kind + id];
    let n = cv.parentElement;
    for (let i = 0; i < 3 && n && n !== document.body && n !== document.documentElement; i++, n = n.parentElement) {
      const cls = [...n.classList].filter((c) => !/\d/.test(c) && c.length <= 40).sort().slice(0, 3);
      parts.unshift(n.localName + cls.map((c) => '.' + c).join(''));
    }
    return kind + '|' + parts.join('>');
  }

  /**
   * What a right-click choice on a video is remembered by: its file, when it has a real
   * address, or else this page and its place on it (streamed video plays from a blob: URL
   * that changes on every visit).
   */
  function videoKey(v) {
    const src = v.currentSrc || v.src || '';
    if (cacheable(src)) return src;
    const n = [...document.getElementsByTagName('video')].indexOf(v);
    return `video|${location.origin}${location.pathname}${location.search}|${n}`;
  }

  function overrideFor(el, st) {
    if (isImg(el)) return overrides[st.src] || (el.src && overrides[el.src]) || null;
    if (st.kind === 'bg' || st.kind === 'image') return overrides[st.src] || null; // remembered by address, as images
    return overrides[isCanvas(el) || isChart(el) ? canvasKey(el) : st.key] || null;
  }

  // ------------------------------------------------------------------ frames
  //
  // An embedded page (a live code preview, a form, a widget) is a document of its own. Where
  // Dark Reader darkens a page it darkens the frames in it too, but on a site that is dark by
  // itself it stays off, and a light frame stays a white box. This script runs in every frame,
  // and each one tells the page around it how light it is. A light frame on a dark backdrop is
  // then flipped like an image (its background takes the backdrop's colour), and told so: it
  // turns its own pictures back, except the ones it would have flipped anyway.

  const FRAME_LIGHT = 0.6; // a frame lighter than this is a white box on a dark page
  const frames = new Map(); // iframe, object or embed -> { L, picture, dark, verdict: what its document reported; on }

  function post(win, type, data) {
    try { win.postMessage({ [MSG]: type, ...data }, '*'); } catch (e) { /* gone */ }
  }

  /** The window inside a frame element: an <embed> only shows it for a same-origin SVG. */
  function windowOf(el) {
    try { return el.contentWindow || el.getSVGDocument?.()?.defaultView || null; } catch (e) { return null; }
  }

  /**
   * An SVG file shown in a frame (Doxygen's class diagrams, say) is a document of its own,
   * with no HTML to hold this script's machinery. Once it has loaded it is drawn into an image
   * and judged like one, and the verdict goes to the page around it, which flips the frame.
   */
  function svgFrame() {
    if (isTop) return;
    const C = globalThis.InkflipClassifier;
    let verdict = null;
    const send = () => {
      if (verdict) post(parent, 'report', { L: null, picture: false, dark: false, verdict });
    };
    addEventListener('message', (e) => {
      if (e.source === parent && e.data && e.data[MSG] === 'hello') send();
    });
    addEventListener('load', async () => {
      const root = document.documentElement;
      try {
        const im = new Image();
        im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
        await im.decode();
        // Its own size, or the frame's when it has none (width="100%"): the frame may not be
        // laid out yet, so not its box.
        const w = im.naturalWidth || innerWidth || 300, h = im.naturalHeight || innerHeight || 150;
        const px = C.pixels(im, w, h, true);
        verdict = C.classify(px.data, px.w, px.h).verdict;
      } catch (e) {
        verdict = 'none';
      }
      send();
    });
  }

  /**
   * Lightness of this document's background as its frame shows it: what is painted behind
   * the middle of it, by a layer covering at least half of it. null if nothing is (the page
   * around shows through), undefined if a background picture is.
   */
  function ownLightness() {
    if (darkReaderDark()) return 0.1; // being darkened, maybe not painted yet
    const html = document.documentElement, body = document.body;
    const area = innerWidth * innerHeight;
    const stack = area ? document.elementsFromPoint(innerWidth / 2, innerHeight / 2) : [];
    for (const n of [...stack, body, html]) {
      if (!n) continue;
      if (n !== body && n !== html) {
        const r = n.getBoundingClientRect();
        if (r.width * r.height < area / 2) continue;
      }
      const L = backgroundLightness(getComputedStyle(n));
      if (L !== null) return L;
    }
    return null;
  }

  let lastReport = ''; // what this frame last told the page around it
  function reportFrame(again) {
    if (isTop) return;
    const L = ownLightness();
    const msg = { L: L ?? null, picture: L === undefined, dark: canvasLightness() < 0.5 };
    const key = JSON.stringify(msg);
    if (!again && key === lastReport) return;
    lastReport = key;
    post(parent, 'report', msg);
  }

  function setFlipped(on) {
    if (on === flipped) return;
    flipped = on;
    if (on) document.documentElement.setAttribute(FLIPPED, '');
    else document.documentElement.removeAttribute(FLIPPED);
    if (shadowStyles.size) refreshStyle();
    themeChanged();
  }

  /**
   * How light a frame looks: its document's own background; where that is transparent, the
   * iframe's background, or the opaque canvas the browser paints behind a document whose
   * colour scheme differs from the iframe's. undefined until there is anything to go on.
   */
  function frameLightness(fr, st) {
    if (st.picture) return undefined;
    if (typeof st.L === 'number') return st.L;
    const cs = getComputedStyle(fr);
    if (st.L === null && schemeDark(cs.colorScheme) !== st.dark) return st.dark ? 0.07 : 1;
    return backgroundLightness(cs) ?? undefined;
  }

  function applyFrame(fr) {
    const st = frames.get(fr);
    if (!st || !fr.isConnected) return;
    // An SVG document reports its own verdict; any other one, how light it is.
    const L = st.verdict ? undefined : frameLightness(fr, st);
    const verdict = st.verdict || (typeof L === 'number' ? (L > FRAME_LIGHT ? 'flip' : 'none') : null);
    const r = fr.getBoundingClientRect();
    let on = false;
    // Where Dark Reader darkens the page, it darkens the frames in it as well (but not SVG files).
    if ((verdict === 'flip' || verdict === 'logo') && isActive() && treatmentOn(verdict) &&
        (st.verdict || !darkReaderDark()) &&
        r.width >= 8 && r.height >= 8 && (r.width > SMALL || r.height > SMALL)) {
      if (st.ownInverted === undefined) {
        st.ownInverted = !fr.hasAttribute(ATTR_L) && getComputedStyle(fr).filter.includes('invert');
      }
      const ctx = surroundings(fr, r);
      st.provisional = !ctx.measured;
      if (ctx.L <= DARK_PAGE && !ctx.inverted && !st.ownInverted) {
        on = true;
        const l = String(Math.min(40, Math.floor(ctx.floor * 50) * 2));
        if (fr.getAttribute(ATTR_L) !== l) fr.setAttribute(ATTR_L, l);
      }
    }
    if (!on) fr.removeAttribute(ATTR_L);
    if (!verdict) fr.removeAttribute(ATTR);
    else fr.setAttribute(ATTR, verdict);
    if (on !== st.on) {
      st.on = on;
      const win = windowOf(fr);
      if (win && !st.verdict) post(win, 'flipped', { on });
    }
    if (ready) fr.removeAttribute(WAIT);
    queueBadges();
  }

  function addFrame(fr) {
    if (frames.has(fr)) return;
    frames.set(fr, { on: false });
    frameSeen.observe(fr);
    // A white iframe is held, like an image, until settings say whether to flip it.
    if (!ready && backgroundLightness(getComputedStyle(fr)) > FRAME_LIGHT) fr.setAttribute(WAIT, '');
    applyFrame(fr); // its own background may already say (inside the MutationObserver: before paint)
    const win = windowOf(fr);
    if (win) post(win, 'hello');
  }

  function frameOf(win) {
    for (const fr of frames.keys()) if (windowOf(fr) === win) return fr;
    for (const fr of document.querySelectorAll(FRAMES)) {
      if (windowOf(fr) === win) { addFrame(fr); return fr; }
    }
    return null;
  }

  // Measure the real backdrop once a frame is on screen, as for images.
  const frameSeen = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) applyFrame(e.target);
  });

  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d[MSG] || !e.source) return;
    if (!isTop && e.source === parent) {
      if (d[MSG] === 'hello') reportFrame(true);
      else if (d[MSG] === 'flipped') setFlipped(!!d.on);
      else if (d[MSG] === 'peek') setPeek(!!d.on, parent);
      return;
    }
    const fr = frameOf(e.source);
    if (!fr) return;
    if (d[MSG] === 'report') {
      const st = frames.get(fr);
      st.L = typeof d.L === 'number' ? d.L : null;
      st.picture = !!d.picture;
      st.dark = !!d.dark;
      st.verdict = ['flip', 'logo', 'dim', 'none'].includes(d.verdict) ? d.verdict : null;
      applyFrame(fr);
      if (!st.verdict) post(e.source, 'flipped', { on: st.on }); // a new document in the frame needs telling
    } else if (d[MSG] === 'peek') {
      setPeek(!!d.on, e.source);
    }
  });

  // ------------------------------------------------- pictures that aren't <img>
  //
  // A diagram set as a CSS background, a picture in an SVG <image>, a video's poster: each is
  // known only by its address, judged like an image (from the cache, drawn here if same-origin,
  // or by the service worker) and treated with the same rules. A background is only taken on an
  // element that is nothing but that picture (no text, nothing else drawn in it), since the
  // filter covers the whole element. A poster's verdict lasts until the video plays.

  const IN_A_PICTURE = 'img,canvas,video,svg,iframe,object,embed,input,textarea,select,button';

  function considerPicture(el, src, kind = el instanceof SVGImageElement ? 'image' : 'bg') {
    try { src = src ? new URL(src, document.baseURI).href : ''; } catch (e) { src = ''; }
    let st = state.get(el);
    if (st && st.src === src) return st;
    if (st) { clearTags(el); }
    if (!src) { state.delete(el); return null; }
    if (!tracked.has(el)) {
      tracked.add(el);
      io.observe(el);
      seen.observe(el);
    }
    st = { kind, src, verdict: null };
    state.set(el, st);
    const mine = overrideFor(el, st);
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(el);
      return st;
    }
    lookup(el, st);
    if (near.has(el)) schedule(el);
    return st;
  }

  /**
   * One pass over `root`'s elements and their computed styles: elements whose only content is
   * a CSS background picture, and light boxes (below). Where Dark Reader darkens the page it
   * handles stylesheet backgrounds and boxes itself; only pictures set in a style attribute,
   * which it leaves as they are, are looked at there, and not again on every stylesheet it adds
   * (`rescan`): that cost the page enough time to delay image verdicts into a white flash.
   */
  function findPaint(root, rescan = false) {
    if (!root.querySelectorAll) return;
    if (darkReaderDark()) {
      if (rescan) return;
      const inline = [...root.querySelectorAll('[style*="url("]')];
      if (root.nodeType === 1 && root.matches('[style*="url("]')) inline.push(root);
      for (const el of inline) if (el.style.backgroundImage.includes('url(')) pictureIn(el, getComputedStyle(el));
      return;
    }
    const pictures = knownDark || pageLightness() <= DARK_PAGE;
    const boxes = boxesWanted();
    if (!pictures && !boxes) return;
    const els = root.nodeType === 1 ? [root, ...root.querySelectorAll('*')] : root.querySelectorAll('*');
    for (const el of els) {
      const cs = getComputedStyle(el);
      if (boxes && !(el instanceof SVGElement)) {
        const marked = el.hasAttribute(PANEL) || el.hasAttribute(FIELD);
        const L = backgroundLightness(cs);
        if ((marked || L > LIGHT_BOX) && el !== document.body && el !== document.documentElement && !isMedia(el) && !isFrame(el)) judgeBox(el, L);
      }
      if (pictures) pictureIn(el, cs);
    }
  }

  /** Take an element as a picture if its only content is a CSS background picture. */
  function pictureIn(el, cs) {
    if (el instanceof SVGElement || el === document.body || el === document.documentElement || isMedia(el) || isFrame(el)) return;
    const image = cs.backgroundImage;
    const st = state.get(el);
    if (!image.includes('url(') || image.includes('gradient(') || image.includes(',')) {
      if (st && st.kind === 'bg') { clearTags(el); state.delete(el); }
      return;
    }
    const src = /url\(["']?([^"')]+)["']?\)/.exec(image)?.[1];
    if (!src || (st && st.kind === 'bg' && st.src.endsWith(src))) return;
    const r = el.getBoundingClientRect();
    if (r.width <= SMALL && r.height <= SMALL) return; // icons and sprites
    if (el.querySelector(IN_A_PICTURE) || hasText(el)) return;
    considerPicture(el, src, 'bg');
  }

  // ------------------------------------------------------------- light boxes
  //
  // On a site that is dark by itself Dark Reader stays off, and every box the site paints
  // light stays a white block: a consent banner, a light card or demo panel, a light code
  // block, a plain text field. A light box on a dark backdrop, big enough to be more than a
  // button, is flipped as a whole, its pictures turned back as in a flipped frame (a light
  // panel holding only pictures is a card, dimmed instead). A light form control is switched to
  // the dark colour scheme, or flipped if the site set its colours itself. Where Dark Reader
  // darkens the page, boxes are its job.

  const LIGHT_BOX = 0.6; // a background lighter than this is a light box
  const BOX_W = 120, BOX_H = 40, BOX_AREA = 12000; // px: smaller ones are buttons, badges, chips
  const FIELDS = 'input:not([type]),input[type=text],input[type=search],input[type=email],input[type=url],' +
    'input[type=tel],input[type=password],input[type=number],textarea,select';
  const boxes = new Set(); // flipped boxes and switched fields, to let go of together

  function boxesWanted() {
    return isActive() && settings.panels && !flipped && !darkReaderDark() && pageLightness() <= DARK_PAGE;
  }

  /** Whether an element sits inside a flipped box (through shadow roots too). */
  function inBox(el) {
    for (let n = up(el); n; n = up(n)) if (n.hasAttribute(PANEL)) return true;
    return false;
  }

  function letGo(el) {
    el.removeAttribute(PANEL);
    el.removeAttribute(FIELD);
    boxes.delete(el);
  }

  function judgeBox(el, L) {
    if (inBox(el)) return letGo(el); // part of a flipped box already
    const r = el.getBoundingClientRect();
    const field = el.matches(FIELDS);
    if (field ? r.width < 24 || r.height < 12 : r.width < BOX_W || r.height < BOX_H || r.width * r.height < BOX_AREA) return letGo(el);
    if (!field && !(L > LIGHT_BOX)) return letGo(el); // no longer light (our filter leaves its background as it is)
    // Pictures and nothing to read: a picture card, dimmed with its pictures (see cards).
    if (!field && !hasText(el) && el.querySelector('img,canvas,video,svg,picture,iframe')) return letGo(el);
    const ctx = surroundings(el, r);
    if (ctx.L > DARK_PAGE || ctx.inverted) return letGo(el);
    boxes.add(el);
    if (field) {
      if (el.hasAttribute(FIELD)) return; // its computed colours are ours now
      // The browser's dark controls first: they keep the site's sizes and shapes. If the site
      // set the colours itself, they don't change, and the control is flipped instead.
      el.setAttribute(FIELD, 'scheme');
      const after = getComputedStyle(el);
      const bg = parseColor(after.backgroundColor), fg = parseColor(after.color);
      if (!(bg && luma(bg) <= DARK_PAGE && fg && luma(fg) >= 0.5)) el.setAttribute(FIELD, 'flip');
      return;
    }
    const l = String(Math.min(40, Math.floor(ctx.floor * 50) * 2));
    if (el.getAttribute(PANEL) !== l) el.setAttribute(PANEL, l);
  }

  // Stylesheets arriving can give elements backgrounds: look again, at most twice a second.
  let backgroundsTimer = 0;
  function backgroundsChanged() {
    if (!backgroundsTimer) backgroundsTimer = setTimeout(() => { backgroundsTimer = 0; findPaint(document, true); }, 500);
  }

  /** A video showing its poster: judge the poster until the video plays. */
  function watchPoster(v, st) {
    if (st.source === 'you') return;
    if (!st.listening) {
      st.listening = true;
      v.addEventListener('playing', () => {
        if (!st.poster || st.source === 'you') return;
        st.poster = false;
        st.src = ''; // a verdict still on its way no longer applies
        st.verdict = null;
        st.source = null;
        clearTags(v);
        queueBadges();
      });
    }
    const src = v.poster;
    if (!src || !v.paused || v.played.length) return;
    if (st.poster && st.src === src) return;
    st.poster = true;
    st.src = src;
    st.verdict = null;
    st.pending = false;
    clearTags(v);
    lookup(v, st);
    if (near.has(v)) schedule(v);
  }

  // --------------------------------------------------------------- discovery

  function consider(el) {
    if (!tracked.has(el)) {
      tracked.add(el);
      io.observe(el);
      seen.observe(el);
    }
    if (isImg(el)) return considerImage(el);
    let st = state.get(el);
    if (st) {
      if (st.kind === 'video') refreshVideo(el, st);
      return st;
    }
    st = isCanvas(el) ? { kind: 'canvas', verdict: null, w: el.width, h: el.height, checks: 0, t0: 0, timer: 0 }
      : isChart(el) ? { kind: 'svg', verdict: null, checks: 0, timer: 0 }
      : { kind: 'video', verdict: null, key: videoKey(el) };
    state.set(el, st);
    const mine = overrideFor(el, st);
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(el);
    } else if (st.kind === 'canvas') {
      if (hold) wait(el); // set inside the MutationObserver callback: before first paint
      if (near.has(el)) startCanvas(el, true);
    } else if (st.kind === 'svg') {
      if (near.has(el)) startSvg(el, true);
    } else if (st.kind === 'video') {
      watchPoster(el, st);
    }
    return st;
  }

  /** A video's source or the page address changed (YouTube reuses one element throughout). */
  function refreshVideo(v, st) {
    const key = videoKey(v);
    if (key === st.key) return;
    st.key = key;
    const mine = overrides[key];
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(v);
    } else if (st.verdict) {
      st.verdict = null;
      st.source = null;
      clearTags(v);
      queueBadges();
    }
  }

  /** Get a verdict under way, whatever kind of element it is. */
  function check(el) {
    const st = state.get(el);
    if (isImg(el) || st?.kind === 'bg' || st?.kind === 'image' || st?.poster) schedule(el);
    else if (isCanvas(el)) startCanvas(el, false);
    else if (isChart(el)) startSvg(el, false);
  }

  function considerImage(img) {
    const src = img.currentSrc || img.src || '';
    let st = state.get(img);
    if (st && st.src === src) return st;
    if (st) { clearTags(img); setCard(img, st, null); }
    if (!src) {
      state.delete(img);
      img.removeAttribute(WAIT);
      return null;
    }
    st = { kind: 'img', src, verdict: null };
    state.set(img, st);
    const mine = overrideFor(img, st);
    if (mine) {
      st.verdict = mine;
      st.source = 'you';
      apply(img);
      return st;
    }
    if (hold) wait(img); // set inside the MutationObserver callback: before first paint
    lookup(img, st);
    if (near.has(img)) schedule(img);
    return st;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      if (!e.isIntersecting) { near.delete(el); continue; }
      near.add(el);
      const st = consider(el);
      if (!st) continue;
      const b = e.boundingClientRect;
      if (b.width > 0 && b.width <= SMALL && b.height <= SMALL) el.removeAttribute(WAIT); // small: show at once
      if (st.kind === 'svg' && !st.verdict && hold && b.width >= SVG_MIN_W && b.height >= SVG_MIN_H) wait(el);
      if (!st.verdict) { check(el); placeCard(el, st); }
      else if (st.stale) apply(el);
    }
  }, { rootMargin: '800px', scrollMargin: '800px' });

  // Off-screen elements were tagged from their ancestors' background; measure the real
  // backdrop once they are actually visible. A canvas back on screen is polled again if it
  // was blank, or looked at once more if it may have been repainted since.
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      if (e.isIntersecting) visible.add(el);
      else visible.delete(el);
      const st = e.isIntersecting && state.get(el);
      if (!st) continue;
      if (st.verdict && st.provisional) apply(el);
      if (st.kind === 'svg' && !st.verdict) startSvg(el, false);
      if (st.kind !== 'canvas') continue;
      if (!st.verdict || st.source === 'blank') startCanvas(el, false);
      else if (performance.now() - (st.sampled || 0) > 5000) startCanvas(el, true);
    }
  });

  function loaded_(e) {
    const img = e.target;
    if (img instanceof HTMLLinkElement) { themeChanged(); return; } // a stylesheet arrived
    if (!(img instanceof HTMLImageElement)) return;
    const st = consider(img);
    if (st && !st.verdict && near.has(img)) schedule(img);
  }

  function failed(e) {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const st = consider(img);
    if (st && !st.verdict) {
      st.verdict = 'none';
      st.source = 'broken';
      apply(img);
    }
  }

  // Neither event bubbles out of a shadow root: each root gets these listeners too.
  document.addEventListener('load', loaded_, true);
  document.addEventListener('error', failed, true);

  function scan(rootNode) {
    findShadows(rootNode);
    if (isMedia(rootNode)) consider(rootNode);
    else if (isFrame(rootNode)) addFrame(rootNode);
    else if (rootNode instanceof SVGElement) svgChanged(rootNode); // drawn into a tracked chart
    else if (rootNode.querySelectorAll) {
      rootNode.querySelectorAll('img,canvas,video').forEach(consider);
      for (const svg of rootNode.querySelectorAll('svg')) if (isChart(svg)) consider(svg);
      rootNode.querySelectorAll(FRAMES).forEach(addFrame);
      for (const im of rootNode.querySelectorAll('image')) considerPicture(im, im.href?.baseVal || '');
    }
    if (rootNode instanceof SVGImageElement) considerPicture(rootNode, rootNode.href.baseVal);
    findPaint(rootNode);
  }

  const domObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (isImg(t)) consider(t);
        else if (isCanvas(t)) canvasResized(t);
        else if (isVideo(t) && m.attributeName === 'src' && state.has(t)) consider(t);
        else if (isVideo(t) && m.attributeName === 'poster' && state.has(t)) watchPoster(t, state.get(t));
        else if (t instanceof SVGImageElement) considerPicture(t, t.href.baseVal);
        continue;
      }
      if (m.target.nodeName === 'STYLE' && m.target !== style) themeChanged(); // stylesheet text edited
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'STYLE' || node.tagName === 'LINK') { if (node !== style) themeChanged(); }
        else scan(node);
      }
      for (const node of m.removedNodes) {
        if (node === style) refreshStyle();
        else if (node.nodeType === 1 && (node.tagName === 'STYLE' || node.tagName === 'LINK')) themeChanged();
      }
    }
  });
  const WATCH = { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'width', 'height', 'href', 'poster'] };
  domObserver.observe(document, WATCH);

  // ------------------------------------------------------------- shadow roots
  //
  // Web components keep their pictures in shadow roots (MDN's ad card, say), out of reach of
  // the page's selectors, stylesheets and load events. Each root found, open or closed, is
  // watched like the document, scanned, and given its own copy of the stylesheet. A custom
  // element that has no root yet may get one once its definition loads: it is looked at again
  // every second for a while.

  const shadowStyles = new Map(); // shadow root -> our <style> in it
  const pendingHosts = new Map(); // custom element without a root yet -> checks left

  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (!el.localName.includes('-')) return null; // closed roots belong to custom elements
    try { return chrome.dom?.openOrClosedShadowRoot?.(el) || null; } catch (e) { return null; }
  }

  function adoptShadow(root) {
    if (shadowStyles.has(root)) return;
    const s = document.createElement('style');
    s.className = 'stylus'; // see the main stylesheet
    s.textContent = buildCss(true);
    root.appendChild(s);
    shadowStyles.set(root, s);
    domObserver.observe(root, WATCH);
    root.addEventListener('load', loaded_, true);
    root.addEventListener('error', failed, true);
    scan(root);
  }

  function findShadows(node) {
    const look = (el) => {
      const root = shadowOf(el);
      if (root) { pendingHosts.delete(el); adoptShadow(root); }
      else if (el.localName.includes('-') && !pendingHosts.has(el) && pendingHosts.size < 2000) pendingHosts.set(el, 10);
    };
    if (node.nodeType === 1) look(node);
    if (node.querySelectorAll) for (const el of node.querySelectorAll('*')) look(el);
  }

  function checkPendingHosts() {
    for (const [el, left] of pendingHosts) {
      const root = el.isConnected && shadowOf(el);
      if (root) { pendingHosts.delete(el); adoptShadow(root); }
      else if (!el.isConnected || left <= 1) pendingHosts.delete(el);
      else pendingHosts.set(el, left - 1);
    }
  }

  // Theme switches: Dark Reader toggling, the site's own dark-mode class, the OS setting.
  const themeObserver = new MutationObserver((muts) => {
    if (muts.some((m) => m.attributeName !== PEEK)) themeChanged();
  });
  themeObserver.observe(document.documentElement, { attributes: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => themeChanged());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) themeChanged(); });

  // Backstop for theme changes no observer sees (stylesheets edited through the CSSOM).
  // Also notices single-page navigation, which gives a reused <video> a new identity.
  let lastDark = null;
  let lastHref = location.href;
  setInterval(() => {
    if (document.hidden || !ready || !document.body) return;
    if (location.href !== lastHref) {
      lastHref = location.href;
      for (const el of tracked) if (isVideo(el) && state.has(el)) consider(el);
    }
    const dark = pageLightness() <= DARK_PAGE;
    if (lastDark !== null && dark !== lastDark) themeChanged();
    lastDark = dark;
    reportFrame(false);
    if (pendingHosts.size) checkPendingHosts();
  }, 1000);

  // Re-check in the next animation frame, i.e. before the theme change is ever painted.
  let themeFrame = 0;
  function themeChanged() {
    if (!themeFrame) themeFrame = requestAnimationFrame(() => { themeFrame = 0; reevaluate(); });
    if (ready) backgroundsChanged();
  }

  function reevaluate() {
    if (!ready) return;
    const wasActive = isActive();
    detectFilterMode();
    if (wasActive !== isActive()) refreshStyle();
    rememberDarkness();
    updateHold();
    textCache = new WeakMap();
    for (const el of tracked) {
      const st = state.get(el);
      if (!el.isConnected) {
        if (st) setCard(el, st, null);
        tracked.delete(el); io.unobserve(el); seen.unobserve(el);
        continue;
      }
      if (!st) continue;
      if (!st.verdict) {
        if (near.has(el)) check(el);
        if (near.has(el) || st.card) placeCard(el, st);
        continue;
      }
      if (near.has(el) || st.card) apply(el); // a card far away still lets go when the page turns light
      else st.stale = true;
    }
    for (const fr of frames.keys()) {
      if (fr.isConnected) { applyFrame(fr); continue; }
      frames.delete(fr);
      frameSeen.unobserve(fr);
    }
    for (const el of boxes) if (!el.isConnected || !boxesWanted()) letGo(el);
    // Taken before Dark Reader started, a stylesheet background is now its job (it inverts it).
    if (darkReaderDark()) {
      for (const el of tracked) {
        const st = state.get(el);
        if (st && st.kind === 'bg' && !el.style.backgroundImage.includes('url(')) {
          clearTags(el);
          state.delete(el);
        }
      }
    }
    reportFrame(false);
    queueBadges();
  }

  /** Remember whether this site is dark, so the next visit hides images from the first byte. */
  function rememberDarkness() {
    if (!isTop || !document.body) return; // a frame's own colours say nothing about the site
    const dark = pageLightness() <= DARK_PAGE;
    if (dark && !knownDark) {
      knownDark = true;
      chrome.storage.local.set({ [DARK_KEY]: true }).catch(() => {});
    } else if (!dark && knownDark && document.readyState === 'complete') {
      knownDark = false;
      chrome.storage.local.remove(DARK_KEY).catch(() => {});
    }
  }

  // -------------------------------------------------------------------- peek

  /**
   * Show the originals, or stop. The page and its frames do it together, wherever the key
   * went: the change spreads through the tree of frames, never back to where it came from
   * (`from`, a window), or a quick press would echo back and forth between them.
   */
  function setPeek(on, from = null) {
    const html = document.documentElement;
    if (on === html.hasAttribute(PEEK)) return;
    if (on) html.setAttribute(PEEK, '');
    else html.removeAttribute(PEEK);
    peeking = on;
    if (swapTable.length || shadowStyles.size) refreshStyle();
    if (inlined.size) showInline(!on);
    if (!isTop && from !== parent) post(parent, 'peek', { on });
    for (const fr of frames.keys()) {
      const win = windowOf(fr);
      if (win && win !== from) post(win, 'peek', { on });
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && settings.peek === 'alt' && !e.repeat) setPeek(true);
  }, true);
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') setPeek(false); }, true);
  window.addEventListener('blur', () => setPeek(false));
  document.addEventListener('visibilitychange', () => setPeek(false));

  // -------------------------------------------------------- right-click menu
  //
  // Chrome has no menu context for a canvas, nor for an image or video under a transparent
  // layer (pdf.js's text layer, YouTube's controls). So Inkflip's menu matches every
  // right-click and stays hidden: this script tells the service worker what is under the
  // pointer, and it shows the menu, worded for an image or a video, while there is one. When
  // a choice is made, the service worker asks this frame what was right-clicked.

  let menuTarget = null; // the image, canvas or video under the last right-click
  let reported; // what this document last told the service worker; undefined: tell it again
  let px = -1, py = -1, pointerTimer = 0;

  /** The image, canvas or video visible at a point, looking through transparent layers. */
  function mediaAt(x, y) {
    let stack = document.elementsFromPoint(x, y);
    for (let depth = 0; depth < 4 && stack.length; depth++) { // into the shadow roots on top
      const root = shadowOf(stack[0]);
      const inner = root ? root.elementsFromPoint(x, y) : [];
      if (!inner.length || inner[0] === stack[0]) break;
      stack = inner;
    }
    for (let i = 0; i < stack.length; i++) {
      let el = stack[i];
      if (el instanceof SVGElement && !isChart(el) && el.ownerSVGElement) {
        while (el.ownerSVGElement) el = el.ownerSVGElement; // a shape in a chart: the chart
        if (state.get(el)?.kind !== 'svg') continue;
      }
      if (isMedia(el)) return { el };
      const kind = state.get(el)?.kind;
      if (kind === 'bg' || kind === 'image') return { el };
      if (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement ||
          el instanceof HTMLEmbedElement || el instanceof HTMLObjectElement) return { frame: true };
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c && c.a >= 0.5) break; // an opaque layer hides whatever is below it
    }
    return {};
  }

  function report(kind) {
    if (kind === reported) return;
    reported = kind;
    send({ type: 'menu', kind, t: Date.now() });
  }

  function reportAt(x, y) {
    const hit = mediaAt(x, y);
    if (hit.frame) return; // the frame's own copy of this script reports
    report(!hit.el ? null : isVideo(hit.el) ? 'video' : 'image');
  }

  function pointerMoved() {
    if (pointerTimer || px < 0) return;
    reportAt(px, py);
    pointerTimer = setTimeout(() => { pointerTimer = 0; reportAt(px, py); }, 100);
  }

  addEventListener('pointermove', (e) => {
    px = e.clientX;
    py = e.clientY;
    pointerMoved();
  }, { capture: true, passive: true });
  // Entering this document from outside it (or from a parent frame): report afresh.
  addEventListener('pointerover', (e) => { if (!e.relatedTarget) reported = undefined; }, { capture: true, passive: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) report(null); }, true);
  addEventListener('focus', () => { reported = undefined; });
  document.addEventListener('visibilitychange', () => { reported = undefined; });
  for (const type of ['mousedown', 'contextmenu']) {
    addEventListener(type, (e) => {
      if (type === 'mousedown' && e.button !== 2) return;
      menuTarget = mediaAt(e.clientX, e.clientY).el || null;
      reportAt(e.clientX, e.clientY);
    }, true);
  }

  /** The key a right-click choice on the last right-clicked element is stored under. */
  function menuKey() {
    const el = menuTarget;
    if (!el || !el.isConnected) return null;
    const st = consider(el);
    if (!st) return null;
    return st.kind === 'img' || st.kind === 'bg' || st.kind === 'image' ? st.src
      : st.kind === 'canvas' || st.kind === 'svg' ? canvasKey(el) : st.key;
  }

  // ------------------------------------------------------------------ badges

  let badgeLayer = null;
  let badgeFrame = 0;
  const BADGE_COLORS = { flip: '#f2b45a', logo: '#5fd0c0', dim: '#b9a3ff', none: '#8a8f98' };

  function queueBadges() {
    if (!badgeFrame && (settings.badges || badgeLayer)) {
      badgeFrame = requestAnimationFrame(drawBadges);
    }
  }

  function drawBadges() {
    badgeFrame = 0;
    if (!settings.badges || !isActive()) {
      if (badgeLayer) { badgeLayer.host.remove(); badgeLayer = null; }
      return;
    }
    if (!badgeLayer) {
      const host = document.createElement('inkflip-badges');
      host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        b{position:fixed;font:600 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#111;
          padding:1px 6px;border-radius:5px;white-space:nowrap;box-shadow:0 1px 4px #0008}
        b i{font-style:normal;font-weight:400;opacity:.75}
      </style><div></div>`;
      document.documentElement.appendChild(host);
      badgeLayer = { host, list: root.querySelector('div') };
    }
    const vw = innerWidth, vh = innerHeight;
    let html = '';
    for (const img of tracked) {
      const st = state.get(img);
      if (!st || !st.verdict || !img.isConnected) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 16 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      const shown = st.card ? 'dim' : img.hasAttribute(ATTR_L) ? st.verdict : 'none';
      const why = st.card ? 'whole card' : st.source === 'you' ? 'your choice'
        : !st.dark ? (pageLightness() <= DARK_PAGE ? 'sits on light' : 'page is light') : st.inverted ? 'already inverted'
        : st.signals ? `tone ${st.signals.tone.toFixed(2)} · fg ${st.signals.fg90}` : st.source;
      html += `<b style="left:${Math.max(0, r.left) + 4}px;top:${Math.max(0, r.top) + 4}px;` +
        `background:${BADGE_COLORS[shown]}">${shown} <i>${why}</i></b>`;
    }
    for (const [fr, st] of frames) {
      if (!fr.isConnected || !fr.hasAttribute(ATTR)) continue;
      const r = fr.getBoundingClientRect();
      if (r.width < 24 || r.height < 16 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      const shown = st.on ? fr.getAttribute(ATTR) : 'none';
      const why = (st.verdict ? 'svg file' : 'frame') + (fr.getAttribute(ATTR) !== 'none' && !st.on ? ' · sits on light' : '');
      html += `<b style="left:${Math.max(0, r.left) + 4}px;top:${Math.max(0, r.top) + 4}px;` +
        `background:${BADGE_COLORS[shown]}">${shown} <i>${why}</i></b>`;
    }
    badgeLayer.list.innerHTML = html;
  }
  addEventListener('scroll', () => { queueBadges(); pointerMoved(); }, { capture: true, passive: true });
  addEventListener('resize', queueBadges, { passive: true });

  // ---------------------------------------------------------------- settings

  function treatmentOn(verdict) {
    return verdict === 'flip' ? settings.flip : verdict === 'logo' ? settings.logo
      : verdict === 'dim' ? settings.dim : false;
  }

  function stats() {
    const counts = { flip: 0, logo: 0, dim: 0, none: 0, pending: 0 };
    for (const img of tracked) {
      if (!img.isConnected) continue;
      const st = state.get(img);
      if (!st) continue;
      if (st.card) { counts.dim++; continue; }
      if (!st.verdict) { if (st.pending) counts.pending++; continue; }
      const shown = img.hasAttribute(ATTR_L) && treatmentOn(st.verdict) ? st.verdict : 'none';
      counts[shown]++;
    }
    for (const [fr, st] of frames) if (fr.isConnected && fr.hasAttribute(ATTR)) counts[st.on ? fr.getAttribute(ATTR) : 'none']++;
    return {
      counts, host: HOST, active: isActive(), filterMode,
      pageDark: pageLightness() <= DARK_PAGE, darkReader: detectDarkReader(),
    };
  }

  function applyOverrides() {
    for (const el of tracked) {
      const st = state.get(el);
      if (!st) continue;
      const mine = overrideFor(el, st);
      if (mine) {
        st.verdict = mine;
        st.source = 'you';
      } else if (st.source === 'you') {
        st.verdict = null;
        st.source = null;
        clearTags(el);
        if (st.kind === 'img' || st.kind === 'bg' || st.kind === 'image') {
          st.pending = false;
          lookup(el, st);
          schedule(el);
        } else if (st.kind === 'canvas') {
          if (st.gl) settle(el, st, 'none', null, 'webgl');
          else startCanvas(el, true);
        } else if (st.kind === 'svg') {
          startSvg(el, true);
        }
        queueBadges();
        continue;
      }
      if (st.verdict) apply(el);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = { ...DEFAULTS, ...changes.settings.newValue };
      refreshStyle();
      reevaluate();
      backgroundsChanged(); // boxes and backgrounds may be wanted again
    }
    if (area === 'local' && changes[OVR_KEY]) {
      overrides = changes[OVR_KEY].newValue || {};
      applyOverrides();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg) return;
    if (msg.type === 'stats' && isTop) reply(stats());
    else if (msg.type === 'menu-target') reply(menuKey());
  });

  function topHost() {
    if (window === window.top) return location.hostname;
    const ao = location.ancestorOrigins;
    if (ao && ao.length) {
      try { return new URL(ao[ao.length - 1]).hostname; } catch (e) { /* fall through */ }
    }
    return location.hostname;
  }

  // -------------------------------------------------------------------- start

  refreshStyle();
  scan(document);

  Promise.all([
    chrome.storage.sync.get('settings'),
    chrome.storage.local.get([OVR_KEY, DARK_KEY]),
  ]).then(([s, local]) => {
    settings = { ...DEFAULTS, ...(s.settings || {}) };
    overrides = local[OVR_KEY] || {};
    knownDark = !!local[DARK_KEY];
    ready = true;
    detectFilterMode();
    refreshStyle();
    applyOverrides();
    reevaluate();
    if (document.readyState !== 'loading') findPaint(document); // boxes and backgrounds wait for settings
  }).catch(() => {
    ready = true; // storage unavailable: run with defaults rather than hide images
    refreshStyle();
    reevaluate();
  });

  document.addEventListener('DOMContentLoaded', () => {
    scan(document);
    if (document.body) themeObserver.observe(document.body, { attributes: true });
    themeChanged();
  });
  addEventListener('load', () => themeChanged());
})();
