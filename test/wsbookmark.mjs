// Live end-to-end: addBookmark while recording, see it in the stopped result and
// in listLogs, then startReplay and seek to it.
import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080');
const to = setTimeout(() => { console.error('FAIL timeout'); process.exit(1); }, 15000);
let file = null, phase = 'record', seekTarget = 0, seekSent = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ cmd: 'startRecording', port: 3000, multicast: false, bindAddress: '0.0.0.0' }));
  setTimeout(() => ws.send(JSON.stringify({ cmd: 'addBookmark', label: 'midpoint' })), 700);
  setTimeout(() => ws.send(JSON.stringify({ cmd: 'stopRecording' })), 1600);
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind === 'recordingStopped') {
    const bms = m.result?.bookmarks || [];
    if (!bms.length) { console.error('FAIL no bookmarks in recordingStopped'); process.exit(1); }
    console.log(`OK  recorded with bookmark '${bms[0].label}' @ ${(bms[0].offsetMicros / 1000).toFixed(0)}ms`);
    file = m.result.file;
    ws.send(JSON.stringify({ cmd: 'listLogs' }));
  }
  if (m.kind === 'logs' && file && phase === 'record') {
    phase = 'replay';
    const l = (m.logs || []).find((x) => x.file === file);
    if (!l || !(l.bookmarks || []).length) { console.error('FAIL listLogs missing bookmarks'); process.exit(1); }
    console.log(`OK  listLogs shows ${l.bookmarks.length} bookmark(s) for ${file}`);
    seekTarget = l.durationMs * 1000 * 0.8;
    ws.send(JSON.stringify({ cmd: 'startReplay', file, destAddress: '127.0.0.1', destPort: 3055, multicast: false, speed: 1, loop: false }));
  }
  if (m.kind === 'status' && m.mode === 'replaying' && !seekSent) {
    seekSent = true;
    setTimeout(() => ws.send(JSON.stringify({ cmd: 'seek', offsetMicros: seekTarget })), 100);
  }
  if (m.kind === 'progress' && seekSent && m.progress.positionMs >= (seekTarget / 1000) - 250) {
    clearTimeout(to);
    console.log(`OK  seek jumped playback to ${m.progress.positionMs}ms (target ${(seekTarget / 1000).toFixed(0)}ms)`);
    ws.send(JSON.stringify({ cmd: 'stop' })); ws.close(); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); process.exit(1); });
