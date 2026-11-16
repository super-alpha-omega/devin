'use strict';
// Local persistence and process locks; no network operations.
const fs = require('fs');
const path = require('path');

function fsyncFile(file) {
  let fd;
  try { fd = fs.openSync(file, 'r+'); fs.fsyncSync(fd); } catch (e) { /* best effort */ } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temp, 'w');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, file); return; } catch (exc) {
      // Windows: antivirus/indexer may briefly hold the target file.
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(exc.code)) { try { fs.unlinkSync(temp); } catch (e) { /* ignore */ } throw exc; }
      const until = Date.now() + 50; while (Date.now() < until) { /* short spin */ }
    }
  }
}

function saveJson(file, values) { writeAtomic(file, JSON.stringify(values, null, 2)); }

function loadJson(file, fallback = null) {
  for (const candidate of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { /* try backup */ }
  }
  return fallback;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// PID lock: a stale lock from a crashed process is taken over automatically.
class InstanceLock {
  constructor(file, message = 'Бот уже открыт из этой папки. Используйте существующее окно.') {
    this.file = file; fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = fs.openSync(file, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); this.held = true; return;
      } catch (exc) {
        if (exc.code !== 'EEXIST') throw exc;
        let pid = NaN; try { pid = parseInt(fs.readFileSync(file, 'utf8'), 10); } catch (e) { /* unreadable */ }
        if (pid === process.pid) { this.held = true; return; }
        if (processAlive(pid)) { const err = new Error(message); err.lockHeld = true; throw err; }
        try { fs.unlinkSync(file); } catch (e) { /* raced */ }
      }
    }
    throw new Error(message);
  }
  close() {
    if (!this.held) return; this.held = false;
    try { if (parseInt(fs.readFileSync(this.file, 'utf8'), 10) === process.pid) fs.unlinkSync(this.file); } catch (e) { /* ignore */ }
  }
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function readEnv(file) { try { return parseEnv(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; } }
function writeEnv(file, updates) {
  const values = { ...readEnv(file), ...updates };
  writeAtomic(file, Object.entries(values).map(([k, v]) => `${k}='${String(v).replace(/'/g, '')}'`).join('\n') + '\n');
  try { fs.chmodSync(file, 0o600); } catch (e) { /* windows */ }
}

module.exports = { saveJson, loadJson, writeAtomic, fsyncFile, InstanceLock, processAlive, readEnv, writeEnv };
