#!/usr/bin/env node
'use strict';

/**
 * Import artwork and sounds from YOUR OWN copy of MSN Messenger into
 * src/renderer/assets/original/ (gitignored — the files stay on your
 * machine and are never committed). When files exist there, the app
 * prefers them over the bundled lookalike SVGs and synthesised sounds.
 *
 * Usage:
 *   node scripts/import-original-assets.js <path>
 *
 * where <path> is one of:
 *   - the MSN Messenger installer exe (e.g. "MSN Messenger 6.0.0602.exe")
 *   - an installed folder (e.g. "C:\Program Files\MSN Messenger")
 *   - any folder of files you extracted yourself (wav/bmp/png/gif/ico)
 *
 * Extracting from an exe requires 7-Zip on your PATH (`7z`), or
 * `cabextract`. 7-Zip also unpacks the icon resources inside the main
 * executable. Windows: install 7-Zip; macOS: `brew install p7zip`;
 * Debian/Ubuntu: `apt install p7zip-full`.
 *
 * After importing, check the report: files whose purpose the script
 * recognises are given the app's expected names automatically; the rest
 * are copied as-is for you to rename by hand.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const DEST = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'original');

// Names the app looks for (see src/renderer/js/originals.js):
//   images: butterfly, buddy-online, buddy-away,
//           buddy-offline, buddy-large, icon-invite, icon-files,
//           icon-video, icon-voice, icon-activities, icon-games,
//           icon-nudge, icon-info, icon-pen   (.png/.bmp/.gif/.jpg/.ico)
//   emoticons (19x19, live inside msgsres.dll's bitmap resources —
//     7-Zip extracts them; rename to): emoticon-smile, emoticon-laugh,
//     emoticon-wink, emoticon-tongue, emoticon-sad, emoticon-cry,
//     emoticon-surprised, emoticon-angry, emoticon-confused,
//     emoticon-embarrassed, emoticon-cool, emoticon-neutral,
//     emoticon-yes, emoticon-no, emoticon-heart, emoticon-brokenheart,
//     emoticon-kiss, emoticon-rose, emoticon-beer, emoticon-coffee,
//     emoticon-note, emoticon-star, emoticon-rainbow
//   sounds: message, online, signin, nudge, type               (.wav)
const SOUND_MAP = {
  'newalert.wav': 'message.wav', // new instant message
  'newmsg.wav': 'message.wav',
  'online.wav': 'online.wav', // contact signs in
  'newemail.wav': 'signin.wav', // closest spare chime; rename if you like
  'type.wav': 'type.wav',
  'nudge.wav': 'nudge.wav', // MSN 7+
};

const IMAGE_EXTS = new Set(['.bmp', '.png', '.gif', '.jpg', '.ico']);

function which(cmd) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

function extractArchive(file, outDir) {
  if (which('7z')) {
    execFileSync('7z', ['x', '-y', `-o${outDir}`, file], { stdio: 'ignore' });
    return true;
  }
  if (which('cabextract')) {
    execFileSync('cabextract', ['-d', outDir, file], { stdio: 'ignore' });
    return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main() {
  const input = process.argv[2];
  if (!input || !fs.existsSync(input)) {
    console.error('Usage: node scripts/import-original-assets.js <exe-or-folder>');
    process.exit(1);
  }

  fs.mkdirSync(DEST, { recursive: true });
  let searchRoot = input;

  if (fs.statSync(input).isFile()) {
    searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'msn-extract-'));
    console.log(`Extracting ${path.basename(input)} …`);
    if (!extractArchive(input, searchRoot)) {
      console.error('Need 7-Zip (7z) or cabextract on PATH to unpack an exe.');
      process.exit(1);
    }
    // second pass: unpack icon resources from any executables inside
    for (const exe of walk(searchRoot).filter((f) => /\.(exe|dll)$/i.test(f))) {
      const sub = exe + '.rsrc';
      try {
        fs.mkdirSync(sub, { recursive: true });
        extractArchive(exe, sub);
      } catch { /* not an archive 7z understands — skip */ }
    }
  }

  const files = walk(searchRoot);
  let mapped = 0;
  let copied = 0;

  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    const ext = path.extname(base);
    if (ext === '.wav') {
      const target = SOUND_MAP[base] || base;
      fs.copyFileSync(f, path.join(DEST, target));
      SOUND_MAP[base] ? mapped++ : copied++;
      console.log(`  ${SOUND_MAP[base] ? '✓ mapped' : '· copied'} ${base} -> ${target}`);
    } else if (IMAGE_EXTS.has(ext)) {
      fs.copyFileSync(f, path.join(DEST, base));
      copied++;
      console.log(`  · copied ${base}`);
    }
  }

  console.log(`\nDone: ${mapped} auto-mapped, ${copied} copied into ${DEST}`);
  console.log('Rename images to the names the app expects (see comment at');
  console.log('the top of this script) — anything present is used on next launch.');
}

main();
