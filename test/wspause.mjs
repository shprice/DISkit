// Verifies pause freezes playback position and resume continues from there
// (not jumping forward by the wall-clock time spent paused).
import { WebSocket } from 'ws';
import fs from 'fs';
import { LogWriter } from '../src/logformat.js';

const f = 'logs/_pausetest.dislog';
fs.mkdirSync('logs', { recursive: true });
const w = new LogWriter(f, Date.now());
const pdu = () => { const b = Buffer.alloc(16); b.writeUInt8(7, 0); b.writeUInt8(1, 1); b.writeUInt8(1, 2); b.writeUInt8(1, 3); b.writeUInt16BE(16, 8); return b; };
for (let i = 0; i <= 30; i++) w.write(i * 100000, 3000, pdu()); // 0..3000ms
w.close();
fs.writeFileSync(`${f}.meta.json`, JSON.stringify({ durationMs: 3000, records: 31, bookmarks: [] }));
const cleanup = () => { try { fs.unlinkSync(f); fs.unlinkSync(`${f}.meta.json`); } catch { /* */ } };

const ws = new WebSocket('ws://127.0.0.1:8080');
const to = setTimeout(() => { console.error('FAIL timeout'); cleanup(); process.exit(1); }, 20000);
let pausePos = null, paused = false, resumed = false;

ws.on('open', () => ws.send(JSON.stringify({ cmd: 'startReplay', file: '_pausetest.dislog', destAddress: '127.0.0.1', destPort: 3066, multicast: false, speed: 1, loop: false })));
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind === 'status' && m.mode === 'replaying') setTimeout(() => ws.send(JSON.stringify({ cmd: 'pauseReplay' })), 500);
  if (m.kind !== 'progress') return;
  const p = m.progress;
  if (p.state === 'paused' && pausePos === null) {
    pausePos = p.positionMs; paused = true;
    console.log(`OK  paused at ${pausePos}ms`);
    setTimeout(() => ws.send(JSON.stringify({ cmd: 'resumeReplay' })), 900);
  }
  if (p.state === 'playing' && paused && !resumed) {
    resumed = true;
    const resumePos = p.positionMs;
    clearTimeout(to);
    if (resumePos > pausePos + 350) { console.error(`FAIL resume jumped to ${resumePos}ms from ${pausePos}ms`); cleanup(); process.exit(1); }
    console.log(`OK  resumed at ${resumePos}ms — position frozen during 900ms pause (would be ~${pausePos + 900} if not)`);
    ws.send(JSON.stringify({ cmd: 'stop' })); cleanup(); ws.close(); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); cleanup(); process.exit(1); });
