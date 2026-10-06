# Changelog

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
