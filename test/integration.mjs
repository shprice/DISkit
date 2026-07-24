// End-to-end: send DIS over real UDP -> capture+record -> replay -> re-capture.
import assert from 'assert';
import dgram from 'dgram';
import fs from 'fs';
import { Capture } from '../src/capture.js';
import { Player } from '../src/player.js';
import { Stats } from '../src/stats.js';
import { geodeticToEcef } from '../src/dis/coords.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esPdu(entity, lat, lon) {
  const buf = Buffer.alloc(144);
  buf.writeUInt8(7, 0); buf.writeUInt8(1, 1); buf.writeUInt8(1, 2); buf.writeUInt8(1, 3);
  buf.writeUInt16BE(144, 8);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o + 2); buf.writeUInt16BE(entity, o + 4); o += 6;
  buf.writeUInt8(1, o); o += 2;
  buf.writeUInt8(1, o); buf.writeUInt8(2, o + 1); buf.writeUInt16BE(225, o + 2); o += 16;
  o += 12;
  const { x, y, z } = geodeticToEcef(lat, lon, 3000);
  buf.writeDoubleBE(x, o); buf.writeDoubleBE(y, o + 8); buf.writeDoubleBE(z, o + 16); o += 24;
  o += 12; o += 4; o += 40;
  buf.writeUInt8(1, o); buf.write(`E${entity}`, o + 1, 'ascii');
  return buf;
}

const LOG = './test/_integ.dislog';

(async () => {
  // ---- capture + record on 3010 ----
  const capStats = new Stats();
  const cap = new Capture({ port: 3010, multicastGroup: null, bindAddress: '127.0.0.1' }, { stats: capStats });
  cap.start();
  await sleep(150);
  cap.startRecording(LOG, []); // record everything

  const tx = dgram.createSocket('udp4');
  const N = 20;
  for (let i = 0; i < N; i++) {
    tx.send(esPdu(100 + (i % 4), 51.2 + i * 0.01, -1.8 + i * 0.01), 3010, '127.0.0.1');
    await sleep(20);
  }
  await sleep(150);
  const meta = cap.stopRecording();
  cap.stop();
  tx.close();

  assert(meta.records === N, `recorded ${meta.records}, expected ${N}`);
  assert(capStats.entities.size > 0, 'tracked entities during capture');
  console.log('OK  captured + recorded', meta.records, 'PDUs,', capStats.entities.size, 'entities');

  // ---- replay on 3011, re-capture ----
  const rxStats = new Stats();
  const rxCap = new Capture({ port: 3011, multicastGroup: null, bindAddress: '127.0.0.1' }, { stats: rxStats });
  rxCap.start();
  await sleep(150);

  let ended = false;
  const player = new Player(
    { destAddress: '127.0.0.1', destPort: 3011, multicast: false },
    { stats: new Stats(), onEnd: () => { ended = true; } }
  );
  player.load(LOG);
  const t0 = Date.now();
  player.play({ speed: 10, loop: false });

  for (let i = 0; i < 100 && !ended; i++) await sleep(50);
  const elapsed = Date.now() - t0;
  player.dispose();
  await sleep(150);
  rxCap.stop();

  assert(ended, 'replay reached end');
  assert(player.sentCount === N, `replayed ${player.sentCount}, expected ${N}`);
  assert(rxStats.totalPdus >= N - 1, `re-captured ${rxStats.totalPdus} of ${N}`);
  // Original span ~ 20*20ms = 400ms; at 10x should finish well under 400ms.
  assert(elapsed < 350, `10x replay took ${elapsed}ms (should be < real-time 400ms)`);
  console.log('OK  replayed', player.sentCount, 'PDUs @10x in', elapsed, 'ms; re-captured', rxStats.totalPdus);

  fs.unlinkSync(LOG); fs.unlinkSync(`${LOG}.meta.json`);
  console.log('\nIntegration test passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
