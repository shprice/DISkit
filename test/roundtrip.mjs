// Sanity checks: PDU encode->decode round trip, coord conversion, log I/O.
import assert from 'assert';
import fs from 'fs';
import { parsePdu } from '../src/dis/pdu.js';
import { ecefToGeodetic, geodeticToEcef } from '../src/dis/coords.js';
import { LogWriter, LogReader } from '../src/logformat.js';
import { exportToPcap } from '../src/pcap.js';

// Build the same Entity State PDU the simulator emits, then decode it.
import { geodeticToEcef as g2e } from '../src/dis/coords.js';
function esPdu(lat, lon, alt, marking) {
  const buf = Buffer.alloc(144);
  buf.writeUInt8(7, 0); buf.writeUInt8(1, 1); buf.writeUInt8(1, 2); buf.writeUInt8(1, 3);
  buf.writeUInt16BE(144, 8);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o + 2); buf.writeUInt16BE(101, o + 4); o += 6;
  buf.writeUInt8(2, o); o += 1; buf.writeUInt8(0, o); o += 1;
  buf.writeUInt8(1, o); buf.writeUInt8(2, o + 1); buf.writeUInt16BE(225, o + 2); o += 8; o += 8;
  buf.writeFloatBE(100, o); o += 12;
  const { x, y, z } = g2e(lat, lon, alt);
  buf.writeDoubleBE(x, o); buf.writeDoubleBE(y, o + 8); buf.writeDoubleBE(z, o + 16); o += 24;
  buf.writeFloatBE(Math.PI / 2, o); o += 12; buf.writeUInt32BE(0, o); o += 4; o += 40;
  buf.writeUInt8(1, o); buf.write(marking, o + 1, 'ascii'); o += 12; buf.writeUInt32BE(0, o);
  return buf;
}

// 1. Coord round trip
{
  const { x, y, z } = geodeticToEcef(51.2, -1.8, 3000);
  const g = ecefToGeodetic(x, y, z);
  assert(Math.abs(g.lat - 51.2) < 1e-6, 'lat round trip');
  assert(Math.abs(g.lon - -1.8) < 1e-6, 'lon round trip');
  assert(Math.abs(g.alt - 3000) < 1e-3, 'alt round trip');
  console.log('OK  coord round trip', g.lat.toFixed(5), g.lon.toFixed(5), g.alt.toFixed(2));
}

// 2. PDU decode
{
  const pdu = esPdu(51.2, -1.8, 3000, 'AC101');
  const { header, body } = parsePdu(pdu);
  assert.equal(header.pduType, 1);
  assert.equal(header.pduTypeName, 'EntityState');
  assert.equal(body.marking, 'AC101');
  assert.equal(body.forceName, 'Opposing');
  assert(Math.abs(body.geo.lat - 51.2) < 1e-4, 'decoded lat');
  assert(Math.abs(body.geo.lon - -1.8) < 1e-4, 'decoded lon');
  console.log('OK  ESPDU decode', body.marking, body.geo.lat.toFixed(4), body.geo.lon.toFixed(4), 'hdg', body.headingDeg.toFixed(1));
}

// 3. Log write/read round trip + pcap export
{
  const tmp = './test/_tmp.dislog';
  const w = new LogWriter(tmp);
  const a = esPdu(51.2, -1.8, 3000, 'AC101');
  const b = esPdu(51.3, -1.7, 3200, 'AC102');
  w.write(0, 3000, a); w.write(100000, 3000, b); w.close();

  const r = new LogReader(tmp);
  const r1 = r.readNext(); const r2 = r.readNext(); const r3 = r.readNext();
  assert(r1 && r2 && r3 === null, 'two records then EOF');
  assert.equal(r1.offsetMicros, 0); assert.equal(r2.offsetMicros, 100000);
  assert(r1.pdu.equals(a), 'record 1 bytes match');
  r.close();
  console.log('OK  log write/read round trip (2 records)');

  const res = exportToPcap(tmp, './test/_tmp.pcap', { dstIp: '239.1.2.3' });
  assert.equal(res.packets, 2);
  const pc = fs.readFileSync('./test/_tmp.pcap');
  assert.equal(pc.readUInt32LE(0) >>> 0, 0xa1b2c3d4, 'pcap magic');
  console.log('OK  pcap export', res.packets, 'packets', res.bytes, 'bytes');

  fs.unlinkSync(tmp); fs.unlinkSync('./test/_tmp.pcap');
}

console.log('\nAll checks passed.');
