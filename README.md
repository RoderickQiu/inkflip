<p align="center">
  <img src="extension/icons/icon-128.png" width="88" alt="Inkflip icon">
</p>

<h1 align="center">Inkflip</h1>

<p align="center"><b>Dark mode for the images Dark Reader leaves white.</b></p>

<p align="center">
  <a href="https://inkflip.r-q.name">Website</a> ·
  <a href="https://inkflip.r-q.name/download/inkflip-0.2.0.zip">Download for Chrome</a> ·
  <a href="https://inkflip.r-q.name/privacy">Privacy</a>
</p>

![A flow-network diagram with Dark Reader alone (edges and labels invisible) and with Inkflip (readable)](docs/images/hero.png)

You turn on Dark Reader and the page goes dark, but then you scroll into a diagram. A white
rectangle lights up the room. Or worse, a black chart on a transparent background melts into
the page and you can't read it at all.

Dark Reader recolours pages, not pictures. Inkflip is the missing half: a small extension that
runs next to it, looks at every image on the page, and fixes the ones that were drawn for white
paper. Photos stay exactly as they are.

## Before and after

All captured on real pages with Dark Reader in its default mode, then again with Inkflip added.

<table>
  <tr>
    <th width="50%">Dark Reader alone</th>
    <th width="50%">Dark Reader + Inkflip</th>
  </tr>
  <tr>
    <td><img src="site/img/transformer-before.jpg" alt="Transformer figure, labels invisible"></td>
    <td><img src="site/img/transformer-after.jpg" alt="Transformer figure, labels readable"></td>
  </tr>
  <tr>
    <td colspan="2">The Transformer figure from <a href="https://arxiv.org/html/1706.03762v7">“Attention Is All You Need”</a>. Its black labels (Inputs, Outputs, Positional Encoding, N×) disappear without Inkflip.</td>
  </tr>
  <tr>
    <td><img src="site/img/readme-logo-before.jpg" alt="Black README logo, nearly invisible"></td>
    <td><img src="site/img/readme-logo-after.jpg" alt="README logo, clearly visible"></td>
  </tr>
  <tr>
    <td colspan="2">A black logo in a GitHub README (<a href="https://github.com/cosmos/gravity-bridge/issues/358">reported in 2021</a>, still open).</td>
  </tr>
  <tr>
    <td><img src="site/img/leetcode-before.jpg" alt="LeetCode diagram, a white square on a dark page"></td>
    <td><img src="site/img/leetcode-after.jpg" alt="LeetCode diagram blended into the dark panel"></td>
  </tr>
  <tr>
    <td colspan="2">The example diagram on <a href="https://leetcode.com/problems/k-closest-points-to-origin/">LeetCode 973</a>. The paper takes the exact colour of the panel behind it.</td>
  </tr>
</table>

More pairs, with a slider, on [the website](https://inkflip.r-q.name).

## You're not the only one

People have been asking Dark Reader for this for years:

> “bright white diagrams shining in my eyes”<br>
> [Hacker News](https://news.ycombinator.com/item?id=21196669), 2019

> “Often it's completely invisible (black font on black background)”<br>
> on Wikipedia formulas, [Dark Reader #1273](https://github.com/darkreader/darkreader/issues/1273)

> “the png gets that dark grey color as it's background, making it unreadable”<br>
> on chemistry diagrams, [Dark Reader #11205](https://github.com/darkreader/darkreader/issues/11205), still open

Dark Reader's own answer is to write a CSS rule per site, by hand. Inkflip does it per image,
automatically.

## What it does

Inkflip samples each picture and makes one of four calls:

| | Which images | What happens |
|---|---|---|
| **Flip** | Black-on-white diagrams, charts, plots, text screenshots, and transparent diagrams drawn for white paper | Brightness is inverted, colours keep their hue, and the paper becomes the colour of the panel behind it |
| **Brighten** | Black logos, formulas and line drawings on a transparent background | The ink turns light, so it shows up |
| **Dim** | Photos on white, colourful infographics | Toned down a little. Never inverted, because a flipped photo looks like a negative |
| **Leave** | Ordinary photos, images that are already dark, anything Dark Reader or the site already inverted | Nothing |

Canvases get the same four calls, so charts and PDF pages that a page draws with script are
fixed too (pdf.js, which many sites embed to show PDFs, draws every page on a white canvas).
Videos are only ever changed when you ask, from the right-click menu.

On a dark site, a light card that holds nothing but pictures (a product screenshot on a pastel
panel, an app window on a coloured slab) is dimmed as a whole, panel and pictures together. The
screenshot keeps its real colours and the panel stops glaring. A light panel with text in it is
something to read, not a frame, so it is left alone.

## Why you can leave it on

- **It doesn't flip photos.** It was field-tested on 73 real sites (LeetCode, Wikipedia, arXiv,
  docs, Stack Overflow, GitHub, IKEA, Amazon, photo sites) and tuned on 393 hand-labelled images
  from them. It flips none of the photos and gets 389 of the 393 right. When it's unsure, it dims or does
  nothing.
- **No white flash.** On a dark page, a new image stays hidden from the moment it appears until
  it has been checked, then shows up already dark. Verdicts are cached, so revisits are instant.
  A new canvas stays hidden while it is still blank, so it too shows up already dark.
- **It gets out of the way.** Light pages, sites you switch off, and images that are already
  inverted are left alone. Hold <kbd>Option</kbd> (<kbd>Alt</kbd> on Windows) to see any original.
- **Nothing leaves your browser.** No account, no server, no analytics.

## Install

The Chrome Web Store listing is on its way. Until then:

1. Download [inkflip-0.2.0.zip](https://inkflip.r-q.name/download/inkflip-0.2.0.zip) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.

Works in Chrome, Edge, Brave, Arc and other Chromium browsers (version 116+). Keep Dark Reader in
its default **Dynamic** mode.

## Using it

- **The popup** shows what Inkflip did on the current page, with switches for each treatment, the
  current site, and everything.
- **Correct a call:** right-click an image, canvas or video › **Inkflip** › Flip / Dim / Show as
  is / Let Inkflip decide. This works through transparent layers too, such as the text layer
  pdf.js puts over a page or YouTube's player controls. Your choice is remembered for that site.
  An image or a video file is remembered by its address. A streamed video is remembered for
  that page. A canvas is remembered by where it sits, so one choice covers every page of a PDF
  viewer.
- **Toggle a site:** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> (change it at `chrome://extensions/shortcuts`).
- **Verdict badges:** switch them on in the popup to label every image with what Inkflip decided
  and why.

<p align="center"><img src="docs/images/badges.png" alt="Verdict badges on a test page" width="820"></p>

## How it works

Each image is sampled down to 128 px (SVGs are rendered at full size first so thin strokes stay
crisp). Seven numbers come out: how much is white paper, whether the border is paper,
transparency, dark ink, strong colour, the size of the palette, and **tone**, the share of soft
gradients between neighbouring pixels. Photos are full of soft gradients and diagrams have almost
none, which is what keeps photos safe. The rules and the reasoning behind each threshold are in
[`extension/classifier.js`](extension/classifier.js).

To blend in, Inkflip reads the colour actually painted behind the image (through the browser's
hit-test stack, because the visible panel isn't always a parent element), inverts the image to
just under that colour, and blends it with `mix-blend-mode: lighten`. The paper ends up exactly
the panel's colour, tinted panels included.

A canvas has no load event, and the page can paint it at any time. Inkflip samples it as it
comes near the screen, keeps looking while it is still blank, and looks again a few times
over the next six seconds, because charts animate in and PDF pages render in passes. A
resize clears a canvas, so that starts the checks over, and the flip stays on while it
repaints. Once a canvas has a verdict, two samples in a row must agree before it changes.

| Test suite | What it covers | Result |
|---|---|---|
| `npm test` | Classifier on synthetic diagrams, photos, logos, transparent graphs, white product renders and heatmaps | 15 / 15 |
| `npm run test:real` | Classifier in Chromium on 19 labelled images | 19 / 19 |
| `npm run eval` | 393 hand-labelled images from 48 real pages | 389 / 393, 0 photos flipped |
| `npm run test:e2e -- --live` | The real extension, headless: cross-origin and SVG images, canvases painted early, late, tainted and by WebGL, picture cards on dark sites, theme switches, peek, per-site off, right-click choices on images, canvases and video (through transparent layers too), cache, Dark Reader alongside, live LeetCode, and a frame-by-frame check that no image or canvas shows white first | 91 / 91 |
| `npm run test:menu` | Chrome's real right-click menu, in headed Chromium on a virtual screen (Docker): one Inkflip entry on images, canvases and videos, through transparent layers too, none on plain text, and choices clicked with a real mouse | 11 / 11 |

## Limitations

- Only `<img>` and `<canvas>` elements are judged. CSS background images and inline SVG are
  Dark Reader's job.
- A picture card is recognised from its own background colour or gradient. A card painted by a
  separate layer behind it, or by a background picture, is left alone.
- Video is never changed on its own: inverting people and scenery makes them look like a
  negative. Right-click › Flip works for screen recordings and slides.
- Two kinds of canvas can't be read reliably, so they're left alone unless you right-click
  them. WebGL canvases (maps, 3D views) drop each frame once it's on screen. A canvas that has
  had a picture from another site drawn into it is locked by the browser.
- A canvas first painted more than half a second after it appears shows white briefly before
  it flips.
- Colourful transparent diagrams with thin black text are left alone, because a filter that
  rescues their text would also recolour colourful logos. Right-click › Flip works for these.
- Images of 48 px or less (avatars, icons) are never flipped or dimmed: too few pixels to judge.
- Dark Reader's Filter and Filter+ modes invert the whole page; Inkflip notices and stands by.
- Images from other sites are downloaded twice, once by the page and once by Inkflip, because the
  page isn't allowed to share their pixels.

## Permissions

| Permission | Why |
|---|---|
| Read and change data on all sites | Find images on any page, read their pixels, and tag them |
| `storage` | Settings, per-site switches, right-click choices |
| `contextMenus` | The right-click corrections |
| `declarativeNetRequestWithHostAccess` | Some image hosts (Stack Overflow's, for one) refuse requests without a Referer, and Chrome sends none from extensions. A rule limited to Inkflip's own requests sends the page's origin, as the page itself did |

Full policy: [PRIVACY.md](PRIVACY.md).

## Development

```sh
npm install                      # Playwright, used by the browser tests and asset scripts
npm test                         # unit tests, no browser needed
npm run test:real                # downloads the labelled images, runs the classifier in Chromium
npm run fetch:darkreader         # Dark Reader's MV3 build, for the e2e test
npm run test:e2e -- --live       # loads the extension headless; --live adds LeetCode
npm run test:menu                # Chrome's real right-click menu, in Docker on a virtual screen
npm run package                  # dist/inkflip-<version>.zip

npm run field                    # field test on research/field-pages.tsv, headless, dark OS scheme
npm run field:report             # → screenshots/field/report.html and contact-sheet.png
npm run harvest                  # download the field images for labelling
npm run eval                     # score the classifier against research/field-labels.tsv

npm run showcase                 # recapture the before/after pairs in site/img
npm run site                     # package + copy the zip into site/ + render site/og.png
npm run assets                   # README hero; store images into dist/store
```

```
extension/            the extension (load this folder unpacked)
  classifier.js       pixel signals and verdicts, shared by every part
  content.js          finds, tags and styles images and canvases; no-flash hold; badges
  background.js       reads cross-origin images, verdict cache, right-click menus, shortcut
  popup/              the toolbar popup
site/                 the website (static, deployed on Vercel)
research/             field-test pages, hand-labelled images, harvest and eval tools
test/                 unit, real-image, end-to-end and field tests
scripts/              icons, showcase captures, site and store assets, packaging
docs/images/          README images
```

## Credits

The idea of judging "ink on paper" by palette and tone came from
[Kararead PR #84](https://github.com/L-K-M/Kararead/pull/84). The before/after screenshots show
pages from arXiv, cp-algorithms, LeetCode, GitHub and a personal blog, each linked to its source;
field-test images are downloaded at test time and not stored here. The website uses
[Atkinson Hyperlegible Next](https://github.com/googlefonts/atkinson-hyperlegible-next) (SIL OFL).

Inkflip is not affiliated with Dark Reader.

## License

[MIT](LICENSE)
