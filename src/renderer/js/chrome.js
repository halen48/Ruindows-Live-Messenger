'use strict';

/** Wires up the custom titlebar (Luna or WLM 8.5) on every window. */
document.addEventListener('DOMContentLoaded', () => {
  const controls = '.xp-controls, .wlm-caption';
  document.querySelector(`:is(${controls}) .minimize`)?.addEventListener('click', () => window.msn.minimize());
  const maximize = document.querySelector(`:is(${controls}) .maximize`);
  maximize?.addEventListener('click', () => window.msn.maximize());
  document.querySelector(`:is(${controls}) .close`)?.addEventListener('click', () => window.msn.close());
  // windows without a maximize button (sign-in) shouldn't maximize on double-click either
  if (!maximize) return;
  document.querySelector('.xp-titlebar, .wlm-titlebar')?.addEventListener('dblclick', (e) => {
    if (!e.target.closest(controls)) window.msn.maximize();
  });
});
