'use strict';

/**
 * Claude Code sessions as contacts in the Claude section.
 *
 * Claude Code keeps every session as a JSON-lines transcript under
 * ~/.claude/projects/<project>/<session-id>.jsonl, with a title record
 * ("ai-title" or one I set, "custom-title"). Opening one shows the
 * conversation's text (tool calls left out); sending runs the `claude` CLI
 * non-interactively, resuming that session in its own folder, and shows the
 * reply.
 *
 * Transcripts can reach gigabytes, so only their ends are read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const TITLE_TAIL = 512 * 1024;
const HISTORY_TAIL = 8 * 1024 * 1024;
const MAX_MESSAGES = 150;

/** Last `bytes` of a file as complete lines. */
function tailLines(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // cut mid-line
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

function parse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** What I typed, minus the harness's own injected text. */
function userText(e) {
  if (e.isMeta || e.isSidechain) return null;
  const c = e.message?.content;
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  const t = text.trim();
  if (!t || /^<(command-|local-command|system-reminder|task-notification|bash-|user-memory)/.test(t)) return null;
  return t;
}

function assistantText(e) {
  if (e.isSidechain) return null;
  const c = e.message?.content;
  if (!Array.isArray(c)) return null;
  const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return t || null;
}

class ClaudeCode {
  constructor() {
    this.meta = new Map(); // session id -> { file, cwd, title }
    this.claudeBin = null;
  }

  available() {
    return fs.existsSync(ROOT);
  }

  /** Recent sessions, newest first. */
  listSessions(limit = 30) {
    let files = [];
    try {
      for (const dir of fs.readdirSync(ROOT)) {
        const full = path.join(ROOT, dir);
        let names = [];
        try { names = fs.readdirSync(full); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const file = path.join(full, name);
          try { files.push({ file, id: name.slice(0, -6), mtime: fs.statSync(file).mtimeMs }); } catch {}
        }
      }
    } catch {
      return [];
    }
    files = files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    return files.map(({ file, id, mtime }) => {
      const m = this._meta(id, file);
      return m.title ? { id, title: m.title, mtime } : null;
    }).filter(Boolean);
  }

  _meta(id, file) {
    const cached = this.meta.get(id);
    const mtime = fs.statSync(file).mtimeMs;
    if (cached && cached.mtime === mtime) return cached;
    let title = null;
    let custom = null;
    let cwd = null;
    let firstUser = null;
    for (const line of tailLines(file, TITLE_TAIL)) {
      if (!line.includes('"type"')) continue;
      const e = parse(line);
      if (!e) continue;
      if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle;
      if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
      if (e.cwd) cwd = e.cwd;
      if (!firstUser && e.type === 'user') firstUser = userText(e);
    }
    const m = { file, mtime, cwd, title: custom || title || (firstUser ? firstUser.slice(0, 50) : null) };
    this.meta.set(id, m);
    return m;
  }

  title(id) {
    return this.meta.get(id)?.title || 'Claude Code';
  }

  _toUi(jid, lines, out = []) {
    for (const line of lines) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      const e = parse(line);
      if (!e || (e.type !== 'user' && e.type !== 'assistant')) continue;
      const text = e.type === 'user' ? userText(e) : assistantText(e);
      if (!text) continue;
      out.push({
        id: `${jid}:${e.uuid || `${e.timestamp}-${out.length}`}`,
        chatJid: jid,
        fromMe: e.type === 'user',
        text,
        isNudge: false,
        timestamp: Date.parse(e.timestamp) || Date.now(),
        senderName: e.type === 'user' ? null : 'Claude Code',
      });
    }
    return out;
  }

  /** The conversation's text, oldest first, as UI messages. */
  getMessages(jid, id) {
    const m = this.meta.get(id);
    if (!m) return [];
    return this._toUi(jid, tailLines(m.file, HISTORY_TAIL)).slice(-MAX_MESSAGES);
  }

  /**
   * Follow a session while its window is open: whatever gets appended to the
   * transcript (from the terminal or from here) arrives through onNew. Only
   * the new bytes are read each time.
   */
  watch(jid, id, onNew) {
    const m = this.meta.get(id);
    if (!m || this.watchers?.has(id)) return;
    if (!this.watchers) this.watchers = new Map();
    let offset = fs.statSync(m.file).size;
    let rest = '';
    const check = (cur) => {
      if (cur.size <= offset) { offset = Math.min(offset, cur.size); return; }
      const fd = fs.openSync(m.file, 'r');
      try {
        const buf = Buffer.alloc(cur.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = cur.size;
        const lines = (rest + buf.toString('utf8')).split('\n');
        rest = lines.pop(); // incomplete last line waits for the next read
        const msgs = this._toUi(jid, lines);
        if (msgs.length) onNew(msgs);
      } finally {
        fs.closeSync(fd);
      }
    };
    fs.watchFile(m.file, { interval: 1000 }, check);
    this.watchers.set(id, m.file);
  }

  unwatch(id) {
    const file = this.watchers?.get(id);
    if (!file) return;
    fs.unwatchFile(file);
    this.watchers.delete(id);
  }

  _bin() {
    if (this.claudeBin) return this.claudeBin;
    const exe = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];
    const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')];
    for (const d of dirs) {
      for (const e of exe) {
        const f = path.join(d, e);
        if (fs.existsSync(f)) return (this.claudeBin = f);
      }
    }
    return null;
  }

  /** Resume the session with one message and resolve with the reply text. */
  send(id, text) {
    const m = this.meta.get(id);
    const bin = this._bin();
    if (!m) return Promise.reject(new Error('sessão não encontrada'));
    if (!bin) return Promise.reject(new Error('o comando claude não foi encontrado'));
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ['-p', '--resume', id, text], {
        cwd: m.cwd && fs.existsSync(m.cwd) ? m.cwd : os.homedir(),
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new Error((err || out || `saiu com código ${code}`).trim().slice(0, 300)));
      });
    });
  }
}

module.exports = { ClaudeCode };
