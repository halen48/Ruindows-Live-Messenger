'use strict';

/**
 * Original-asset overrides. If the user has imported artwork/sounds from
 * their own copy of MSN Messenger into assets/original/ (see
 * scripts/import-original-assets.js), swap them in over the bundled
 * lookalike SVGs and synthesised sounds. With an empty folder this is a
 * no-op and the app uses its own art.
 */
const Originals = (() => {
  const IMAGE_EXTS = ['png', 'bmp', 'gif', 'jpg', 'ico'];
  let files = new Set();
  const ready = window.msn
    .originalAssets()
    .then((list) => { files = new Set(list); })
    .catch(() => {});

  function imageFor(name) {
    for (const ext of IMAGE_EXTS) {
      if (files.has(`${name}.${ext}`)) return `assets/original/${name}.${ext}`;
    }
    return null;
  }

  async function swapImages(root = document) {
    await ready;
    if (!files.size) return;
    for (const img of root.querySelectorAll('img[src^="assets/"]')) {
      const name = img.getAttribute('src').split('/').pop().replace(/\.\w+$/, '');
      const override = imageFor(name);
      if (override) img.src = override;
    }
  }

  /** Returns a playable Audio for an original wav, or null to synthesise. */
  function sound(name) {
    if (!files.has(`${name}.wav`)) return null;
    return new Audio(`assets/original/${name}.wav`);
  }

  /** Original emoticon bitmap path (emoticon-<key>.*), or null. */
  function emoticonSrc(key) {
    return imageFor(`emoticon-${key}`);
  }

  document.addEventListener('DOMContentLoaded', () => swapImages());

  return { swapImages, sound, emoticonSrc, ready };
})();
