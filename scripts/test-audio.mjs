// Sends looping DIS Transmitter (type 25) + Signal (type 26) PDUs to test
// the audio decode pipeline. Generates a 440 Hz sine wave as 16-bit PCM BE
// (encoding type 4 — no codec, clean reference signal).
//   node scripts/test-audio.mjs [--port 3000] [--hz 50]

import dgram from 'dgram';
import { performance } from 'perf_hooks';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT    = parseInt(arg('port', '3000'), 10);
const HZ      = parseInt(arg('hz', '10'), 10);   // 10Hz = 100ms interval, accurate on Windows
const SAMPLE_RATE = 8000;
// 1000 samples = 125ms of audio per 100ms real-time: 25% overdelivery absorbs
// Windows setInterval jitter (~15ms per 100ms tick) without underrunning.
const SAMPLES_PER_PDU = parseInt(arg('samples', '1000'), 10);
const FREQ_HZ = 440;                                   // A4 tone

function writeHeader(buf, pduType, family, len) {
  buf.writeUInt8(7, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt8(pduType, 2);
  buf.writeUInt8(family, 3);
  buf.writeUInt32BE((Date.now() % 0xFFFFFFFF) >>> 0, 4);
  buf.writeUInt16BE(len, 8);
  buf.writeUInt16BE(0, 10);
}

function transmitterPdu() {
  const buf = Buffer.alloc(104);
  writeHeader(buf, 25, 4, 104);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o+2); buf.writeUInt16BE(100, o+4); o += 6;
  buf.writeUInt16BE(1, o); o += 2;
  o += 8;
  buf.writeUInt8(2, o); o += 1;  // txState = 2 (transmitting)
  buf.writeUInt8(1, o); o += 1;
  o += 2;
  o += 24;
  o += 16;
  buf.writeBigUInt64BE(BigInt(243e6), o); o += 8;  // 243 MHz VHF guard
  o += 4;
  buf.writeFloatBE(5.0, o);
  return buf;
}

// Signal PDU using 16-bit PCM big-endian (encoding type 4, no codec)
let phase = 0;
function signalPdu() {
  const bytesPerSample = 2;
  const audioData = Buffer.alloc(SAMPLES_PER_PDU * bytesPerSample);
  for (let i = 0; i < SAMPLES_PER_PDU; i++) {
    const linear = Math.round(Math.sin(phase) * 16000);
    audioData.writeInt16BE(linear, i * bytesPerSample);
    phase += (2 * Math.PI * FREQ_HZ) / SAMPLE_RATE;
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
  }

  const len = 32 + audioData.length;
  const buf = Buffer.alloc(len);
  writeHeader(buf, 26, 4, len);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o+2); buf.writeUInt16BE(100, o+4); o += 6;
  buf.writeUInt16BE(1, o); o += 2;
  buf.writeUInt16BE((0 << 14) | 4, o); o += 2;  // class=0 audio, type=4 (16-bit PCM BE)
  buf.writeUInt16BE(0, o); o += 2;
  buf.writeUInt32BE(SAMPLE_RATE, o); o += 4;
  buf.writeUInt16BE(SAMPLES_PER_PDU * 16, o); o += 2;  // bits (16 per sample)
  buf.writeUInt16BE(SAMPLES_PER_PDU, o); o += 2;
  audioData.copy(buf, o);
  return buf;
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.bind(() => {
  sock.setBroadcast(true);
  console.log(`Audio test -> 127.0.0.1:${PORT}  (440 Hz 16-bit PCM, ${SAMPLES_PER_PDU} samples @ ${HZ} Hz)`);
  console.log('Press Ctrl+C to stop.');
});

// At 10Hz the interval is 100ms — well above Windows' ~15ms timer floor,
// so plain setInterval delivers reliably without a busy-wait scheduler.
let tick = 0;
setInterval(() => {
  sock.send(signalPdu(), PORT, '127.0.0.1');
  if (tick++ % HZ === 0) sock.send(transmitterPdu(), PORT, '127.0.0.1');
}, 1000 / HZ);

process.on('SIGINT', () => { sock.close(); process.exit(0); });
