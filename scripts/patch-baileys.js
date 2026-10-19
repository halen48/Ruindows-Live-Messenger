'use strict';

/**
 * Baileys drops a whole app-state collection when a patch removes an entry
 * the snapshot never had ("tried remove, but no previous op"). WhatsApp's
 * own clients just skip that mutation. For "regular_low" that meant pins and
 * archives never synced. Also surfaces favorite stickers, which Baileys
 * drops. Re-applied after every npm install (postinstall).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Utils', 'chat-utils.js');
const before = `                if (!prevOp) {
                    throw new Boom('tried remove, but no previous op', { data: { indexMac, valueMac } });
                }`;
const after = `                if (!prevOp) {
                    // whatsmsn patch: skip removals of unknown entries instead of failing the collection
                    return;
                }`;

// 2) favorite stickers are synced as "stickerAction" but Baileys ignores
//    them; hand them to the app as a 'sticker.action' event
const stickerBefore = `    else if (action?.pinAction) {`;
const stickerAfter = `    else if (action?.stickerAction) {
        // whatsmsn patch: favorite stickers
        ev.emit('sticker.action', { id, action: action.stickerAction, timestamp: toNumber(action.timestamp) });
    }
    else if (action?.pinAction) {`;

// 3) keep the raw stanza attributes/children on each message, to find where
//    WhatsApp puts group member tags (they aren't in the message protobuf)
const decodeFile = path.join(path.dirname(file), 'decode-wa-message.js');
const stanzaBefore = `    if (key.fromMe) {
        fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK;
    }`;
const stanzaAfter = `    // whatsmsn patch: raw stanza info
    fullMessage.stanzaInfo = {
        attrs: { ...stanza.attrs },
        children: (Array.isArray(stanza.content) ? stanza.content : []).map((c) => ({ tag: c?.tag, attrs: c?.attrs }))
    };
    if (key.fromMe) {
        fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK;
    }`;
{
  let dsrc = fs.readFileSync(decodeFile, 'utf8');
  if (dsrc.includes('whatsmsn patch: raw stanza info')) console.log('baileys already patched: stanza info');
  else if (dsrc.includes(stanzaBefore)) { fs.writeFileSync(decodeFile, dsrc.replace(stanzaBefore, stanzaAfter)); console.log('baileys patched: stanza info'); }
  else console.warn('baileys patch "stanza info": code changed upstream, not applied');
}

let src = fs.readFileSync(file, 'utf8');
const patches = [
  ['removals of unknown app-state entries', before, after, 'skip removals of unknown entries'],
  ['favorite stickers event', stickerBefore, stickerAfter, 'whatsmsn patch: favorite stickers'],
];
for (const [label, from, to, marker] of patches) {
  if (src.includes(marker)) console.log(`baileys already patched: ${label}`);
  else if (src.includes(from)) { src = src.replace(from, to); console.log(`baileys patched: ${label}`); }
  else console.warn(`baileys patch "${label}": code changed upstream, not applied`);
}
fs.writeFileSync(file, src);
