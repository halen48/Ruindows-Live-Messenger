'use strict';

/**
 * XP-style drop-down menus, context menus, yellow tooltips and the
 * About dialog, shared by every window.
 *
 * buildMenus([{ label: 'File', items: [{ label, action, disabled },
 * { sep: true }, …] }]) replaces the .menubar contents.
 * Menus.popup(items, x, y) opens a context menu.
 */
const Menus = (() => {
  let openDropdown = null;
  let menubarActive = false;

  function closeDropdown() {
    openDropdown?.remove();
    openDropdown = null;
    document.querySelectorAll('.menubar span.open').forEach((s) => s.classList.remove('open'));
  }

  function buildDropdown(items, x, y) {
    closeDropdown();
    const menu = document.createElement('div');
    menu.className = 'xp-menu';
    for (const item of items) {
      if (item.sep) {
        menu.appendChild(Object.assign(document.createElement('div'), { className: 'xp-menu-sep' }));
        continue;
      }
      const row = document.createElement('div');
      row.className = 'xp-menu-item' + (item.disabled ? ' disabled' : '');
      row.textContent = item.label;
      if (!item.disabled && item.action) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          closeDropdown();
          menubarActive = false;
          item.action();
        });
      }
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 4) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 4) + 'px';
    openDropdown = menu;
    return menu;
  }

  function buildMenus(config) {
    const bar = document.querySelector('.menubar');
    if (!bar) return;
    bar.replaceChildren();
    for (const top of config) {
      const span = document.createElement('span');
      span.innerHTML = `<u>${top.label[0]}</u>${top.label.slice(1)}`;
      const open = () => {
        span.classList.add('open');
        const r = span.getBoundingClientRect();
        buildDropdown(top.items, r.left, r.bottom + 1);
      };
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menubarActive && span.classList.contains('open')) {
          menubarActive = false;
          closeDropdown();
        } else {
          menubarActive = true;
          open();
        }
      });
      span.addEventListener('mouseenter', () => {
        if (menubarActive) open();
      });
      bar.appendChild(span);
    }
  }

  document.addEventListener('click', () => {
    menubarActive = false;
    closeDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      menubarActive = false;
      closeDropdown();
    }
  });

  // ---- yellow XP tooltips ------------------------------------------------
  let tipEl = null;
  let tipTimer = null;

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[title], [data-tip]');
    if (!target) return;
    if (target.title) {
      target.dataset.tip = target.title;
      target.removeAttribute('title');
    }
    const text = target.dataset.tip;
    if (!text) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      tipEl?.remove();
      tipEl = document.createElement('div');
      tipEl.className = 'xp-tooltip';
      tipEl.textContent = text;
      document.body.appendChild(tipEl);
      const r = target.getBoundingClientRect();
      const tr = tipEl.getBoundingClientRect();
      tipEl.style.left = Math.min(r.left, window.innerWidth - tr.width - 4) + 'px';
      tipEl.style.top = Math.min(r.bottom + 4, window.innerHeight - tr.height - 4) + 'px';
    }, 450);
  });
  document.addEventListener('mouseout', () => {
    clearTimeout(tipTimer);
    tipEl?.remove();
    tipEl = null;
  });

  // ---- About dialog --------------------------------------------------------
  function showAbout() {
    const overlay = document.createElement('div');
    overlay.className = 'xp-dialog-overlay';
    overlay.innerHTML = `
      <div class="xp-dialog">
        <div class="xp-dialog-title">Sobre o Ruindows Live Messenger</div>
        <div class="xp-dialog-body">
          <img src="assets/wlm85/messenger-icon.png" width="30" height="26">
          <div>
            <b>Ruindows Live Messenger</b><br>
            Versão 2008 (Compilação 8.5, edição WhatsApp)<br>
            <span style="color:#808080">Homenagem de fã. Não é um produto da Microsoft nem da Meta.</span>
          </div>
        </div>
        <div class="xp-dialog-buttons"><button class="wlm-button">OK</button></div>
      </div>`;
    overlay.querySelector('button').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  return { buildMenus, popup: buildDropdown, showAbout };
})();
