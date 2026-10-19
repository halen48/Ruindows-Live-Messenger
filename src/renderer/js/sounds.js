'use strict';

/**
 * Era-appropriate sound effects, synthesised with WebAudio so the app
 * ships no audio files. Tuned to *evoke* the classics: the new-message
 * "ding", the contact sign-in chime and the nudge buzzer.
 */
const Sounds = (() => {
  let ctx;
  // "Ocupado" silences everything; the status itself lives in the main process
  let muted = false;
  // read synchronously: a chat window opened by an incoming message plays
  // its sound right away, before an async answer would arrive
  try { muted = window.msn.statusSync() === 'busy'; } catch {}
  window.msn?.onStatus?.((s) => { muted = s === 'busy'; });
  const ac = () => (ctx ||= new AudioContext());

  function tone(freq, start, dur, { type = 'sine', gain = 0.18 } = {}) {
    if (muted) return;
    const a = ac();
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, a.currentTime + start);
    g.gain.linearRampToValueAtTime(gain, a.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + start + dur);
    osc.connect(g).connect(a.destination);
    osc.start(a.currentTime + start);
    osc.stop(a.currentTime + start + dur + 0.05);
  }

  // WLM 8.5 sounds from msn-js; type.mp3 is 8.5's new-message alert
  const WLM85 = { message: 'type', online: 'online', signin: 'online', nudge: 'nudge' };

  /** Play an imported original wav, else the bundled 8.5 mp3, else synthesise. */
  function original(name) {
    if (muted) return true;
    const audio =
      (typeof Originals !== 'undefined' && Originals.sound(name)) ||
      (WLM85[name] && new Audio(`assets/wlm85/sounds/${WLM85[name]}.mp3`));
    if (!audio) return false;
    audio.play().catch(() => {});
    return true;
  }

  return {
    /** Incoming message: the two-note glassy "da-ding". */
    message() {
      if (original('message')) return;
      tone(880, 0, 0.28, { type: 'triangle', gain: 0.22 });
      tone(1318.5, 0.09, 0.42, { type: 'triangle', gain: 0.18 });
    },
    /** Contact signs in: rising three-note chime. */
    online() {
      if (original('online')) return;
      tone(523.25, 0, 0.18, { type: 'triangle' });
      tone(659.25, 0.13, 0.18, { type: 'triangle' });
      tone(783.99, 0.26, 0.34, { type: 'triangle' });
    },
    /** Sign-in complete: the little welcome flourish. */
    signin() {
      if (original('signin')) return;
      tone(392, 0, 0.16, { type: 'triangle' });
      tone(523.25, 0.12, 0.16, { type: 'triangle' });
      tone(659.25, 0.24, 0.16, { type: 'triangle' });
      tone(1046.5, 0.36, 0.5, { type: 'triangle', gain: 0.22 });
    },
    /** Nudge: the rattling buzzer. */
    nudge() {
      if (original('nudge') || muted) return;
      const a = ac();
      const osc = a.createOscillator();
      const g = a.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(70, a.currentTime);
      const lfo = a.createOscillator();
      const lfoGain = a.createGain();
      lfo.frequency.value = 28;
      lfoGain.gain.value = 30;
      lfo.connect(lfoGain).connect(osc.frequency);
      g.gain.setValueAtTime(0.25, a.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.65);
      osc.connect(g).connect(a.destination);
      lfo.start();
      osc.start();
      osc.stop(a.currentTime + 0.7);
      lfo.stop(a.currentTime + 0.7);
    },
  };
})();
