'use strict';

/**
 * Light/dark theme. The 8.5 look is a few hundred hand-picked light colors,
 * so instead of a second palette the dark theme is derived: every color in
 * the page's styles (and in inline styles of dialogs built later) is turned
 * into its dark counterpart, the way "invert + hue-rotate(180deg)" would, but
 * applied to the colors themselves so photos, emoticons and artwork stay
 * untouched.
 */
(() => {
  const root = document.documentElement;
  let sheet = null; // the generated dark rules
  let observer = null;

  // CSS hue-rotate(180deg) matrix; with invert it keeps hue and flips lightness
  const H = [
    [-0.574, 1.43, 0.144],
    [0.426, 0.43, 0.144],
    [0.426, 1.43, -0.856],
  ];
  const clamp = (v) => Math.max(0, Math.min(1, v));
  function darkRgb(r, g, b) {
    const x = [1 - r / 255, 1 - g / 255, 1 - b / 255];
    // white becomes dark gray (#2b2d31-ish), not black: softer on the eyes
    return H.map((row) => Math.round(255 * (0.165 + 0.8 * clamp(row[0] * x[0] + row[1] * x[1] + row[2] * x[2]))));
  }

  const NAMED = { white: [255, 255, 255], black: [0, 0, 0], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192] };
  const COLOR_RE = /(#|%23)([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)|\b(white|black|gr[ae]y|silver)\b/gi;
  // a hover/selection that was "a bit darker than white" would end up a hair
  // off the dark background; spread it so it reads as a highlight
  const BASE = darkRgb(255, 255, 255);
  const boost = (rgb) => rgb.map((v, i) => Math.max(0, Math.min(255, Math.round(BASE[i] + (v - BASE[i]) * 2.6))));

  function darkValue(value, highlight = false) {
    return value.replace(COLOR_RE, (all, hash, hex, r, g, b, a, named) => {
      let rgb;
      let alpha = '';
      const conv = (c) => (highlight ? boost(darkRgb(...c)) : darkRgb(...c));
      if (hex) {
        const h = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
        if (h.length === 8 && parseInt(h.slice(6), 16) < 153) return all; // see below
        rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        const out = conv(rgb).map((v) => v.toString(16).padStart(2, '0')).join('') + (h.length === 8 ? h.slice(6) : '');
        return hash + out;
      }
      if (named) rgb = NAMED[named.toLowerCase()];
      else { rgb = [+r, +g, +b]; alpha = a; }
      if (!rgb) return all;
      // see-through white/black are glints and shadows over whatever is
      // below: they mean the same thing in the dark, so they stay
      if (alpha && parseFloat(alpha) / (alpha.endsWith('%') ? 100 : 1) < 0.6) return all;
      const [dr, dg, db] = conv(rgb);
      return alpha ? `rgba(${dr}, ${dg}, ${db}, ${alpha})` : `rgb(${dr}, ${dg}, ${db})`;
    });
  }

  /** Split a CSS list on top-level commas (not the ones inside gradients). */
  function layers(value) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of value) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // bitmap art (the blue header, the chat header) can't be recolored, so it
  // gets a dark tint layered over it; the other background lists of the rule
  // repeat their entry for the extra layer so sizes and positions still line up
  const TINT = 'linear-gradient(rgba(22, 26, 32, 0.62), rgba(22, 26, 32, 0.62))';
  const isArt = (l) => /^url\((?!["']?data:)/.test(l);
  const LAYER_PROPS = ['background-size', 'background-position-x', 'background-position-y', 'background-repeat', 'background-repeat-x', 'background-repeat-y', 'background-clip', 'background-origin', 'background-attachment'];
  const LAYER_DEFAULT = {
    'background-size': 'auto', 'background-position-x': '0%', 'background-position-y': '0%',
    'background-repeat': 'repeat', 'background-repeat-x': 'repeat', 'background-repeat-y': 'repeat',
    'background-clip': 'border-box', 'background-origin': 'padding-box', 'background-attachment': 'scroll',
  };
  // white text drawn over the (now tinted) header art stays white
  const OVER_ART = /\.identity|\.me-name|\.psm\b/;
  function darkBackground(style) {
    const image = style.getPropertyValue('background-image');
    if (!image || !layers(image).some(isArt)) return '';
    const imgs = layers(image);
    const outImgs = [];
    const map = []; // index of the original layer each new layer copies
    imgs.forEach((l, i) => {
      if (isArt(l)) { outImgs.push(TINT); map.push(i); outImgs.push(l); } else outImgs.push(darkValue(l));
      map.push(i);
    });
    let out = `background-image: ${outImgs.join(', ')};`;
    for (const prop of LAYER_PROPS) {
      const v = style.getPropertyValue(prop);
      if (!v) continue;
      // "initial" is fine for a whole property but not as a list entry
      const list = layers(v).map((x) => (x === 'initial' ? LAYER_DEFAULT[prop] : x));
      out += `${prop}: ${map.map((i) => list[i % list.length]).join(', ')};`;
    }
    return out;
  }

  const COLOR_PROP = /color|background|border|shadow|outline|fill|stroke|^--/;
  function darkDecls(style, highlight = false) {
    let out = darkBackground(style);
    for (const prop of style) {
      if (!COLOR_PROP.test(prop)) continue;
      const value = style.getPropertyValue(prop);
      if (/url\((?!["']?data:)/.test(value)) continue; // handled by darkBackground
      if (out && LAYER_PROPS.includes(prop)) continue;
      const dark = darkValue(value, highlight && /background/.test(prop));
      if (dark !== value) out += `${prop}: ${dark}${style.getPropertyPriority(prop) ? ' !important' : ''};`;
    }
    return out;
  }

  function darkRules(rules, out) {
    for (const rule of rules) {
      if (rule.selectorText && rule.style) {
        const highlight = /:hover|\.selected|:active/.test(rule.selectorText);
        const decls = OVER_ART.test(rule.selectorText) ? darkBackground(rule.style) : darkDecls(rule.style, highlight);
        if (!decls) continue;
        // :root / html rules keep their target; everything else gets the theme prefix
        const sel = rule.selectorText.split(',').map((s) => {
          s = s.trim();
          if (/^(:root|html)\b/.test(s)) return s.replace(/^(:root|html)/, "html[data-theme='dark']");
          return `html[data-theme='dark'] ${s}`;
        }).join(', ');
        out.push(`${sel} { ${decls} }`);
      } else if (rule.cssRules) {
        darkRules(rule.cssRules, out);
      }
    }
  }

  function buildSheet() {
    const out = [];
    for (const s of document.styleSheets) {
      if (s.ownerNode === sheet) continue;
      try { darkRules(s.cssRules, out); } catch { /* cross-origin sheet */ }
    }
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'dark-theme';
      document.head.appendChild(sheet);
    }
    sheet.textContent = out.join('\n');
  }

  // inline styles (dialogs, menus, things set from JS) are flipped in place
  function darkInline(el) {
    if (!el.getAttribute || el.dataset.lightStyle !== undefined) return;
    // real colors that mean something (the picture editor's palette, text on a photo)
    if (el.closest?.('[data-true-color]')) return;
    const style = el.getAttribute('style');
    if (!style || !/(#|rgb|white|black|gr[ae]y|silver|url\()/i.test(style)) return;
    const decls = darkDecls(el.style);
    if (!decls) return;
    el.dataset.lightStyle = style;
    el.dataset.darkStyle = style + ';' + decls;
    el.setAttribute('style', el.dataset.darkStyle);
  }
  function lightInline(el) {
    if (el.dataset?.lightStyle === undefined) return;
    el.setAttribute('style', el.dataset.lightStyle);
    delete el.dataset.lightStyle;
    delete el.dataset.darkStyle;
  }
  const allStyled = () => document.querySelectorAll('[style]');

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') {
          const t = m.target;
          if (t.dataset.lightStyle !== undefined) {
            if (t.getAttribute('style') === t.dataset.darkStyle) continue; // our own write
            // the page changed this style itself: take it as the new light version
            delete t.dataset.lightStyle;
            delete t.dataset.darkStyle;
          }
          darkInline(t);
        }
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          darkInline(n);
          n.querySelectorAll?.('[style]').forEach(darkInline);
          if (n.tagName === 'STYLE' && n !== sheet) buildSheet();
        }
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  }

  let current = 'light';
  function apply(theme) {
    current = theme === 'dark' ? 'dark' : 'light';
    root.dataset.theme = current;
    if (document.readyState === 'loading') return; // finished on DOMContentLoaded
    if (current === 'dark') {
      buildSheet();
      allStyled().forEach(darkInline);
      startObserver();
    } else {
      observer?.disconnect();
      observer = null;
      allStyled().forEach(lightInline);
      if (sheet) sheet.textContent = '';
    }
  }

  try { apply(window.msn.themeGet()); } catch {}
  document.addEventListener('DOMContentLoaded', () => apply(current));
  window.msn.onTheme?.(apply);
})();
