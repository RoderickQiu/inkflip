/* Inkflip popup: settings for everywhere and this site, plus a live tally of the page. */
'use strict';

const DEFAULTS = globalThis.INKFLIP_DEFAULTS;
const $ = (id) => document.getElementById(id);
const isMac = /Mac/i.test(navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform);

let settings = { ...DEFAULTS };
let tab = null;
let host = null;

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^(https?|file):$/.test(u.protocol) ? u.hostname : null; // '' for local files
  } catch (e) {
    return null;
  }
}

function save() {
  return chrome.storage.sync.set({ settings });
}

// -------------------------------------------------------------------- controls

function renderControls() {
  const siteOn = !settings.disabledHosts.includes(host);
  $('enabled').checked = settings.enabled;
  $('site').checked = siteOn;
  $('site').disabled = host === null || !settings.enabled;
  for (const k of ['flip', 'logo', 'dim', 'hold', 'badges']) $(k).checked = settings[k];
  $('dimLevel').value = settings.dimLevel;
  renderDim();
  for (const b of document.querySelectorAll('[data-peek]')) {
    b.setAttribute('aria-checked', String(b.dataset.peek === settings.peek));
  }
  document.body.classList.toggle('off', !settings.enabled || !siteOn);
}

function renderDim() {
  const v = Number($('dimLevel').value);
  $('dimLevelOut').textContent = Math.round(v * 100) + '%';
  $('dimLevel').style.setProperty('--fill', ((v - 0.5) / 0.45) * 100 + '%');
  $('dim-strength').classList.toggle('off', !settings.dim);
}

function bind() {
  $('enabled').addEventListener('change', (e) => { settings.enabled = e.target.checked; save(); renderControls(); soon(); });
  $('site').addEventListener('change', (e) => {
    settings.disabledHosts = e.target.checked
      ? settings.disabledHosts.filter((h) => h !== host)
      : [...settings.disabledHosts, host];
    save();
    renderControls();
    soon();
  });
  for (const k of ['flip', 'logo', 'dim', 'hold', 'badges']) {
    $(k).addEventListener('change', (e) => { settings[k] = e.target.checked; save(); renderControls(); soon(); });
  }
  $('dimLevel').addEventListener('input', (e) => { settings.dimLevel = Number(e.target.value); renderDim(); });
  $('dimLevel').addEventListener('change', () => save());
  for (const b of document.querySelectorAll('[data-peek]')) {
    b.addEventListener('click', () => { settings.peek = b.dataset.peek; save(); renderControls(); });
  }
}

// ---------------------------------------------------------------------- status

function setStatus(text, kind) {
  const el = $('status');
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.querySelector('span').textContent = text;
}

function setTally(counts) {
  for (const k of ['flip', 'logo', 'dim', 'none']) $('n-' + k).textContent = counts ? counts[k] : '–';
  $('tally').classList.toggle('idle', !counts);
}

async function refresh() {
  if (!tab || host === null) {
    setStatus("Inkflip can't run on this page", 'warn');
    setTally(null);
    return;
  }
  let s = null;
  try {
    s = await chrome.tabs.sendMessage(tab.id, { type: 'stats' }, { frameId: 0 });
  } catch (e) {
    s = null;
  }
  if (!s) {
    setStatus('Reload the page to start Inkflip here', 'warn');
    setTally(null);
    return;
  }
  setTally(s.counts);
  const dr = s.darkReader ? ' · Dark Reader on' : '';
  if (!settings.enabled) setStatus('Off everywhere');
  else if (settings.disabledHosts.includes(host)) setStatus('Off for this site');
  else if (s.filterMode) setStatus('Page is fully inverted — use Dark Reader’s Dynamic mode', 'warn');
  else if (!s.pageDark) setStatus('Standing by — this page is light' + dr);
  else if (s.counts.pending) setStatus('Reading images…' + dr, 'working');
  else setStatus('Working — page is dark' + dr, 'working');
}

let soonTimer = 0;
function soon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(refresh, 250);
}

// ------------------------------------------------------------------------ init

async function init() {
  const forced = Number(new URLSearchParams(location.search).get('tab')); // used by the e2e test
  tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  host = tab ? hostOf(tab.url) : null;
  $('host').textContent = host === null ? 'This page' : host || 'Local file';
  $('alt-key').textContent = isMac ? '⌥ Option' : 'Alt';

  const stored = (await chrome.storage.sync.get('settings')).settings || {};
  settings = { ...DEFAULTS, ...stored };
  renderControls();
  bind();

  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-site');
  $('shortcut').textContent = cmd && cmd.shortcut ? cmd.shortcut + ' toggles this site' : '';

  refresh();
  setInterval(refresh, 1000);
}

init();
