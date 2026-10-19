'use strict';

/**
 * My Messenger profile: display name (nick), personal message, display
 * picture and header image. Purely cosmetic and local: nothing here is
 * sent to WhatsApp. Saved by the main process in a file (survives the app
 * being killed) and pushed to every open window.
 */
const Profile = (() => {
  const KEY = 'wlmProfile';
  const listeners = [];

  function fromLocalStorage() {
    try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
  }

  let current = window.msn?.profileGet?.() || null;
  if (!current) {
    // first run with the file: carry over what older versions kept in localStorage
    current = fromLocalStorage() || {};
    if (Object.keys(current).length) window.msn?.profileSet?.(current);
  }

  function get() {
    return { ...current };
  }

  function set(patch) {
    const next = { ...current, ...patch };
    for (const k of Object.keys(next)) if (next[k] == null || next[k] === '') delete next[k];
    current = next;
    window.msn?.profileSet?.(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
    listeners.forEach((cb) => cb(get()));
    return get();
  }

  function onChange(cb) { listeners.push(cb); }

  // another window changed it
  window.msn?.onProfile?.((profile) => {
    current = profile || {};
    listeners.forEach((cb) => cb(get()));
  });

  /** Ask for an image file and return it as a JPEG data URL, cropped to w×h. */
  function pickImage(w, h) {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
      input.addEventListener('change', () => {
        const file = input.files[0];
        if (!file) return resolve(null);
        const img = new Image();
        img.onload = () => {
          const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
          const scale = Math.max(w / img.width, h / img.height);
          const dw = img.width * scale;
          const dh = img.height * scale;
          canvas.getContext('2d').drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
          URL.revokeObjectURL(img.src);
          resolve(canvas.toDataURL('image/jpeg', 0.9));
        };
        img.onerror = () => resolve(null);
        img.src = URL.createObjectURL(file);
      });
      input.click();
    });
  }

  return { get, set, onChange, pickImage };
})();
