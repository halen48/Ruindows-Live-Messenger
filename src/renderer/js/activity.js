'use strict';

/**
 * Contact status from activity. Most people hide their WhatsApp "online",
 * so a contact counts as Online for a while after their last message to
 * me, then Ausente, then Offline. Real WhatsApp presence still wins when
 * it does arrive. Someone active is shown Ocupado when they leave my last
 * private message unanswered for a while, or when their WhatsApp about says
 * they're busy. Minutes are configurable from the buddy list menu.
 */
const Activity = (() => {
  const KEY = 'wlmActivity';
  const DEFAULTS = { onlineMin: 60, awayMin: 180, busyMin: 15 };
  // about texts that mean "don't disturb"
  const BUSY_ABOUT = /\b(ocupad[oa]|trabalhando|em reuni[aã]o|reuni[aã]o|n[aã]o perturbe|nao perturbe|s[oó] urg[eê]ncias?|apenas urg[eê]ncias?|busy|at work|in a meeting|do not disturb|dnd)\b/i;

  function settings() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { ...DEFAULTS }; }
  }

  function save(next) {
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  }

  /**
   * 'online' | 'busy' | 'away' | 'offline' for { presence, lastIncoming,
   * about, lastOutgoing, directIncoming } (timestamps in seconds).
   */
  function statusOf(info) {
    const base = activityStatus(info);
    if (base === 'offline') return base;
    return isBusy(info) ? 'busy' : base;
  }

  function activityStatus({ presence, lastIncoming }) {
    if (presence === 'available' || presence === 'composing' || presence === 'paused' || presence === 'recording') return 'online';
    if (!lastIncoming) return 'offline';
    const { onlineMin, awayMin } = settings();
    const minutes = (Date.now() / 1000 - lastIncoming) / 60;
    if (minutes < onlineMin) return 'online';
    if (minutes < awayMin) return 'away';
    return 'offline';
  }

  function isBusy({ about, lastOutgoing, directIncoming, presence }) {
    if (presence === 'composing' || presence === 'recording') return false; // answering right now
    if (about && BUSY_ABOUT.test(about)) return true;
    // around (talking elsewhere) but my last message to them is still unanswered
    if (!lastOutgoing || (directIncoming && directIncoming >= lastOutgoing)) return false;
    return (Date.now() / 1000 - lastOutgoing) / 60 >= settings().busyMin;
  }

  /** Small dialog to change the two thresholds. */
  function showOptions(onSaved) {
    const s = settings();
    const overlay = document.createElement('div');
    overlay.className = 'xp-dialog-overlay';
    overlay.innerHTML = `
      <form class="xp-dialog">
        <div class="xp-dialog-title">Opções de status dos contatos</div>
        <div class="xp-dialog-body" style="flex-direction:column;gap:8px">
          <label>Online até <input type="number" name="on" min="1" value="${s.onlineMin}" style="width:56px"> minutos depois da última mensagem</label>
          <label>Ausente até <input type="number" name="away" min="1" value="${s.awayMin}" style="width:56px"> minutos; depois, Offline</label>
          <label>Ocupado se não responder a minha mensagem em <input type="number" name="busy" min="1" value="${s.busyMin}" style="width:56px"> minutos</label>
          <span style="color:#6d6d6d">Também fica Ocupado quem tem recado tipo "ocupado", "trabalhando", "em reunião".</span>
        </div>
        <div class="xp-dialog-buttons">
          <button class="wlm-button" type="submit">OK</button>
          <button class="wlm-button" type="button" data-cancel>Cancelar</button>
        </div>
      </form>`;
    const form = overlay.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const onlineMin = Math.max(1, Number(form.on.value) || DEFAULTS.onlineMin);
      const awayMin = Math.max(onlineMin, Number(form.away.value) || DEFAULTS.awayMin);
      const busyMin = Math.max(1, Number(form.busy.value) || DEFAULTS.busyMin);
      save({ onlineMin, awayMin, busyMin });
      overlay.remove();
      onSaved?.();
    });
    overlay.querySelector('[data-cancel]').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }

  return { statusOf, settings, showOptions };
})();
