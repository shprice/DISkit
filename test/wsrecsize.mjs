// Verifies the recorded file size (recordBytes) grows during recording.
import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080');
const to = setTimeout(() => { console.error('FAIL timeout'); process.exit(1); }, 12000);
let first = null, last = 0, samples = 0;

ws.on('open', () => ws.send(JSON.stringify({ cmd: 'startRecording', port: 3000, multicast: false, bindAddress: '0.0.0.0' })));
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind !== 'stats' || !m.recording) return;
  samples += 1;
  if (first === null) first = m.recordBytes;
  last = m.recordBytes;
  if (samples >= 6) {
    clearTimeout(to);
    ws.send(JSON.stringify({ cmd: 'stopRecording' }));
    if (last <= 0 || last <= first) { console.error(`FAIL recordBytes did not grow (${first} -> ${last})`); process.exit(1); }
    console.log(`OK  recordBytes grew ${first} -> ${last} bytes over ${samples} ticks`);
    ws.close(); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); process.exit(1); });
