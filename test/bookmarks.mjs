// Tests bookmark capture+persistence and player.seek (skips earlier records).
import assert from 'assert';
import dgram from 'dgram';
import fs from 'fs';
import { Capture } from '../src/capture.js';
import { Player } from '../src/player.js';
import { Stats } from '../src/stats.js';
import { LogWriter, readMeta } from '../src/logformat.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pdu(n) { const b = Buffer.alloc(16); b.writeUInt8(7, 0); b.writeUInt8(1, 1); b.writeUInt8(1, 2); b.writeUInt8(1, 3); b.writeUInt16BE(16, 8); b.writeUInt16BE(n, 12); return b; }

(async () => {
  // ---- 1. bookmark capture + meta persistence ----
  const f1 = './test/_bm.dislog';
  const cap = new Capture({ port: 3099, multicastGroup: null, bindAddress: '127.0.0.1' }, {});
  cap.startRecording(f1, []);
  cap.addBookmark('alpha');
  await sleep(60);
  cap.addBookmark('bravo');
  const meta = cap.stopRecording();
  assert.equal(meta.bookmarks.length, 2, 'two bookmarks in returned meta');
  assert.equal(meta.bookmarks[0].label, 'alpha');
  assert(meta.bookmarks[1].offsetMicros > meta.bookmarks[0].offsetMicros, 'bookmark times increase');
  const m2 = readMeta(f1);
  assert.equal(m2.bookmarks.length, 2, 'bookmarks persisted to sidecar');
  console.log(`OK  bookmarks: ${m2.bookmarks.map((b) => `${b.label}@${(b.offsetMicros / 1000).toFixed(0)}ms`).join(', ')}`);
  fs.unlinkSync(f1); if (fs.existsSync(`${f1}.meta.json`)) fs.unlinkSync(`${f1}.meta.json`);

  // ---- 2. player.seek skips records before the target ----
  const f2 = './test/_seek.dislog';
  const w = new LogWriter(f2, Date.now());
  for (let i = 0; i <= 10; i++) w.write(i * 100000, 3000, pdu(i)); // 0..1000ms, 11 records
  w.close();
  fs.writeFileSync(`${f2}.meta.json`, JSON.stringify({ durationMs: 1000, records: 11 }));

  const rxStats = new Stats();
  const rx = new Capture({ port: 3021, multicastGroup: null, bindAddress: '127.0.0.1' }, { stats: rxStats });
  rx.start();
  await sleep(150);

  let ended = false;
  const player = new Player({ destAddress: '127.0.0.1', destPort: 3021, multicast: false }, { stats: new Stats(), onEnd: () => { ended = true; } });
  player.load(f2);
  player.play({ speed: 1 });
  player.seek(500000); // jump to 500ms immediately

  for (let i = 0; i < 40 && !ended; i++) await sleep(50);
  player.dispose();
  await sleep(100);
  rx.stop();

  assert(ended, 'replay finished after seek');
  // offset 0 sends before seek, then 500..1000ms (6 records) => ~7, never all 11.
  assert(player.sentCount >= 6 && player.sentCount <= 8, `seek skipped early records (sent ${player.sentCount})`);
  assert(player.sentCount < 11, 'did not send the whole file');
  console.log(`OK  seek: sent ${player.sentCount}/11 records (early ones skipped), re-captured ${rxStats.totalPdus}`);

  fs.unlinkSync(f2); fs.unlinkSync(`${f2}.meta.json`);
  console.log('\nBookmark + seek test passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
