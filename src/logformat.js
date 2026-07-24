// Compact binary log format for recorded DIS traffic.
//
// File layout:
//   [32-byte file header]
//     0..7   magic            "DISLOG01"
//     8..9   format version   uint16 (=1)
//     10..15 reserved
//     16..23 start wall clock  uint64  (ms since epoch)
//     24..31 reserved
//   [records...]  each:
//     0..7   offset            uint64  (microseconds since start)
//     8..9   source port       uint16
//     10..11 pdu length        uint16
//     12..   pdu bytes
//
// A sidecar "<file>.meta.json" stores the capture config, duration and PDU
// type counts so summaries can be shown without scanning the whole file.

import fs from 'fs';

const MAGIC = 'DISLOG01';
const FILE_HEADER_LEN = 32;
const REC_HEADER_LEN = 12;
export const FORMAT_VERSION = 1;

export class LogWriter {
  constructor(path, startWallClockMs = Date.now()) {
    this.path = path;
    this.startWallClockMs = startWallClockMs;
    this.fd = fs.openSync(path, 'w');
    this.records = 0;
    this.bytes = 0;
    this.lastOffsetMicros = 0;
    const head = Buffer.alloc(FILE_HEADER_LEN);
    head.write(MAGIC, 0, 'ascii');
    head.writeUInt16LE(FORMAT_VERSION, 8);
    head.writeBigUInt64LE(BigInt(startWallClockMs), 16);
    fs.writeSync(this.fd, head);
  }

  // offsetMicros: microseconds since capture start. pdu: Buffer.
  write(offsetMicros, port, pdu) {
    const rec = Buffer.alloc(REC_HEADER_LEN);
    rec.writeBigUInt64LE(BigInt(Math.max(0, Math.round(offsetMicros))), 0);
    rec.writeUInt16LE(port & 0xffff, 8);
    rec.writeUInt16LE(pdu.length & 0xffff, 10);
    fs.writeSync(this.fd, rec);
    fs.writeSync(this.fd, pdu);
    this.records += 1;
    this.bytes += REC_HEADER_LEN + pdu.length;
    this.lastOffsetMicros = offsetMicros;
  }

  close() {
    if (this.fd != null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}

export function writeMeta(path, meta) {
  fs.writeFileSync(`${path}.meta.json`, JSON.stringify(meta, null, 2));
}

export function readMeta(path) {
  try {
    return JSON.parse(fs.readFileSync(`${path}.meta.json`, 'utf8'));
  } catch {
    return null;
  }
}

// Streaming reader. Reads records sequentially on demand so large files don't
// have to be held in memory. Call reset() to rewind for looping.
export class LogReader {
  constructor(path) {
    this.path = path;
    this.fd = fs.openSync(path, 'r');
    const head = Buffer.alloc(FILE_HEADER_LEN);
    fs.readSync(this.fd, head, 0, FILE_HEADER_LEN, 0);
    if (head.toString('ascii', 0, 8) !== MAGIC) {
      this.close();
      throw new Error('Not a DISLOG file (bad magic)');
    }
    this.version = head.readUInt16LE(8);
    this.startWallClockMs = Number(head.readBigUInt64LE(16));
    this.pos = FILE_HEADER_LEN;
    this.size = fs.fstatSync(this.fd).size;
  }

  // Returns { offsetMicros, port, pdu } or null at end of file.
  readNext() {
    if (this.pos + REC_HEADER_LEN > this.size) return null;
    const rec = Buffer.alloc(REC_HEADER_LEN);
    fs.readSync(this.fd, rec, 0, REC_HEADER_LEN, this.pos);
    const offsetMicros = Number(rec.readBigUInt64LE(0));
    const port = rec.readUInt16LE(8);
    const len = rec.readUInt16LE(10);
    const bodyPos = this.pos + REC_HEADER_LEN;
    if (bodyPos + len > this.size) return null;
    const pdu = Buffer.alloc(len);
    fs.readSync(this.fd, pdu, 0, len, bodyPos);
    this.pos = bodyPos + len;
    return { offsetMicros, port, pdu };
  }

  reset() {
    this.pos = FILE_HEADER_LEN;
  }

  close() {
    if (this.fd != null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
