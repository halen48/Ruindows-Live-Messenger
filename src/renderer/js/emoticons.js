'use strict';

/**
 * The 76 original Ruindows Live Messenger emoticons (assets/wlm85/emoticons,
 * from bernzrdo/msn-emoticons). Typed shortcodes go out to WhatsApp as the
 * matching emoji, and incoming emoji/shortcodes render as the MSN bitmaps.
 */
const EMOTICONS = [
  // [shortcode, file, emoji ('' = no emoji, the code is sent as text), name]
  [":)", "smile.png", "🙂", "Smile"],
  [":D", "open-mouthed-smile.png", "😀", "Open-mouthed smile"],
  [";)", "winking-smile.gif", "😉", "Winking smile"],
  [":-O", "surprised-smile.png", "😲", "Surprised smile"],
  [":P", "smile-with-tongue-out.png", "😛", "Smile with tongue out"],
  ["(H)", "hot-smile.png", "😎", "Hot smile"],
  [":@", "angry-smile.png", "😡", "Angry smile"],
  [":$", "embarrassed-smile.png", "😳", "Embarrassed smile"],
  [":S", "confused-smile.png", "😕", "Confused smile"],
  [":(", "sad-smile.png", "☹️", "Sad smile"],
  [":'(", "crying-face.gif", "😢", "Crying face"],
  [":|", "disappointed-smile.png", "😐", "Disappointed smile"],
  ["(6)", "devil.png", "😈", "Devil"],
  ["(A)", "angel.png", "😇", "Angel"],
  ["(L)", "red-heart.png", "❤️", "Red heart"],
  ["(U)", "broken-heart.png", "💔", "Broken heart"],
  ["(M)", "messenger.png", "👥", "Messenger"],
  ["(@)", "cat-face.png", "😺", "Cat face"],
  ["(&)", "dog-face.png", "🐶", "Dog face"],
  ["(S)", "sleeping-half-moon.png", "🌜", "Sleeping half-moon"],
  ["(*)", "star.png", "⭐", "Star"],
  ["(~)", "filmstrip.png", "🎞️", "Filmstrip"],
  ["(8)", "note.png", "🎵", "Note"],
  ["(E)", "e-mail.png", "✉️", "E-mail"],
  ["(F)", "red-rose.png", "🌹", "Red rose"],
  ["(W)", "wilted-rose.png", "🥀", "Wilted rose"],
  ["(O)", "clock.png", "🕑", "Clock"],
  ["(K)", "red-lips.png", "👄", "Red lips"],
  ["(G)", "gift-with-a-bow.png", "🎁", "Gift with a bow"],
  ["(^)", "birthday-cake.gif", "🎂", "Birthday cake"],
  ["(P)", "camera.png", "📷", "Camera"],
  ["(I)", "light-bulb.png", "💡", "Light bulb"],
  ["(C)", "coffee-cup.png", "☕", "Coffee cup"],
  ["(T)", "telephone-receiver.png", "📞", "Telephone receiver"],
  ["({)", "left-hug.png", "🫂", "Left hug"],
  ["(})", "right-hug.png", "🫂", "Right hug"],
  ["(B)", "beer-mug.png", "🍺", "Beer mug"],
  ["(D)", "martini-glass.png", "🍸", "Martini glass"],
  ["(Z)", "boy.png", "👦", "Boy"],
  ["(X)", "girl.png", "👧", "Girl"],
  ["(Y)", "thumbs-up.png", "👍", "Thumbs up"],
  ["(N)", "thumbs-down.png", "👎", "Thumbs down"],
  [":[", "vampire-bat.gif", "🦇", "Vampire bat"],
  ["(nnh)", "goat.png", "🐐", "Goat"],
  ["(#)", "sun.png", "☀️", "Sun"],
  ["(R)", "rainbow.png", "🌈", "Rainbow"],
  [":-#", "dont-tell-anyone-smile.png", "🤐", "Don't tell anyone smile"],
  ["8o|", "baring-teeth-smile.png", "😬", "Baring teeth smile"],
  ["8-|", "nerd-smile.png", "🤓", "Nerd smile"],
  ["^o)", "sarcastic-smile.png", "🤨", "Sarcastic smile"],
  [":-*", "secret-telling-smile.png", "", "Secret telling smile"],
  ["+o(", "sick-smile.png", "🤢", "Sick smile"],
  ["(sn)", "snail.png", "🐌", "Snail"],
  ["(tu)", "turtle.png", "🐢", "Turtle"],
  ["(pl)", "plate.png", "🍽️", "Plate"],
  ["(||)", "bowl.png", "🥣", "Bowl"],
  ["(pi)", "pizza.png", "🍕", "Pizza"],
  ["(so)", "soccer-ball.png", "⚽", "Soccer ball"],
  ["(au)", "auto.png", "🚗", "Auto"],
  ["(ap)", "airplane.png", "✈️", "Airplane"],
  ["(um)", "umbrella.png", "☂️", "Umbrella"],
  ["(ip)", "island-with-a-palm-tree.png", "🏝️", "Island with a palm tree"],
  ["(co)", "computer.png", "🖥️", "Computer"],
  ["(mp)", "mobile-phone.png", "📱", "Mobile phone"],
  ["(brb)", "be-right-back.png", "", "Be right back"],
  ["(st)", "storm-cloud.png", "🌧️", "Storm cloud"],
  ["(h5)", "high-five.png", "🙏", "High five!"],
  ["(mo)", "money.png", "🪙", "Money"],
  ["(bah)", "black-sheep.png", "🐑", "Black sheep"],
  [":^)", "i-dont-know-smile.gif", "😕", "I don't know smile"],
  ["*-)", "thinking-smile.gif", "🤔", "Thinking smile"],
  ["(li)", "lightning.gif", "🌩️", "Lightning"],
  ["<:o)", "party-smile.gif", "🥳", "Party smile"],
  ["8-)", "eye-rolling-smile.gif", "🙄", "Eye-rolling smile"],
  ["|-)", "sleepy-smile.gif", "🥱", "Sleepy smile"],
  ["('.')", "bunny.png", "🐰", "Bunny"],
];

const EMO_DIR = 'assets/wlm85/emoticons/';

// extra spellings MSN accepted: :-) for :), lowercase letters in (Y), etc.
const EMOTICON_ALIASES = {
  ':-)': ':)', ':-D': ':D', ':d': ':D', ':-d': ':D', ';-)': ';)', ':o': ':-O', ':O': ':-O', ':-o': ':-O',
  ':-P': ':P', ':p': ':P', ':-p': ':P', ':-(': ':(', ':-S': ':S', ':s': ':S', ':-s': ':S', ':-|': ':|',
  ':-@': ':@', ':-$': ':$', '<3': '(L)', '</3': '(U)',
};

const EMO_BY_CODE = new Map();
for (const e of EMOTICONS) {
  EMO_BY_CODE.set(e[0], e);
  if (/^\([A-Z]\)$/.test(e[0])) EMO_BY_CODE.set(e[0].toLowerCase(), e);
}
for (const [alias, code] of Object.entries(EMOTICON_ALIASES)) EMO_BY_CODE.set(alias, EMO_BY_CODE.get(code));

const EMO_BY_EMOJI = new Map();
for (const e of EMOTICONS) {
  if (!e[2]) continue;
  // WhatsApp often drops the U+FE0F variation selector (❤ vs ❤️), match both
  for (const variant of [e[2], e[2].replace(/\uFE0F/g, '')]) {
    if (!EMO_BY_EMOJI.has(variant)) EMO_BY_EMOJI.set(variant, e);
  }
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// longest first so "(sn)" wins over "(S)" and ":-O" over ":-"
const EMO_TOKEN_RE = new RegExp(
  [...new Set([...EMO_BY_CODE.keys(), ...EMO_BY_EMOJI.keys()])]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|'),
  'g'
);

function escapeHtmlText(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function emoticonImg(e) {
  return `<img class="emo" src="${EMO_DIR}${e[1]}" title="${escapeHtmlText(e[3])}" alt="">`;
}

/** Outgoing wire format: shortcodes become emoji so WhatsApp users see something sensible. */
function emoticonize(text) {
  return text.replace(EMO_TOKEN_RE, (tok) => {
    const e = EMO_BY_CODE.get(tok);
    return e && e[2] ? e[2] : tok;
  });
}

/**
 * Escape text, swap shortcodes and emoji for the MSN bitmaps, then apply
 * WhatsApp markdown (*b* _i_ ~s~). Returns HTML.
 */
// plain emoji get a class so the dark theme can keep their real colors
const EMOJI_RE = /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)+/gu;
function emojiText(s) {
  let html = '';
  let last = 0;
  for (const m of String(s).matchAll(EMOJI_RE)) {
    html += escapeHtmlText(s.slice(last, m.index)) + `<span class="emj">${m[0]}</span>`;
    last = m.index + m[0].length;
  }
  return html + escapeHtmlText(String(s).slice(last));
}

// links: http(s)://..., www...., or a bare domain with a real ending
// ("uol.com.br", "github.com/x"). The list keeps "arquivo.txt" / "node.js" /
// "v1.2" as text; the lookbehind keeps e-mails ("a@gmail.com") as text.
const TLDS = 'com|net|org|br|io|dev|app|gov|edu|mil|info|biz|me|tv|co|ai|gg|xyz|ly|us|uk|pt|de|fr|es|it|nl|be|ch|eu|jp|kr|cn|ru|ca|au|mx|ar|cl|uy|py|pe|link|site|online|store|shop|tech|blog|news|live|so|to|fm|art|wiki|cloud|page|social|games?|chat';
const URL_RE = new RegExp(
  '\\b(?:https?:\\/\\/|www\\.)[^\\s<>"]+' +
  `|(?<![@\\w.\\/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![\\w-])(?::\\d+)?(?:[\\/?#][^\\s<>"]*)?`,
  'gi'
);
// "veja x.com." / "(x.com)": trailing punctuation isn't part of the link, but
// a ")" closing a "(" inside it is (Wikipedia's "..._(software)")
function trimUrl(url) {
  let tail = '';
  for (;;) {
    const c = url[url.length - 1];
    const unbalanced = c === ')' && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length;
    if (!/[.,;:!?'"*_~\]}]/.test(c) && !unbalanced) break;
    tail = c + tail;
    url = url.slice(0, -1);
  }
  return [url, tail];
}
const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function messageHtml(text) {
  // pull the links out first so emoticons (":/" in "https://") and *bold*/_italic_
  // don't mangle them, then put them back as clickable anchors
  const links = [];
  text = String(text).replace(URL_RE, (raw) => {
    const [url, tail] = trimUrl(raw);
    return `\u0000${links.push(url) - 1}\u0000${tail}`;
  });
  return formatHtml(text).replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const url = links[i];
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return `<a class="link" href="${escAttr(href)}" title="${escAttr(href)}">${escAttr(url)}</a>`;
  });
}

function formatHtml(text) {
  let html = '';
  let last = 0;
  for (const m of String(text).matchAll(EMO_TOKEN_RE)) {
    const e = EMO_BY_CODE.get(m[0]) || EMO_BY_EMOJI.get(m[0]);
    html += emojiText(text.slice(last, m.index)) + (e ? emoticonImg(e) : emojiText(m[0]));
    last = m.index + m[0].length;
  }
  html += emojiText(String(text).slice(last));
  return html
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1<i>$2</i>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>');
}

/** The palette shown by the smiley toolbar button: [code, file, name]. */
const EMOTICON_PALETTE = EMOTICONS.map((e) => [e[0], EMO_DIR + e[1], e[3]]);
