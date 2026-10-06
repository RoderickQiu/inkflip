/* Default settings, shared by the content script, the service worker and the popup. */
globalThis.INKFLIP_DEFAULTS = Object.freeze({
  enabled: true, // master switch
  flip: true, // flip black-on-white diagrams and charts
  logo: true, // brighten dark logos on transparent backgrounds
  dim: true, // dim photos on white
  dimLevel: 0.8, // brightness of dimmed photos
  hold: true, // on dark pages, keep new images hidden until checked: no white flash
  peek: 'alt', // 'alt' | 'hover' | 'off'
  badges: false, // label each image with its verdict
  disabledHosts: [],
});
