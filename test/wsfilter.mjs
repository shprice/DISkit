// Verifies record filter = allow-list of ticked types. Records only type 23
// (Emission, ~1/s from the simulator) while EntityState (type 1, ~120/s) flows.
import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8080');
const timeout = setTimeout(() => { console.error('FAIL timeout'); process.exit(1); }, 12000);
let seenTotal = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ cmd: 'startRecording', port: 3000, multicast: true, multicastGroup: '239.1.2.3', bindAddress: '0.0.0.0', filterTypes: [23] }));
  setTimeout(() => ws.send(JSON.stringify({ cmd: 'stopRecording' })), 3000);
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind === 'stats') seenTotal = m.stats.totalPdus;
  if (m.kind === 'recordingStopped') {
    clearTimeout(timeout);
    const r = m.result || {};
    console.log(`OK  filter [23]: recorded ${r.records} of ${seenTotal} seen PDUs`);
    if (r.records < 1) { console.error('FAIL recorded nothing'); process.exit(1); }
    if (r.records > 30 || r.records >= seenTotal) { console.error(`FAIL filter not applied (recorded ${r.records})`); process.exit(1); }
    ws.close(); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); process.exit(1); });
