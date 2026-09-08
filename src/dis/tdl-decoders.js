// TDL (Tactical Data Link) message decoders for DIS Signal PDU data payloads.
//
// The signal data field format is implementation-defined; these decoders use
// the most common formats found in DIS exercises. If your simulation uses
// different field offsets, adjust the OFFSETS constants below.
//
// Dispatcher: decodeTdlData(tdlType, dataBytes) → decoded object or null.

// ── Link-16 (JTIDS/MIDS) ── TDL type 8 ─────────────────────────────────────
// Header layout assumed (24 bytes), followed by 10-byte J-word records.
// Adjust if your simulation places fields at different offsets.
const L16 = {
  epochNumber:       { off: 0,  len: 2 },  // TDMA epoch (each 12.8 s)
  timeSlotNumber:    { off: 2,  len: 2 },  // slot within epoch (0-2047)
  netNumber:         { off: 4,  len: 1 },  // JTIDS net (0-127)
  // off 5: reserved / terminal type
  npgNumber:         { off: 6,  len: 2 },  // Network Participation Group
  ntpSeconds:        { off: 8,  len: 4 },  // NTP seconds (epoch 1900-01-01)
  ntpFraction:       { off: 12, len: 4 },  // NTP sub-second fraction
  messageSecurityId: { off: 16, len: 2 },
  transSecurityId:   { off: 18, len: 2 },
  numJWords:         { off: 20, len: 2 },
  messageTypeId:     { off: 22, len: 2 },  // high byte = J-series, low = number
  // off 24+: J-words (10 bytes each = 75 data bits + 5 padding bits)
};
const L16_JWORD_BYTES  = 10;
const L16_JWORD_OFFSET = 24;
const MAX_JWORDS = 64;

// Major J-series family names (series = high byte of messageTypeId)
const J_SERIES = {
  0: 'Network Management', 1: 'PPLI', 2: 'Surveillance', 3: 'Navigation',
  4: 'Grouping', 5: 'Position', 6: 'Electronic Warfare', 7: 'Intelligence',
  9: 'Weapons', 10: 'Weapons (cont)', 12: 'Mission Management',
  13: 'Platform Status', 14: 'Threat Warning', 15: 'Radar', 17: 'Air Control',
  22: 'Airspace Control', 28: 'EW Control', 29: 'EW', 31: 'SEI',
};

function r(buf, off, len) {
  if (off + len > buf.length) return null;
  if (len === 1) return buf.readUInt8(off);
  if (len === 2) return buf.readUInt16BE(off);
  if (len === 4) return buf.readUInt32BE(off);
  return null;
}

function decodeLink16(buf) {
  if (buf.length < 4) return null;
  const d = {};
  d.epochNumber       = r(buf, L16.epochNumber.off, 2);
  d.timeSlotNumber    = r(buf, L16.timeSlotNumber.off, 2);
  d.netNumber         = r(buf, L16.netNumber.off, 1);
  d.npgNumber         = r(buf, L16.npgNumber.off, 2);
  const ntpSec        = r(buf, L16.ntpSeconds.off, 4);
  if (ntpSec != null) {
    d.ntpSeconds = ntpSec;
    // NTP epoch is 1900-01-01; 2208988800 s offset to Unix epoch
    const unixMs = (ntpSec - 2208988800) * 1000;
    d.ntpTimestamp = unixMs > -2208988800000 ? new Date(unixMs).toISOString() : null;
  }
  d.messageSecurityId = r(buf, L16.messageSecurityId.off, 2);
  d.transSecurityId   = r(buf, L16.transSecurityId.off, 2);
  d.numJWords         = r(buf, L16.numJWords.off, 2);
  const msgType       = r(buf, L16.messageTypeId.off, 2);
  if (msgType != null) {
    const series = (msgType >> 8) & 0xFF;
    const num    = msgType & 0xFF;
    d.messageTypeId   = msgType;
    d.messageTypeName = `J${series}.${num}`;
    d.jSeriesName     = J_SERIES[series] || null;
  }
  if (d.numJWords > 0 && buf.length > L16_JWORD_OFFSET) {
    d.jWords = [];
    for (let i = 0; i < Math.min(d.numJWords, MAX_JWORDS); i++) {
      const s = L16_JWORD_OFFSET + i * L16_JWORD_BYTES;
      if (s + L16_JWORD_BYTES > buf.length) break;
      d.jWords.push(Array.from(buf.subarray(s, s + L16_JWORD_BYTES)));
    }
  }
  return d;
}

// ── Link-11A (TADIL A) / Link-11B ── TDL types 7 / 5 ───────────────────────
// Link-11 uses 24-bit data words. Simulation format varies; common layout:
//   off 0 (1 B): Network Control Unit ID
//   off 1 (1 B): Message indicator / type
//   off 2 (2 B): Frame count
//   off 4+ : frame data words (3 bytes each)
function decodeLink11(buf) {
  if (buf.length < 2) return null;
  const d = {};
  d.networkUnitId    = r(buf, 0, 1);
  d.messageIndicator = r(buf, 1, 1);
  if (buf.length >= 4) d.frameCount = r(buf, 2, 2);
  const frameWords = Math.floor(Math.max(0, buf.length - 4) / 3);
  if (frameWords > 0) {
    d.frameWordCount = frameWords;
    d.frameWords = [];
    for (let i = 0; i < Math.min(frameWords, 32); i++) {
      const s = 4 + i * 3;
      if (s + 3 > buf.length) break;
      d.frameWords.push(Array.from(buf.subarray(s, s + 3)));
    }
  }
  return d;
}

// ── SADL ── TDL type 6 ───────────────────────────────────────────────────────
// Situational Awareness Data Link — A-10 subset of J-series.
// Same general format as Link-16 but shorter header; treat first 8 bytes as:
//   off 0 (2 B): Frame number
//   off 2 (2 B): Message type ID (J{hi}.{lo})
//   off 4 (2 B): Net number
//   off 6 (2 B): Number of words
function decodeSADL(buf) {
  if (buf.length < 2) return null;
  const d = {};
  d.frameNumber = r(buf, 0, 2);
  const msgType = r(buf, 2, 2);
  if (msgType != null) {
    d.messageTypeId   = msgType;
    d.messageTypeName = `J${(msgType >> 8) & 0xFF}.${msgType & 0xFF}`;
  }
  if (buf.length >= 6) d.netNumber  = r(buf, 4, 2);
  if (buf.length >= 8) d.wordCount  = r(buf, 6, 2);
  return d;
}

// ── NATO Link-1 (PADIL) ── TDL type 2 ───────────────────────────────────────
// 11-bit words in a specific frame structure; simulation encoding varies.
// Shows basic frame byte count only; extend when format is known.
function decodeNATOLink1(buf) {
  if (!buf.length) return null;
  return { byteCount: buf.length };
}

// ── ATDL-1 ── TDL type 3 ─────────────────────────────────────────────────────
function decodeATDL1(buf) {
  if (!buf.length) return null;
  return { byteCount: buf.length };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
const TDL_DECODERS = new Map([
  [2,   decodeNATOLink1],  // NATO Link-1
  [3,   decodeATDL1],      // ATDL-1
  [5,   decodeLink11],     // Link-11B
  [6,   decodeSADL],       // SADL
  [7,   decodeLink11],     // Link-11A
  [8,   decodeLink16],     // Link-16 (JTIDS/MIDS/TADIL-J)
  [100, decodeLink16],     // Link-16 (sim-specific type 100 alias)
]);

// Decode TDL-specific fields from raw Signal PDU data bytes.
// Returns a structured object or null if no decoder for this TDL type.
export function decodeTdlData(tdlType, data) {
  const fn = TDL_DECODERS.get(tdlType);
  if (!fn || !data || !data.length) return null;
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return fn(buf);
  } catch {
    return null;
  }
}
