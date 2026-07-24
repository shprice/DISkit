// Verifies record -> stopRecording over the live WebSocket path.
import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080');
const timeout = setTimeout(() => { console.error('FAIL timeout'); process.exit(1); }, 10000);
let recording = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ cmd: 'startRecording', port: 3000, multicast: true, multicastGroup: '239.1.2.3', bindAddress: '0.0.0.0' }));
  setTimeout(() => ws.send(JSON.stringify({ cmd: 'stopRecording' })), 1500);
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind === 'stats') recording = m.recording;
  if (m.kind === 'recordingStopped') {
    clearTimeout(timeout);
    const r = m.result || {};
    console.log(`OK  recordingStopped: ${r.records} records, file=${r.file}, recording-flag-was=${recording}`);
    if (!r.records || r.records < 1) { console.error('FAIL no records written'); process.exit(1); }
    ws.close(); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); process.exit(1); });
