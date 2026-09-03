// Sends looping DIS Transmitter (type 25) + Signal (type 26) PDUs cycling through
// codec combinations. A synthesised voice announces the codec name and sample rate
// while encoded in that format, so you can hear the quality difference directly.
//   node scripts/test-audio.mjs [--port 3000] [--host 127.0.0.1] [--dwell 8]
//
// Requires: Windows (uses PowerShell System.Speech.Synthesis for TTS generation)

import dgram from 'dgram';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const PORT     = parseInt(arg('port', '3000'), 10);
const HOST     = arg('host', '127.0.0.1');
const DWELL_MS = parseInt(arg('dwell', '8'), 10) * 1000;
const HZ       = 10;   // 100ms interval — above Windows ~15ms timer floor

// ── Codec combinations ────────────────────────────────────────────────────────
// Each combo gets a unique radioId so they each maintain independent server-side
// state (separate batch-map entries, separate audio channels in the client).

const COMBOS = [
  { radioId: 1, encodingType: 1, sampleRate:  8000, label: 'G 711 mu-law,  8 kilohertz' },
  { radioId: 2, encodingType: 4, sampleRate:  8000, label: '16 bit P C M,  8 kilohertz' },
  { radioId: 3, encodingType: 4, sampleRate: 16000, label: '16 bit P C M, 16 kilohertz' },
  { radioId: 4, encodingType: 5, sampleRate:  8000, label: '8 bit unsigned P C M,  8 kilohertz' },
  { radioId: 5, encodingType: 2, sampleRate: 32000, label: 'C V S D, 32 kilohertz' },
];

// ── TTS: Windows PowerShell System.Speech.Synthesis ──────────────────────────
// TTS is synthesised at each combo's native sample rate — no JS resampling needed.

function synthesizeWav(text, sampleRate, outWav) {
  const psLines = [
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(${sampleRate}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)`,
    `$synth.SetOutputToWaveFile('${outWav.replace(/'/g, "''")}', $fmt)`,
    `$synth.Speak('${text.replace(/'/g, "''")}')`,
    '$synth.Dispose()',
  ];
  const tmpPs1 = path.join(os.tmpdir(), `dis_tts_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmpPs1, psLines.join('\r\n'), 'utf8');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpPs1}"`, { stdio: 'pipe' });
  } finally {
    try { fs.unlinkSync(tmpPs1); } catch {}
  }
}

// ── WAV → Int16 LE ────────────────────────────────────────────────────────────

function parseWav(wavPath) {
  const buf = fs.readFileSync(wavPath);
  let o = 12; // skip RIFF+WAVE header
  while (o < buf.length - 8) {
    const tag  = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (tag === 'data') {
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(o + 8 + i * 2);
      return pcm;
    }
    o += 8 + size;
  }
  throw new Error('No data chunk found in WAV');
}

// ── Codec encoders ────────────────────────────────────────────────────────────

function pcm16ToMulaw(sample) {
  // BIAS=132 matches MULAW_EXP_LUT in src/audio.js: LUT[n] = 132*(2^n − 1).
  // Mantissa uses the standard G.711 formula (sv >> (n+3)) & 0x0F to avoid
  // negative results when sv falls just below a segment boundary.
  const BIAS = 132;
  let s = Math.max(-32767, Math.min(32767, sample));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  const sv  = s + BIAS;
  const n   = Math.max(0, Math.min(7, (31 - Math.clz32(sv)) - 7));
  const mantissa = (sv >> (n + 3)) & 0x0F;
  return (~(sign | (n << 4) | mantissa)) & 0xFF;
}

// CVSD encoder — parameters must exactly match the decoder in src/audio.js.
// Input: Int16 PCM at the target sample rate.  Output: 1 bit/sample, MSB-first packed bytes.
function pcm16ToCVSD(int16) {
  const DELTA_MIN = 10 / 32768;
  const DELTA_MAX = 1280 / 32768;
  const STEP_UP   = 2.0;
  const STEP_DOWN = 0.80;
  const RUN_MASK  = 0x07;
  const LEAK      = 0.9997;

  const numBytes = Math.ceil(int16.length / 8);
  const out = Buffer.alloc(numBytes, 0);
  let acc = 0, delta = DELTA_MIN, history = 0;

  for (let i = 0; i < int16.length; i++) {
    const target = int16[i] / 32768;
    const bit = acc < target ? 1 : 0;
    history = ((history << 1) | bit) & RUN_MASK;
    delta = (history === 0 || history === RUN_MASK)
      ? Math.min(delta * STEP_UP,   DELTA_MAX)
      : Math.max(delta * STEP_DOWN, DELTA_MIN);
    acc = acc * LEAK + (bit ? delta : -delta);
    if (bit) out[i >> 3] |= (1 << (7 - (i & 7)));
  }
  return out;
}

// Input: Int16 PCM already at the target sample rate (no resampling done here).
function encodeCombo(int16, encodingType) {
  if (encodingType === 1) {
    const out = Buffer.allocUnsafe(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = pcm16ToMulaw(int16[i]);
    return out;
  }
  if (encodingType === 2) {
    return pcm16ToCVSD(int16);
  }
  if (encodingType === 4) {
    const out = Buffer.allocUnsafe(int16.length * 2);
    for (let i = 0; i < int16.length; i++) out.writeInt16BE(int16[i], i * 2);
    return out;
  }
  if (encodingType === 5) {
    const out = Buffer.allocUnsafe(int16.length);
    for (let i = 0; i < int16.length; i++) out[i] = ((int16[i] >> 8) + 128) & 0xFF;
    return out;
  }
  throw new Error(`Unsupported encodingType ${encodingType}`);
}

// ── DIS PDU builders ──────────────────────────────────────────────────────────

function writeHeader(buf, pduType, family, len) {
  buf.writeUInt8(7, 0); buf.writeUInt8(1, 1);
  buf.writeUInt8(pduType, 2); buf.writeUInt8(family, 3);
  buf.writeUInt32BE((Date.now() % 0xFFFFFFFF) >>> 0, 4);
  buf.writeUInt16BE(len, 8); buf.writeUInt16BE(0, 10);
}

function transmitterPdu(radioId) {
  const buf = Buffer.alloc(104);
  writeHeader(buf, 25, 4, 104);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o+2); buf.writeUInt16BE(100, o+4); o += 6;
  buf.writeUInt16BE(radioId, o); o += 2;
  o += 8;
  buf.writeUInt8(2, o); o += 1; buf.writeUInt8(1, o); o += 1;
  o += 26; o += 16;
  buf.writeBigUInt64BE(BigInt(243e6), o); o += 8;
  o += 4;
  buf.writeFloatBE(5.0, o);
  return buf;
}

function makeSignalPdu(chunk, sampleRate, encodingType, radioId) {
  // CVSD: 1 bit/sample packed into bytes → numSamples = chunk.length * 8, dataLengthBits = numSamples
  const bitsPerSample = encodingType === 4 ? 16 : encodingType === 2 ? 1 : 8;
  const numSamples    = encodingType === 4 ? chunk.length / 2
                      : encodingType === 2 ? chunk.length * 8
                      : chunk.length;
  const len = 32 + chunk.length;
  const buf = Buffer.alloc(len);
  writeHeader(buf, 26, 4, len);
  let o = 12;
  buf.writeUInt16BE(17, o); buf.writeUInt16BE(1, o+2); buf.writeUInt16BE(100, o+4); o += 6;
  buf.writeUInt16BE(radioId, o); o += 2;
  buf.writeUInt16BE((0 << 14) | encodingType, o); o += 2;
  buf.writeUInt16BE(0, o); o += 2;
  buf.writeUInt32BE(sampleRate, o); o += 4;
  buf.writeUInt16BE(numSamples * bitsPerSample, o); o += 2;
  buf.writeUInt16BE(numSamples, o); o += 2;
  chunk.copy(buf, o);
  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const tmpDir = os.tmpdir();
  console.log('Synthesising TTS announcements via Windows SAPI (one-time)...');

  const encoded = [];
  for (const combo of COMBOS) {
    const wavPath = path.join(tmpDir, `dis_tts_${combo.encodingType}_${combo.sampleRate}.wav`);
    process.stdout.write(`  "${combo.label}" @ ${combo.sampleRate} Hz ... `);
    synthesizeWav(combo.label, combo.sampleRate, wavPath);
    const int16 = parseWav(wavPath);
    try { fs.unlinkSync(wavPath); } catch {}
    const audioData = encodeCombo(int16, combo.encodingType);
    const codecName = combo.encodingType === 1 ? 'µ-law' : combo.encodingType === 2 ? 'CVSD'
                    : combo.encodingType === 4 ? '16-bit PCM BE' : '8-bit unsigned';
    console.log(`${audioData.length} bytes  [${codecName} @ ${combo.sampleRate} Hz]`);
    encoded.push({ ...combo, audioData });
  }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise(r => sock.bind(r));
  sock.setBroadcast(true);

  console.log(`\nStreaming to ${HOST}:${PORT}  —  ${COMBOS.length} codecs × ${DWELL_MS / 1000}s each, looping`);
  console.log('Ctrl+C to stop.\n');

  let comboIdx   = 0;
  let pos        = 0;
  let tick       = 0;
  let comboStart = Date.now();

  const logCombo = (c) =>
    console.log(`▶  ${c.label}  (radioId ${c.radioId}, type ${c.encodingType}, ${c.sampleRate} Hz)`);
  logCombo(encoded[0]);

  setInterval(() => {
    if (Date.now() - comboStart >= DWELL_MS) {
      comboIdx   = (comboIdx + 1) % encoded.length;
      pos        = 0;
      comboStart = Date.now();
      logCombo(encoded[comboIdx]);
    }

    const { radioId, encodingType, sampleRate, audioData } = encoded[comboIdx];

    // Chunk = 110ms of audio (10% over-delivery absorbs Windows timer jitter).
    // CVSD: 1 bit/sample → sampleRate/8 bytes/sec.  Align to byte boundary.
    const bytesPerSample = encodingType === 4 ? 2 : encodingType === 2 ? 1 / 8 : 1;
    const chunkBytes = Math.round(sampleRate * bytesPerSample * 0.110);
    const aligned    = encodingType === 4 ? chunkBytes & ~1 : chunkBytes;

    let chunk;
    if (pos + aligned <= audioData.length) {
      chunk = audioData.slice(pos, pos + aligned);
      pos  += aligned;
      if (pos >= audioData.length) pos = 0;
    } else {
      const tail = audioData.slice(pos);
      const head = audioData.slice(0, aligned - tail.length);
      chunk = Buffer.concat([tail, head]);
      pos   = aligned - tail.length;
    }

    sock.send(makeSignalPdu(chunk, sampleRate, encodingType, radioId), PORT, HOST);
    if (tick++ % HZ === 0) sock.send(transmitterPdu(radioId), PORT, HOST);
  }, 1000 / HZ);

  process.on('SIGINT', () => { sock.close(); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
