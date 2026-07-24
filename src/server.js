// HTTP + WebSocket server that wires the capture engine, recorder, replay
// player and stats together and serves the web UI. Control happens over JSON
// WebSocket messages; a periodic stats snapshot is pushed to all clients.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { Capture } from './capture.js';
import { Player } from './player.js';
import { Stats } from './stats.js';
import { exportToPcap } from './pcap.js';
import { readMeta } from './logformat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const LOG_DIR = path.resolve(ROOT, config.logDir || 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
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
  capture.startRecording(filePath, opts.filterTypes || [], opts.versionFilter || []);
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
      onEnd: (e) => broadcast({ kind: 'replayEnded', ...e }),
      onError: (e) => broadcast({ kind: 'error', message: String(e.message || e) }),
      onVersionWarning: (w) => broadcast({ kind: 'versionWarning', ...w }),
    }
  );
  const meta = player.load(path.join(browseDir, opts.file));
  player.play({
    speed: opts.speed || 1,
    loop: !!opts.loop,
    typeFilter: opts.filterTypes || [],
    versionFilter: opts.versionFilter || [],
    replayAsVersion: opts.replayAsVersion || null,
  });
  mode = 'replaying';
  broadcast({ kind: 'status', mode, message: `Replaying ${opts.file} @ ${opts.speed || 1}x`, meta });
}

function stopAll() {
  if (capture) { capture.stop(); capture = null; }
  if (player) { player.dispose(); player = null; }
  mode = 'idle';
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
  ws.send(JSON.stringify({ kind: 'hello', config, mode, recording: isRecording(), recordDir, browseDir, logs: listLogs() }));

  ws.on('message', (data) => {
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
          if (!isRecording()) { throw new Error('Not recording — start a recording to add bookmarks'); }
          const bm = capture.addBookmark(m.label);
          broadcast({ kind: 'bookmarkAdded', bookmark: bm, bookmarks: capture.bookmarks });
          break;
        }
        case 'setSpeed':
          if (player) { player.speed = Math.max(0.01, m.speed); }
          break;
        case 'setLoop':
          if (player) { player.loop = !!m.loop; }
          break;
        case 'stop': stopAll(); broadcast({ kind: 'status', mode, message: 'Stopped' }); break;
        case 'listLogs': ws.send(JSON.stringify({ kind: 'logs', logs: listLogs(), browseDir })); break;
        case 'setRecordDir': {
          const dir = path.resolve(m.dir || '');
          fs.mkdirSync(dir, { recursive: true });
          recordDir = dir;
          browseDir = dir;                              // browse the same folder by default
          config.logDir = dir;                          // persist as the new default
          fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(config, null, 2));
          broadcast({ kind: 'dirs', recordDir, browseDir, message: `Save location set to ${dir}` });
          broadcast({ kind: 'logs', logs: listLogs(), browseDir });
          break;
        }
        case 'setBrowseDir': {
          const dir = path.resolve(m.dir || '');
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new Error(`Not a folder: ${dir}`);
          }
          browseDir = dir;
          ws.send(JSON.stringify({ kind: 'logs', logs: listLogs(), browseDir }));
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
  console.log(`DISLogger UI: http://${config.web.host}:${config.web.port}`);
  console.log(`Logs directory: ${LOG_DIR}`);
});

process.on('SIGINT', () => { stopAll(); process.exit(0); });
