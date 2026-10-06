# Changelog

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
