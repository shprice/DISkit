// HTTP + WebSocket server that wires the capture engine, recorder, replay
// player and stats together and serves the web UI. Control happens over JSON
// WebSocket messages; a periodic stats snapshot is pushed to all clients.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Capture } from './capture.js';
import { Player } from './player.js';
import { Stats } from './stats.js';
import { exportToPcap } from './pcap.js';
import { readMeta, updateMeta } from './logformat.js';
import { openBrowser, pickFolder } from './os-dialog.js';

export function getLocalBroadcastAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        if (iface.broadcast) return iface.broadcast;
        if (iface.address && iface.netmask) {
          const ip = iface.address.split('.').map(Number);
          const mask = iface.netmask.split('.').map(Number);
          if (ip.length === 4 && mask.length === 4) {
            return ip.map((octet, i) => (octet | (~mask[i] & 0xff))).join('.');
          }
        }
      }
    }
  }
  return '255.255.255.255';
}

export function getNetworkAdapters() {
  const adapters = [{ label: 'All Interfaces', address: '0.0.0.0' }];
  const interfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const iface of addrs || []) {
      if (iface.family === 'IPv4') {
        adapters.push({ label: `${name} (${iface.address})`, address: iface.address });
      }
    }
  }
  return adapters;
}

const __dirname = typeof import.meta !== 'undefined' && import.meta && import.meta.url
  ? path.dirname(fileURLToPath(import.meta.url))
  : path.resolve();
const execDir = path.dirname(process.execPath);
const isSEA = process.execPath.endsWith('dislogger') || process.execPath.endsWith('dislogger.exe');
const ROOT = isSEA ? execDir : path.resolve(__dirname, '..');

const configPath = fs.existsSync(path.join(ROOT, 'config.json'))
  ? path.join(ROOT, 'config.json')
  : path.join(__dirname, '../config.json');

const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
  : { web: { port: 8080, host: '0.0.0.0' }, capture: { port: 3000, multicastGroup: '239.1.2.3', bindAddress: '0.0.0.0' } };

config.replay = config.replay || {};
config.replay.destAddress = getLocalBroadcastAddress();
const logDirSetting = config.logDir || 'logs';
const LOG_DIR = path.isAbsolute(logDirSetting)
  ? logDirSetting
  : path.resolve(ROOT, logDirSetting);
fs.mkdirSync(LOG_DIR, { recursive: true });

const publicDir = fs.existsSync(path.join(ROOT, 'public'))
  ? path.join(ROOT, 'public')
  : path.join(__dirname, '../public');

const app = express();
app.use(express.static(publicDir));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- Shared state ----------------------------------------------------------
const stats = new Stats();
let capture = null;
let player = null;
let mode = 'idle'; // idle | capturing | replaying
let recordDir = LOG_DIR;   // where recordings are saved (record tab)
let browseDir = LOG_DIR;   // which folder the replay dropdown lists (replay tab)

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

const sampleBuffer = [];
function onSample(sample) {
  sampleBuffer.push({
    type: sample.header.pduType,
    name: sample.header.pduTypeName,
    family: sample.header.protocolFamilyName,
    key: sample.body?.entityIdKey || sample.body?.emittingKey || null,
  });
  if (sampleBuffer.length > 100) sampleBuffer.shift();
}

function isRecording() {
  return !!(capture && capture.recorder);
}

// Push a stats snapshot + recent samples a few times a second.
setInterval(() => {
  broadcast({
    kind: 'stats', mode, recording: isRecording(),
    recordFile: isRecording() ? path.basename(capture.recordPath) : null,
    recordedCount: isRecording() ? capture.recordedCount : 0,
    recordStartMs: isRecording() ? capture.recordStartMs : 0,
    recordBytes: isRecording() ? capture.recorder.bytes : 0,
    bookmarks: isRecording() ? capture.bookmarks : null,
    stats: stats.snapshot(), samples: sampleBuffer.splice(0),
  });
}, 250);

// ---- Capture control -------------------------------------------------------
function startCapture(opts) {
  stopAll();
  stats.reset();
  capture = new Capture(
    { port: opts.port, multicastGroup: opts.multicast ? opts.multicastGroup : null, bindAddress: opts.bindAddress },
    { stats, onSample, onError: (e) => broadcast({ kind: 'error', message: String(e.message || e) }) }
  );
  capture.start();
  mode = 'capturing';
  broadcast({ kind: 'status', mode, message: `Listening on ${opts.port}${opts.multicast ? ' (multicast ' + opts.multicastGroup + ')' : ''}` });
}

function startRecording(opts) {
  if (!capture) startCapture(opts);
  let name = opts.filename || `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.dislog`;
  if (!name.endsWith('.dislog')) name += '.dislog';
  fs.mkdirSync(recordDir, { recursive: true });
  const filePath = path.join(recordDir, name);
  capture.startRecording(filePath, opts.filterTypes || [], opts.versionFilter || [], opts.siteFilter || [], opts.appFilter || []);
  broadcast({ kind: 'status', mode, recording: true, message: `Recording to ${filePath}` });
}

function stopRecording() {
  if (capture) {
    const result = capture.stopRecording();
    broadcast({ kind: 'recordingStopped', result });
  }
}

// ---- Replay control --------------------------------------------------------
function startReplay(opts) {
  stopAll();
  stats.reset();
  player = new Player(
    { destAddress: opts.destAddress, destPort: opts.destPort, multicast: opts.multicast, ttl: opts.ttl },
    {
      stats,
      onSample,
      onProgress: (p) => broadcast({ kind: 'progress', progress: p }),
      onEnd: (e) => {
        mode = 'idle';
        broadcast({ kind: 'status', mode, message: 'Replay finished' });
        broadcast({ kind: 'replayEnded', ...e });
      },
      onError: (e) => broadcast({ kind: 'error', message: String(e.message || e) }),
      onVersionWarning: (w) => broadcast({ kind: 'versionWarning', ...w }),
    }
  );
  const meta = player.load(path.join(browseDir, path.basename(opts.file)));
  player.play({
    speed: opts.speed || 1,
    loop: !!opts.loop,
    typeFilter: opts.filterTypes || [],
    versionFilter: opts.versionFilter || [],
    replayAsVersion: opts.replayAsVersion || null,
    siteFilter: opts.siteFilter || [],
    appFilter:  opts.appFilter  || [],
  });
  mode = 'replaying';
  broadcast({ kind: 'status', mode, message: `Replaying ${opts.file} @ ${opts.speed || 1}x`, meta });
}

function stopAll() {
  if (capture) { capture.stop(); capture = null; }
  if (player) { player.dispose(); player = null; }
  stats.reset();
  sampleBuffer.length = 0;
  mode = 'idle';
  broadcast({
    kind: 'stats', mode, recording: false,
    recordFile: null, recordedCount: 0, recordStartMs: 0, recordBytes: 0,
    bookmarks: null, stats: stats.snapshot(), samples: [],
  });
}

// ---- File listing & pcap export -------------------------------------------
function listLogs() {
  let files = [];
  try { files = fs.readdirSync(browseDir); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.dislog'))
    .map((f) => {
      const full = path.join(browseDir, f);
      const st = fs.statSync(full);
      const meta = readMeta(full);
      return {
        file: f,
        sizeBytes: st.size,
        modified: st.mtime.toISOString(),
        durationMs: meta?.durationMs || 0,
        records: meta?.records || 0,
        typeCounts: meta?.typeCounts || {},
        bookmarks: meta?.bookmarks || [],
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// ---- WebSocket message handling -------------------------------------------
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ kind: 'hello', config, mode, recording: isRecording(), recordDir, browseDir, logs: listLogs(), networkAdapters: getNetworkAdapters() }));

  ws.on('message', async (data) => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    try {
      switch (m.cmd) {
        case 'startCapture': startCapture(m); break;
        case 'startRecording': startRecording(m); break;
        case 'stopRecording': stopRecording(); break;
        case 'startReplay': startReplay(m); break;
        case 'pauseReplay': player?.pause(); break;
        case 'resumeReplay': player?.resume(); break;
        case 'seek': player?.seek(m.offsetMicros); break;
        case 'addBookmark': {
          const label = String(m.label || '').slice(0, 200) || 'bookmark';
          if (isRecording()) {
            const bm = capture.addBookmark(label);
            broadcast({ kind: 'bookmarkAdded', bookmark: bm, bookmarks: capture.bookmarks });
          } else {
            const targetFile = m.file ? path.join(browseDir, path.basename(m.file)) : (player ? player.logPath : null);
            if (!targetFile || !fs.existsSync(targetFile)) {
              throw new Error('No active recording or log file selected to add bookmark');
            }
            const offsetMicros = m.offsetMicros != null ? Number(m.offsetMicros) : (player ? player.currentOffsetMicros() : 0);
            const bm = { offsetMicros, label };
            const updatedMeta = updateMeta(targetFile, (meta) => {
              meta.bookmarks = meta.bookmarks || [];
              meta.bookmarks.push(bm);
              meta.bookmarks.sort((a, b) => a.offsetMicros - b.offsetMicros);
              return meta;
            });
            if (player && player.logPath === targetFile) {
              player.meta = updatedMeta;
            }
            broadcast({ kind: 'bookmarkAdded', bookmark: bm, bookmarks: updatedMeta?.bookmarks || [], file: path.basename(targetFile) });
            broadcast({ kind: 'logs', logs: listLogs(), browseDir });
          }
          break;
        }
        case 'setFilters':
          if (player) player.setFilters({
            typeFilter:     m.filterTypes,
            versionFilter:  m.versionFilter,
            siteFilter:     m.siteFilter,
            appFilter:      m.appFilter,
            replayAsVersion: m.replayAsVersion,
          });
          break;
        case 'setSpeed':
          if (player) { player.speed = Math.max(0.01, m.speed); }
          break;
        case 'setLoop':
          if (player) { player.loop = !!m.loop; }
          break;
        case 'stop': stopAll(); broadcast({ kind: 'status', mode, message: 'Stopped' }); break;
        case 'listLogs': ws.send(JSON.stringify({ kind: 'logs', logs: listLogs(), browseDir })); break;
        case 'setRecordDir': {
          const rawDir = String(m.dir || '').trim() || logDirSetting;
          const dir = path.isAbsolute(rawDir) ? rawDir : path.resolve(ROOT, rawDir);
          fs.mkdirSync(dir, { recursive: true });
          recordDir = dir;
          browseDir = dir;                              // browse the same folder by default
          config.logDir = rawDir;                       // persist setting as provided
          try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
          broadcast({ kind: 'dirs', recordDir, browseDir, message: `Save location set to ${dir}` });
          broadcast({ kind: 'logs', logs: listLogs(), browseDir });
          break;
        }
        case 'setBrowseDir': {
          const rawDir = String(m.dir || '').trim() || logDirSetting;
          const dir = path.isAbsolute(rawDir) ? rawDir : path.resolve(ROOT, rawDir);
          fs.mkdirSync(dir, { recursive: true });
          browseDir = dir;
          const foundLogs = listLogs();
          broadcast({ kind: 'dirs', recordDir, browseDir, message: `Opened folder: ${dir} (${foundLogs.length} log file${foundLogs.length === 1 ? '' : 's'})` });
          broadcast({ kind: 'logs', logs: foundLogs, browseDir });
          break;
        }
        case 'browseFolder': {
          const folder = await pickFolder(browseDir);
          const rawDir = folder || browseDir || logDirSetting;
          const dir = path.isAbsolute(rawDir) ? rawDir : path.resolve(ROOT, rawDir);
          fs.mkdirSync(dir, { recursive: true });
          browseDir = dir;
          const foundLogs = listLogs();
          broadcast({ kind: 'dirs', recordDir, browseDir, message: `Opened folder: ${dir} (${foundLogs.length} log file${foundLogs.length === 1 ? '' : 's'})` });
          broadcast({ kind: 'logs', logs: foundLogs, browseDir });
          break;
        }
        case 'browseRecordFolder': {
          const folder = await pickFolder(recordDir || browseDir);
          const rawDir = folder || recordDir || browseDir || logDirSetting;
          const dir = path.isAbsolute(rawDir) ? rawDir : path.resolve(ROOT, rawDir);
          fs.mkdirSync(dir, { recursive: true });
          recordDir = dir;
          browseDir = dir;
          config.logDir = rawDir;
          try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
          const foundLogs = listLogs();
          broadcast({ kind: 'dirs', recordDir, browseDir, message: `Save location set to ${dir}` });
          broadcast({ kind: 'logs', logs: foundLogs, browseDir });
          break;
        }
        case 'exportPcap': {
          const src = path.join(browseDir, path.basename(m.file));
          const out = src.replace(/\.dislog$/, '.pcap');
          const res = exportToPcap(src, out, {});
          broadcast({ kind: 'pcapExported', file: path.basename(out), ...res });
          break;
        }
        case 'deleteLog': {
          const full = path.join(browseDir, path.basename(m.file));
          if (full.endsWith('.dislog') && fs.existsSync(full)) {
            fs.unlinkSync(full);
            if (fs.existsSync(`${full}.meta.json`)) fs.unlinkSync(`${full}.meta.json`);
          }
          ws.send(JSON.stringify({ kind: 'logs', logs: listLogs(), browseDir }));
          break;
        }
        default: break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ kind: 'error', message: String(err.message || err) }));
    }
  });
});

server.listen(config.web.port, config.web.host, () => {
  const hostStr = config.web.host === '0.0.0.0' ? '127.0.0.1' : config.web.host;
  const url = `http://${hostStr}:${config.web.port}`;
  const broadcastAddr = getLocalBroadcastAddress();

  console.log('\n=============================================================');
  console.log('  _____  _____ _____  _    _ _   ');
  console.log(' |  __ \\|_   _/ ____|| |  (_) |  ');
  console.log(' | |  | | | | | (___ | | ___| |_ ');
  console.log(' | |  | | | |  \\___ \\| |/ / | __|');
  console.log(' | |__| |_| |_ ____) |   <| | |_ ');
  console.log(' |_____/|_____|_____/|_|\\_\\_|_|\\__|');
  console.log(' IEEE 1278 DIS Traffic Logger & Replay Utility');
  console.log('=============================================================');
  console.log(` Web UI Server       : ${url}`);
  console.log(` Default Capture Port: ${config.capture?.port || 3000} (UDP)`);
  console.log(` Broadcast Address   : ${broadcastAddr}`);
  console.log(` Storage Directory   : ${LOG_DIR}`);
  console.log(` Configuration       : Edit config.json in the app directory`);
  console.log(`                       to change default settings.`);
  console.log(` Server Status       : RUNNING (Press Ctrl+C to stop)`);
  console.log('=============================================================\n');

  const noOpen = process.argv.includes('--no-open') || config.openBrowser === false;
  if (!noOpen) {
    console.log(`Opening Web UI in default browser (${url})...\n`);
    openBrowser(url);
  }
});

process.on('SIGINT', () => { stopAll(); process.exit(0); });
