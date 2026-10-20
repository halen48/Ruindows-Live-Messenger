'use strict';

/**
 * Voice clips: Chromium records Opus inside WebM, but WhatsApp and Telegram
 * voice notes are Opus inside Ogg. The audio itself is the same, so this only
 * repackages it (no re-encoding, no ffmpeg): pull the Opus packets out of the
 * WebM blocks and write them as Ogg pages.
 */

const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const BLOCK_GROUP = 0xa0;
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;
const CODEC_PRIVATE = 0x63a2;
const CHANNELS = 0x9f;
const AUDIO = 0xe1;
const MASTERS = new Set([SEGMENT, CLUSTER, TRACKS, TRACK_ENTRY, BLOCK_GROUP, AUDIO]);

/** EBML variable-size integer at `pos`: { value, length }. keepMarker for element ids. */
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8) throw new Error('webm inválido');
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** The Opus packets and the OpusHead of a WebM recording. */
function readWebm(buf) {
  const packets = [];
  let head = null;
  let channels = 1;
  const walk = (start, end) => {
    let pos = start;
    while (pos < end) {
      const id = vint(buf, pos, true);
      const size = vint(buf, pos + id.length);
      const body = pos + id.length + size.length;
      // MediaRecorder streams: Segment/Cluster sizes are "unknown" (to the end)
      const stop = size.unknown ? end : Math.min(end, body + size.value);
      if (MASTERS.has(id.value)) {
        walk(body, stop);
      } else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
        const track = vint(buf, body);
        // track number, 2 bytes timecode, 1 byte flags (no lacing from Chromium)
        packets.push(buf.subarray(body + track.length + 3, stop));
      } else if (id.value === CODEC_PRIVATE) {
        head = Buffer.from(buf.subarray(body, stop));
      } else if (id.value === CHANNELS) {
        channels = buf[body];
      }
      pos = stop;
    }
  };
  walk(0, buf.length);
  if (!head || head.toString('latin1', 0, 8) !== 'OpusHead') {
    head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'latin1');
    head[8] = 1;
    head[9] = channels;
    head.writeUInt16LE(312, 10); // usual encoder pre-skip
    head.writeUInt32LE(48000, 12);
  }
  return { head, packets };
}

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte. */
function packetSamples(p) {
  if (!p.length) return 0;
  const config = p[0] >> 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3]
    : config < 16 ? [480, 960][config & 1]
    : [120, 240, 480, 960][config & 3];
  const code = p[0] & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (p[1] || 0) & 0x3f;
  return frame * frames;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc(buf) {
  let c = 0;
  for (const b of buf) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

/** One Ogg page holding one packet. */
function page(packet, { granule, serial, seq, flags }) {
  const lacing = [];
  let left = packet.length;
  while (left >= 255) { lacing.push(255); left -= 255; }
  lacing.push(left);
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1');
  header[5] = flags;
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const out = Buffer.concat([header, packet]);
  out.writeUInt32LE(crc(out), 22);
  return out;
}

/** WebM/Opus recording -> { ogg, seconds } ready to send as a voice note. */
function webmToOgg(webm) {
  const { head, packets } = readWebm(Buffer.from(webm));
  if (!packets.length) throw new Error('gravação vazia');
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const tags = Buffer.alloc(8 + 4 + 8 + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(8, 8);
  tags.write('WhatsMSN', 12, 'latin1');
  tags.writeUInt32LE(0, 20);
  const pages = [page(head, { granule: 0, serial, seq: 0, flags: 2 }), page(tags, { granule: 0, serial, seq: 1, flags: 0 })];
  let granule = 0;
  packets.forEach((p, i) => {
    granule += packetSamples(p);
    pages.push(page(p, { granule, serial, seq: i + 2, flags: i === packets.length - 1 ? 4 : 0 }));
  });
  const preSkip = head.readUInt16LE(10);
  return { ogg: Buffer.concat(pages), seconds: Math.max(1, Math.round((granule - preSkip) / 48000)) };
}

module.exports = { webmToOgg, readWebm, packetSamples };
