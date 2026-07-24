// Connects to the running server over WebSocket, starts a multicast capture,
// and verifies live stats arrive (exercises server.js wiring + the simulator).
import { WebSocket } from 'ws';

const ws = new WebSocket('ws://127.0.0.1:8080');
let got = null;
const timeout = setTimeout(() => { console.error('FAIL timeout waiting for stats'); process.exit(1); }, 8000);

ws.on('open', () => {
  ws.send(JSON.stringify({ cmd: 'startCapture', port: 3000, multicast: true, multicastGroup: '239.1.2.3', bindAddress: '0.0.0.0' }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind === 'stats' && m.stats && m.stats.totalPdus > 0) {
    got = m.stats;
    clearTimeout(timeout);
    console.log(`OK  live stats: ${got.totalPdus} PDUs, ${got.entityCount} entities, ${got.emitterCount} emitters, ${got.pduRate}/s`);
    console.log('    types:', got.types.map((t) => `${t.name}=${t.count}`).join(', '));
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL ws error', e.message); process.exit(1); });
