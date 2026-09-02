// Server-side DIS Signal PDU audio decode. Converts payload bytes to 16-bit LE PCM.
// Supported encodingClass=0 types: 1=µ-law, 4=16-bit PCM BE, 5=8-bit unsigned PCM

const MULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const b = ~i & 0xFF;
    const sign = b & 0x80;
    const exp  = (b >> 4) & 0x07;
    const mant = b & 0x0F;
    let val = ((mant << 1) + 33) << exp;
    val -= 33;
    t[i] = sign ? -val : val;
  }
  return t;
})();

export function decodeAudioPayload(encodingClass, encodingType, data) {
  if (encodingClass !== 0 || !data || data.length === 0) return null;
  if (encodingType === 1) {
    const out = Buffer.allocUnsafe(data.length * 2);
    for (let i = 0; i < data.length; i++) out.writeInt16LE(MULAW_TABLE[data[i] & 0xFF], i * 2);
    return out;
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
