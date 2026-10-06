# Privacy policy

*Last updated: 6 October 2026*

Inkflip is a browser extension that adjusts how images look on dark web pages. It does not
collect, sell or share personal data.

## What it processes

- **Images on the pages you visit.** Inkflip reads the pixels of images on the page to decide
  how to display them. This happens on your device.
- **Cross-origin images.** When a page shows an image from another site, Inkflip cannot read
  its pixels directly, so it downloads the same image again from the same address. That request
  goes only to the server the page already loads the image from, and carries the page's
  origin as its Referer, exactly as the page's own request did (some image hosts refuse
  requests without one). Inkflip contacts no other server.

## What it stores, on your device only

- **A verdict cache:** image URL, the treatment chosen and seven numeric measurements, kept in
  the extension's IndexedDB and capped at 20,000 entries. This lets images display correctly
  the moment they appear on a revisit.
- **Settings:** your switches, per-site choices and right-click corrections, kept in
  `chrome.storage`. If you use Chrome Sync, Chrome syncs the settings between your browsers.
  Right-click corrections and the cache stay local.
- **Whether a site was dark** on your last visit, so images can be hidden until checked from the
  first moment.

## What it never does

- Send any data to the developer or a third party
- Use analytics, tracking or advertising
- Read page text, form fields, passwords or browsing history

## Removing data

Uninstalling the extension deletes everything it stored.

## Contact

Open an issue in this repository.
