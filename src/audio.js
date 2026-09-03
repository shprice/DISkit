// Server-side DIS Signal PDU audio decode. Converts payload bytes to 16-bit LE PCM.
// Supported encodingClass=0 types: 1=µ-law, 2=CVSD, 4=16-bit PCM BE, 5=8-bit unsigned PCM

// ITU-T G.711 µ-law decode: segment offsets for exponents 0–7
const MULAW_EXP_LUT = [0, 132, 396, 924, 1980, 4092, 8316, 16764];
const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const b = ~i & 0xFF;
    const sign = b & 0x80;
    const exp  = (b >> 4) & 0x07;
    const mant = b & 0x0F;
    const val  = MULAW_EXP_LUT[exp] + (mant << (exp + 3));
    t[i] = sign ? -val : val;
  }
  return t;
})();

// CVSD decode state shared across calls — one decoder per audio key.
// The Map is keyed by the same "entityId|radioId" key used elsewhere in the server.
const _cvsdState = new Map();

function _cvsdDecodeChunk(data, key) {
  let s = _cvsdState.get(key);
  if (!s) { s = { acc: 0, delta: 10 / 32768 }; _cvsdState.set(key, s); }

  const DELTA_MIN = 10 / 32768;
  const DELTA_MAX = 1280 / 32768;
  const STEP_UP   = 2.0;
  const STEP_DOWN = 0.80;
  const RUN_MASK  = 0x07; // 3-bit run-length history
  const LEAK      = 0.9997;

  const numBits = data.length * 8;
  const out = Buffer.allocUnsafe(numBits * 2);

  let { acc, delta } = s;
  let history = 0;

  for (let i = 0; i < numBits; i++) {
    const bit = (data[i >> 3] >> (7 - (i & 7))) & 1;
    history = ((history << 1) | bit) & RUN_MASK;
    delta = (history === 0 || history === RUN_MASK)
      ? Math.min(delta * STEP_UP,   DELTA_MAX)
      : Math.max(delta * STEP_DOWN, DELTA_MIN);
    acc = acc * LEAK + (bit ? delta : -delta);
    out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(acc * 32767))), i * 2);
  }

  s.acc   = acc;
  s.delta = delta;
  return out;
}

export function decodeAudioPayload(encodingClass, encodingType, data, key) {
  if (encodingClass !== 0 || !data || data.length === 0) return null;
  if (encodingType === 1) {
    const out = Buffer.allocUnsafe(data.length * 2);
    for (let i = 0; i < data.length; i++) out.writeInt16LE(MULAW_TABLE[data[i] & 0xFF], i * 2);
    return out;
  }
  if (encodingType === 2) {
    return _cvsdDecodeChunk(data, key ?? 'default');
  }
  if (encodingType === 4) {
    const out = Buffer.allocUnsafe(data.length & ~1);
    for (let i = 0; i < out.length; i += 2) out.writeInt16LE(data.readInt16BE(i), i);
    return out;
  }
  if (encodingType === 5) {
    const out = Buffer.allocUnsafe(data.length * 2);
    for (let i = 0; i < data.length; i++) out.writeInt16LE((data[i] - 128) * 256, i * 2);
    return out;
  }
  return null;
}
