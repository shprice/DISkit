import { decodeAudioPayload } from '../src/audio.js';
import { PDU_DECODERS } from '../src/dis/decoders.js';

let passed = 0, failed = 0;
function check(label, cond, info = '') {
  if (cond) { console.log(`  PASS  ${label}${info ? '  ' + info : ''}`); passed++; }
  else       { console.error(`  FAIL  ${label}${info ? '  ' + info : ''}`); failed++; }
}

function linearToMulaw(s) {
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  s = Math.min(s, 32767) + 33;
  let exp = 7, mask = 0x4000;
  while (exp > 0 && !(s & mask)) { exp--; mask >>= 1; }
  return (~(sign | (exp << 4) | (s >> (exp + 1) & 0x0F))) & 0xFF;
}

const N = 160, SR = 8000, FREQ = 440;
const origSamples = Array.from({length: N}, (_, i) =>
  Math.round(Math.sin(2 * Math.PI * FREQ * i / SR) * 16000));

// ── µ-law encode + decode round-trip ────────────────────────────────────────
const mulawBuf = Buffer.from(origSamples.map(linearToMulaw));
const pcm1 = decodeAudioPayload(0, 1, mulawBuf);
check('decodeAudioPayload returns Buffer for µ-law', Buffer.isBuffer(pcm1));
check('µ-law output length = 2× input', pcm1?.length === N * 2, `(${pcm1?.length})`);
const signErrors = origSamples.filter((v, i) =>
  Math.abs(v) > 1000 && Math.sign(pcm1.readInt16LE(i*2)) !== Math.sign(v)).length;
check('µ-law sign preserved', signErrors === 0, `(${signErrors} errors)`);

// ── 16-bit PCM big-endian → little-endian ────────────────────────────────────
const pcmBeBuf = Buffer.alloc(N * 2);
origSamples.forEach((v, i) => pcmBeBuf.writeInt16BE(v, i * 2));
const pcm4 = decodeAudioPayload(0, 4, pcmBeBuf);
const pcm4Errors = origSamples.filter((v, i) => pcm4?.readInt16LE(i*2) !== v).length;
check('16-bit PCM BE→LE round-trip', pcm4Errors === 0, `(${pcm4Errors} errors)`);

// ── 8-bit unsigned PCM ───────────────────────────────────────────────────────
const u8Buf = Buffer.from(origSamples.map(v => Math.max(0, Math.min(255, Math.round(v/256+128)))));
const pcm5 = decodeAudioPayload(0, 5, u8Buf);
check('8-bit unsigned PCM output length', pcm5?.length === N * 2, `(${pcm5?.length})`);

// ── Edge cases ───────────────────────────────────────────────────────────────
check('Unsupported encoding type returns null', decodeAudioPayload(0, 99, mulawBuf) === null);
check('Non-audio encoding class returns null',  decodeAudioPayload(1, 1, mulawBuf) === null);
check('Empty buffer returns null',              decodeAudioPayload(0, 1, Buffer.alloc(0)) === null);

// ── Full PDU decode: audioData extraction ───────────────────────────────────
const pduLen = 32 + N;
const pdu = Buffer.alloc(pduLen);
pdu.writeUInt8(7,0); pdu.writeUInt8(1,1); pdu.writeUInt8(26,2); pdu.writeUInt8(4,3);
pdu.writeUInt32BE(0,4); pdu.writeUInt16BE(pduLen,8);
let o = 12;
pdu.writeUInt16BE(17,o); pdu.writeUInt16BE(1,o+2); pdu.writeUInt16BE(100,o+4); o+=6;
pdu.writeUInt16BE(1,o); o+=2;
pdu.writeUInt16BE((0<<14)|1,o); o+=2; // class=0, type=1 µ-law
pdu.writeUInt16BE(0,o); o+=2;
pdu.writeUInt32BE(SR,o); o+=4;
pdu.writeUInt16BE(N*8,o); o+=2;
pdu.writeUInt16BE(N,o); o+=2;
mulawBuf.copy(pdu, o);

const sig = PDU_DECODERS.get(26)(pdu);
check('decodeSignal extracts audioData', sig.audioData?.length === N, `(${sig.audioData?.length}B)`);
check('decodeSignal encodingClass=0',   sig.encodingClass === 0);
check('decodeSignal encodingType=1',    sig.encodingType === 1);
check('decodeSignal sampleRate=8000',   sig.sampleRate === 8000);

const pcmFromPdu = decodeAudioPayload(sig.encodingClass, sig.encodingType, sig.audioData);
check('Full pipeline: PDU → decode → PCM', pcmFromPdu?.length === N*2, `(${pcmFromPdu?.length}B PCM)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
