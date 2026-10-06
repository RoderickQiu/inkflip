<p align="center">
  <img src="extension/icons/icon-128.png" width="96" alt="Inkflip icon">
</p>

<h1 align="center">Inkflip</h1>

<p align="center"><b>Dark mode for the images Dark Reader leaves white.</b><br>
A small Chrome extension that runs next to Dark Reader and fixes pictures, one at a time.</p>

![LeetCode with Dark Reader, before and after Inkflip](docs/images/hero.png)

Dark Reader darkens page colours, but it never looks inside `<img>` elements. Diagrams on
LeetCode, matplotlib charts, screenshots of docs and black logos keep their white
backgrounds, so you get bright rectangles on an otherwise dark page, or logos you can't see.
Inkflip checks each image's pixels and gives it one of four treatments. Everything else stays
with Dark Reader.

| Treatment | Which images | What happens |
|---|---|---|
| **Flip** | Black-on-white line art (diagrams, plots, text screenshots), and transparent diagrams drawn for white paper (light boxes, black lines and labels) | Brightness is inverted and hues are kept. The white paper takes the exact colour of the panel behind it. |
| **Brighten logos** | Dark ink on a transparent background: logos, formulas, line diagrams with coloured nodes | The ink turns light, so it shows up on dark pages |
| **Dim** | Photos on white, colourful infographics | Brightness is lowered. These are never flipped, because a flipped photo looks like a negative. |
| **Leave** | Ordinary photos, images that are already dark | Nothing |

A wrong flip is far worse than a missed one, so when Inkflip is unsure, it dims or leaves the
image alone.

## Install

The extension isn't on the Chrome Web Store yet. To load it from source:

1. Download this repository, or a release zip unpacked into a folder.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder.

This works in Chrome, Edge, Brave, Arc and other Chromium browsers, version 116 or newer.
Keep Dark Reader in its default **Dynamic** mode.

## Using it

- **The popup** shows what Inkflip did on the current page, with switches for each treatment,
  for the current site and for everything.
- **Peek at the original:** hold <kbd>Option</kbd> (<kbd>Alt</kbd> on Windows and Linux), or
  pick hover in the popup.
- **Correct a call:** right-click an image and choose **Inkflip › Flip this image / Dim this
  image / Show this image as is / Let Inkflip decide**. Inkflip remembers the choice for that
  site.
- **Toggle a site:** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>. You can change the shortcut at
  `chrome://extensions/shortcuts`.
- **Verdict badges:** switch them on in the popup to label each image with what Inkflip
  decided and why.

<p align="center"><img src="docs/images/badges.png" alt="Verdict badges on the test page" width="820"></p>

## How it decides

Each image is sampled down to 128 px with nearest-neighbour scaling, which keeps thin lines
intact (SVGs are first rendered at full size, so their strokes stay solid too). Seven numbers
are measured from the sample: how much of it is white paper, whether the border is paper,
transparency, dark ink, strong colour, the size of the foreground palette, and **tone**, the
share of soft gradients between neighbouring pixels. Photos are full of soft
gradients and diagrams have almost none, which is what keeps photos from being flipped. The
rules, with the reasoning behind each threshold, are in
[`extension/classifier.js`](extension/classifier.js).

How it blends in:

- **Exact colour match.** Inkflip reads the colour actually painted behind the image, through
  the browser's hit-test stack, because a parent element isn't always the one painting it
  (LeetCode paints its panels on a sibling layer). It inverts to just below that colour, then
  blends with `mix-blend-mode: lighten`. The image's background ends up exactly the panel's
  colour, tinted panels included.
- **No white flash.** On dark pages, a new image stays invisible from the moment it enters the
  page until it has been checked. It first appears already dark. Verdicts are cached, so on a
  revisit the image is ready before it has even loaded. A watchdog never keeps a loaded image
  hidden for more than 2.5 s. Avatars and icons of 48 px or less are never hidden.
- **Gets out of the way.** On a light page, or a site you've switched off, Inkflip does
  nothing. It won't flip anything that is already inverted, for example by a Dark Reader
  `INVERT` site fix, so nothing gets flipped twice.

## Tested

| Suite | What it covers | Result |
|---|---|---|
| `npm test` | Classifier on synthetic diagrams, photos, logos, transparent graphs, white product renders and heatmaps, in Node | 15 / 15 |
| `npm run test:real` | Classifier inside Chromium on the 19 labelled images from the design phase | 19 / 19 |
| `npm run eval` | 393 real images from 48 field-tested pages, each labelled by hand with its acceptable treatments | 389 / 393, **0 photos flipped** |
| `npm run test:e2e -- --live` | The real extension, loaded headless: same-origin, cross-origin and SVG images, theme switching, peek, per-site off, right-click choices, cache, Dark Reader alongside, and live LeetCode. A frame-accurate monitor checks that no image shows white first. | 38 / 38 |
| `npm run field` | 73 real pages (LeetCode, Wikipedia, docs, papers, Stack Overflow, GitHub READMEs, shops, photo sites, and pages from Dark Reader's issue tracker), before/after screenshots | see `npm run field:report` |

The four images the classifier still misses are diagrams that fade most of their drawing on
purpose. It leaves them alone rather than risk flipping a photo.

## Privacy

Nothing leaves your browser. Inkflip has no server and no analytics.

- To read a cross-origin image, which the page itself isn't allowed to read, Inkflip downloads
  that image a second time from the same address. That request goes only to the server the
  page already loads the image from, with the page's origin as Referer, as the page's own
  request had.
- Verdicts are cached in the extension's own IndexedDB, keyed by image URL. Settings and
  right-click choices are kept in `chrome.storage`.

Full policy: [`PRIVACY.md`](PRIVACY.md).

| Permission | Why |
|---|---|
| Read and change data on all sites | To find images on any page, read their pixels and tag them |
| `storage` | Settings, per-site switches, right-click choices |
| `contextMenus` | The right-click corrections |
| `declarativeNetRequestWithHostAccess` | Some image hosts (Stack Overflow's, for one) refuse requests without a Referer, and Chrome sends none on extension requests. A rule limited to Inkflip's own requests sends the page's origin, as the page's own request did. |

## Limitations

- Only `<img>` elements are handled. CSS background images and inline SVG are Dark Reader's
  job. `<canvas>` charts and video aren't handled yet.
- **Colourful transparent diagrams with thin black text** (Spring Security's docs, Phoronix
  benchmark charts) are left alone: a filter that would rescue their text would also recolour
  colourful logos. Rescuing only the black ink needs a canvas repaint, planned for a later
  version. Right-click › Flip fixes them per image today.
- Images of 48 px or less (avatars, swatches, small icons) are never flipped or dimmed, only
  brightened when they are dark ink on transparent. There are too few pixels to judge them.
- Dark Reader's Filter and Filter+ modes invert the whole page. Inkflip notices and stands by,
  so use Dynamic mode.
- Images inside shadow DOM aren't handled.
- Cross-origin images are downloaded twice: once by the page, once by Inkflip. Chrome keeps the
  two in separate caches.

## Development

```sh
npm install                      # Playwright, used by the browser tests and asset scripts
npm test                         # unit tests, no browser needed
npm run test:real                # downloads the labelled images, runs the classifier in Chromium
npm run fetch:darkreader         # Dark Reader's MV3 build, for the e2e test
npm run test:e2e -- --live       # loads the extension headless; --live adds LeetCode, --shots refreshes docs/images
npm run assets                   # README hero from docs/images; store images into dist/store
npm run package                  # dist/inkflip-<version>.zip for the Chrome Web Store

npm run field                    # field test: research/field-pages.tsv, headless, dark OS scheme
npm run field:report             # → screenshots/field/report.html and contact-sheet.png
npm run harvest                  # download the field images for labelling (research/.cache/field)
npm run eval                     # score the classifier against research/field-labels.tsv
```

```
extension/            the extension itself (load this folder unpacked)
  classifier.js       pixel signals and verdicts, shared by every part
  content.js          finds, tags and styles images; no-flash hold; badges
  background.js       reads cross-origin images, verdict cache, right-click menu, shortcut
  popup/              the toolbar popup
docs/images/          README images (and the screenshots they are composed from)
research/             field-test pages, hand-labelled images, harvest and eval tools
test/                 unit, real-image and end-to-end tests
scripts/              icons, store assets, packaging
```

## Credits

The idea of judging "ink on paper" by palette and tone came from
[Kararead PR #84](https://github.com/L-K-M/Kararead/pull/84). Test and field images are
downloaded from their original sites at test time and are not stored in this repository.

Inkflip is not affiliated with Dark Reader.

## License

[MIT](LICENSE)
