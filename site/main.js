// Before/after dividers, the one-time flip on the hero, and the copy button.
'use strict';

for (const fig of document.querySelectorAll('.compare')) {
  const range = fig.querySelector('.compare-range');
  const set = (v) => fig.style.setProperty('--pos', v + '%');
  range.addEventListener('input', () => set(range.value));
  set(range.value);
}

// Hero: start on the white diagram, then sweep the divider across once, so the first thing
// a visitor sees is the flip. Any touch of the divider stops the sweep.
const hero = document.querySelector('.compare[data-animate]');
if (hero) {
  const range = hero.querySelector('.compare-range');
  const set = (v) => { range.value = v; hero.style.setProperty('--pos', v + '%'); };
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still) {
    set(40);
  } else {
    let stopped = false;
    const stop = () => { stopped = true; };
    range.addEventListener('pointerdown', stop);
    range.addEventListener('keydown', stop);
    const from = 100, to = 38, ms = 1500;
    setTimeout(() => {
      const t0 = performance.now();
      const step = (now) => {
        if (stopped) return;
        const k = Math.min(1, (now - t0) / ms);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        set((from + (to - from) * e).toFixed(2));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, 700);
  }
}

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
    } catch (e) {
      btn.textContent = 'Select and copy';
    }
  });
}
