// Built-in DIS traffic generator for testing the logger/replay without a live
// source. Emits Entity State PDUs for a handful of entities flying a circular
// pattern, plus one Electromagnetic Emission PDU, onto the configured port.
//
// Sends unicast to 127.0.0.1 by default; pass a multicast --group to use MC.
//   node src/simulator.js [--group 127.0.0.1] [--port 3000] [--count 6] [--hz 10]

import dgram from 'dgram';
import { geodeticToEcef } from './dis/coords.js';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const GROUP = arg('group', '127.0.0.1');
const PORT = parseInt(arg('port', '3000'), 10);
const COUNT = parseInt(arg('count', '6'), 10);
const HZ = parseInt(arg('hz', '10'), 10);
const isMulticast = /^2(2[4-9]|3\d)\./.test(GROUP);

// Centre the scenario somewhere recognisable (Salisbury Plain, UK).
const CENTER_LAT = 51.2;
const CENTER_LON = -1.8;

function writeHeader(buf, pduType, family, len) {
  buf.writeUInt8(7, 0);        // protocol version IEEE 1278.1-2012
  buf.writeUInt8(1, 1);        // exercise id
  buf.writeUInt8(pduType, 2);
  buf.writeUInt8(family, 3);
  buf.writeUInt32BE((Date.now() % 0xffffffff) >>> 0, 4);
  buf.writeUInt16BE(len, 8);
  buf.writeUInt8(0, 10);
  buf.writeUInt8(0, 11);
}

function entityStatePdu(idx, t) {
  const buf = Buffer.alloc(144);
  writeHeader(buf, 1, 1, 144);
  let o = 12;
  // entity id
  buf.writeUInt16BE(17, o);        // site
  buf.writeUInt16BE(1, o + 2);     // application
  buf.writeUInt16BE(100 + idx, o + 4); // entity
  o += 6;
  buf.writeUInt8((idx % 2) + 1, o); o += 1;   // force: alternate friendly/opposing
  buf.writeUInt8(0, o); o += 1;               // articulation count
  // entity type (e.g. 1.2.225.1.x = air platform)
  buf.writeUInt8(1, o); buf.writeUInt8(2, o + 1); buf.writeUInt16BE(225, o + 2);
  buf.writeUInt8(1, o + 4); buf.writeUInt8(idx + 1, o + 5);
  o += 8;
  o += 8; // alt entity type

  // position: circle of radius ~0.1deg, each entity offset in phase
  const ang = t * 0.2 + (idx * 2 * Math.PI) / COUNT;
  const lat = CENTER_LAT + 0.1 * Math.cos(ang);
  const lon = CENTER_LON + 0.1 * Math.sin(ang);
  const alt = 3000 + idx * 200;
  const { x, y, z } = geodeticToEcef(lat, lon, alt);

  buf.writeFloatBE(120, o); buf.writeFloatBE(0, o + 4); buf.writeFloatBE(0, o + 8); // velocity
  o += 12;
  buf.writeDoubleBE(x, o); buf.writeDoubleBE(y, o + 8); buf.writeDoubleBE(z, o + 16);
  o += 24;
  // Convert local compass heading to ECEF PSI (IEEE 1278.1 convention).
  // Inverse of: heading = atan2(sin(PSI - lon), -sin(lat) * cos(PSI - lon))
  const localHeading = ang + Math.PI / 2;
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const psi = lonRad + Math.atan2(Math.sin(localHeading) * Math.sin(latRad), -Math.cos(localHeading));
  buf.writeFloatBE(psi, o); // psi (ECEF heading)
  buf.writeFloatBE(0, o + 4); buf.writeFloatBE(0, o + 8);
  o += 12;
  buf.writeUInt32BE(0, o); o += 4;   // appearance
  o += 40;                           // dead reckoning
  const marking = `AC${100 + idx}`;
  buf.writeUInt8(1, o); buf.write(marking, o + 1, 'ascii');
  o += 12;
  buf.writeUInt32BE(0, o);
  return buf;
}

function emissionPdu() {
  const buf = Buffer.alloc(96);
  writeHeader(buf, 23, 6, 96);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o + 2); buf.writeUInt16BE(100, o + 4); // emitting entity
  o += 6;
  o += 6;                  // event id
  buf.writeUInt8(0, o); o += 1;          // state update indicator
  buf.writeUInt8(1, o); o += 1;          // numSystems
  o += 2;                  // padding
  // system
  buf.writeUInt8(17, o);   // systemDataLength words (68/4)
  buf.writeUInt8(1, o + 1); // numBeams
  o += 4;
  buf.writeUInt16BE(4000, o); // emitter name
  buf.writeUInt8(2, o + 2);   // function
  buf.writeUInt8(1, o + 3);   // number
  o += 4;
  o += 12;                 // location relative to entity
  // beam
  buf.writeUInt8(12, o);   // beamDataLength words (48/4)
  buf.writeUInt8(1, o + 1); // beam number
  o += 4;
  buf.writeFloatBE(9.4e9, o); o += 4;   // frequency (X-band)
  o += 4;                               // freq range
  buf.writeFloatBE(120, o); o += 4;     // ERP
  buf.writeFloatBE(1000, o); o += 4;    // PRF
  buf.writeFloatBE(1.2, o); o += 4;     // pulse width
  o += 4 * 4;                           // az/el center+sweep
  o += 4;                               // sweep sync
  buf.writeUInt8(4, o); o += 1;         // beam function: Tracking
  buf.writeUInt8(0, o); o += 1;         // num targets
  return buf;
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.bind(() => {
  if (isMulticast) {
    sock.setMulticastTTL(8);
    sock.setMulticastLoopback(true);
  } else {
    sock.setBroadcast(true);
  }
  console.log(`DIS simulator -> ${GROUP}:${PORT}  (${COUNT} entities @ ${HZ} Hz)`);
});

let t = 0;
setInterval(() => {
  t += 1 / HZ;
  for (let i = 0; i < COUNT; i++) {
    const pdu = entityStatePdu(i, t);
    sock.send(pdu, PORT, GROUP);
  }
  // Emit an emission PDU once a second.
  if (Math.floor(t * HZ) % HZ === 0) sock.send(emissionPdu(), PORT, GROUP);
}, 1000 / HZ);

process.on('SIGINT', () => { sock.close(); process.exit(0); });
