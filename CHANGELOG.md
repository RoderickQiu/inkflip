# Changelog

## Unreleased

- Light embedded pages are darkened. On a site that is dark by itself, such as react.dev, Dark
  Reader switches off and leaves iframes as they are, so live code previews and other embeds
  stayed white. Each frame now tells the page around it how light it is, and a light frame on
  a dark page is flipped like a diagram: its background takes the colour of the panel behind
  it. The frame is told it was flipped and turns its photos back, so they keep their colours.
  Alt shows the original frame too. Where Dark Reader darkens the page, frames are left to it.
- SVG files shown in a frame or an `<object>` (Doxygen's class diagrams, for one) are drawn
  into an image, judged like any other, and flipped, with or without Dark Reader. Frames
  written by script (`srcdoc`, `about:blank`) are reached too.
- A frame no longer clears the site's "dark" note that lets images be held from the first
  byte on the next visit.
- White logos on sites that are dark by themselves no longer disappear. Two kinds were being
  flipped into the background: a dense white logo with only narrow gaps (Hex on
  claude.com), which looked like a white picture, and a white wordmark beside an icon with a
  dark outline (Notability), which looked like a diagram drawn for white paper. The
  classifier now also looks at the image's outline. A white logo meets the page in thin white
  strokes, and a diagram meets it in dark lines. A light window screenshot is outlined in white
  too, but it is one solid block, so it still flips.
- Charts and diagrams drawn as inline SVG are handled. Each large one is drawn into an image
  in the colours it shows and judged like a picture; one on its own white paper is flipped
  whole. On a page Dark Reader darkens, it keeps SVG fills light (it treats them like text),
  which left Plotly's plot areas and distill.pub's boxes light: Inkflip now recolours such a
  chart shape by shape, light shapes dark and dark text, lines and small marks light, shapes
  drawn by `<use>` from another SVG's `<defs>` included. On a site that is dark by itself it
  only darkens a chart's large light panels.
- Inkflip's stylesheet is marked as a user style, so Dark Reader leaves its colours alone.
- Light cards drawn in grey on a transparent background, such as the figure previews on
  distill.pub, are flipped. They have no black ink, so they used to pass for white logos made
  for dark pages; the classifier now also counts grey lines and labels, which a white logo
  doesn't have.
- Diagrams with most of their parts drawn faint, such as the LSTM figures on colah's blog,
  are flipped. The soft edges of their pale lines used to pass for photo shading.
- Black-and-white and sepia photographs, cut out or on white, are never flipped. With no
  colour to count they could look like flat graphics; their soft shading now marks them as
  photos. The labelled field set scores 392 of 393 (one waveform is dimmed instead of
  flipped) with no wrong flips, up from 389, and 240 cut-out photo variants built for this
  test only flip when washed out until they are almost flat.
- Verdicts cached by older versions are thrown away, so these images are judged again.

## 0.3.0 (6 October 2026)

- Canvases get the same verdicts as images. This covers charts and PDF pages that sites draw
  with script, such as pdf.js viewers. A canvas is checked as it comes near the screen and
  again while it redraws. On dark pages a blank canvas stays hidden for up to half a second, so
  it shows up already dark. WebGL canvases and canvases holding a picture from another site
  can't be read and are left alone.
- The right-click menu works on canvases and videos, and on images and videos under a
  transparent layer, such as pdf.js's text layer or YouTube's player controls. Videos are only
  ever changed from this menu.
- On a dark site, a light panel that holds only pictures and no text is dimmed together with
  its pictures, so screenshots keep their real colours instead of glaring.
- On a site that is dark without Dark Reader, an image on a light panel now shows at once
  instead of after 2.5 seconds.
- The popup links to the Inkflip website and to the author's site.

## 0.2.0 (6 October 2026)

Field-tested on 73 real pages, including the sites people have complained about in Dark
Reader's issue tracker, and tuned on 393 hand-labelled images taken from them.

- **Transparent diagrams are now fixed.** Black lines and labels on a transparent PNG
  (Wikipedia chemistry and graph diagrams, cp-algorithms, colah's LSTM posts, README logos)
  vanish on a dark page. Inkflip now flips these, including ones with coloured nodes or light
  fills, and still leaves white logos made for dark backgrounds alone.
- **No more flipped product photos.** White products rendered on white (IKEA's catalogue) were
  being flipped into dark ones. A shaded image with no dark ink at all now counts as a photo
  and is only dimmed. Heatmaps are dimmed instead of flipped.
- **SVG images are judged like PNGs.** They are rendered at full size before sampling, so their
  thin strokes no longer look like photographic gradients.
- **Hotlink-protected images work.** Chrome sends no Referer on extension requests, so hosts
  such as Stack Overflow's i.sstatic.net refused them and every image there was skipped. A
  session rule now sends the page's origin, as the page itself did.
- **Avatars and icons appear at once.** Images under 48 px are never hidden while checked, and
  never dimmed.
- **Steadier no-flash hold.** Images on screen are checked before off-screen ones, and the
  safety reveal waits 2.5 s instead of 1.5 s.
- New tools: `npm run field` (headless field test with screenshots), `npm run harvest` and
  `npm run eval` (label real images and score the classifier).

## 0.1.0 (5 October 2026)

First release.

- Per-image classifier: flip diagrams and charts, brighten dark logos, dim photos on white,
  leave everything else alone. Photos are never flipped.
- Exact colour match: reads the backdrop actually painted behind each image (sibling layers
  included) and blends the flipped image into it with `mix-blend-mode: lighten`.
- No white flash: on dark pages, new images stay hidden until checked; cached verdicts apply
  before the image loads.
- Cross-origin images are read by the service worker, including SVG.
- Steps aside on light pages, on sites you switch off, in Dark Reader's Filter mode, and inside
  anything already inverted.
- Popup with a live tally, per-treatment switches, dim strength, peek mode and verdict badges.
- Right-click corrections per image, remembered per site. Keyboard shortcut to toggle a site.
- Tests: unit (Node), 19 labelled real images (Chromium), 37 end-to-end checks including live
  LeetCode next to Dark Reader.
