// Verifies setBrowseDir lists logs from an arbitrary folder and feeds the dropdown.
import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { LogWriter, writeMeta } from '../src/logformat.js';

const dir2 = path.resolve('./test/_logs2');
fs.rmSync(dir2, { recursive: true, force: true });
fs.mkdirSync(dir2, { recursive: true });
const f = path.join(dir2, 'sample.dislog');
const w = new LogWriter(f); w.write(0, 3000, Buffer.alloc(12)); w.close();
writeMeta(f, { records: 1, durationMs: 1234 });

const ws = new WebSocket('ws://127.0.0.1:8080');
const to = setTimeout(() => { console.error('FAIL timeout'); process.exit(1); }, 6000);
ws.on('open', () => ws.send(JSON.stringify({ cmd: 'setBrowseDir', dir: dir2 })));
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.kind === 'logs') {
    clearTimeout(to);
    const has = (m.logs || []).some((l) => l.file === 'sample.dislog');
    if (!has) { console.error('FAIL sample.dislog not listed'); process.exit(1); }
    if (!m.browseDir || path.resolve(m.browseDir) !== dir2) { console.error('FAIL browseDir not echoed'); process.exit(1); }
    console.log(`OK  setBrowseDir listed ${m.logs.length} log(s) from ${m.browseDir}`);
    ws.close(); fs.rmSync(dir2, { recursive: true, force: true }); process.exit(0);
  }
});
ws.on('error', (e) => { console.error('FAIL', e.message); process.exit(1); });
