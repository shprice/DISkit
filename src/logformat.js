// Compact binary log format for recorded DIS traffic, packaged as a ZIP
// container so the binary data and JSON metadata travel as a single file.
//
// ZIP container entries:
//   capture.bin   — raw binary stream (DISLOG01 format below)
//   meta.json     — capture config, duration, type counts, bookmarks
//
// capture.bin layout:
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
// Legacy files: a plain binary .dislog + sidecar .dislog.meta.json are still
// read transparently — the reader detects the format from magic bytes.

import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import pathModule from 'path';
import AdmZip from 'adm-zip';

const MAGIC = 'DISLOG01';
const FILE_HEADER_LEN = 32;
const REC_HEADER_LEN = 12;
export const FORMAT_VERSION = 1;

function peekMagic(path) {
  try {
    const buf = Buffer.alloc(2);
    const fd = fs.openSync(path, 'r');
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    return buf;
  } catch { return Buffer.alloc(2); }
}

function isZip(path) {
  const m = peekMagic(path);
  return m[0] === 0x50 && m[1] === 0x4B; // 'PK'
}

// --- Write -------------------------------------------------------------------

// During capture, records stream to a plain binary temp file (.dislog.bin).
// On stopRecording(), sealZipLog() packages it into the final .dislog ZIP.
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

// Package the temp binary + meta into a ZIP at outputPath, then delete binPath.
export function sealZipLog(binPath, metaObj, outputPath) {
  const zip = new AdmZip();
  zip.addLocalFile(binPath, '', 'capture.bin');
  zip.addFile('meta.json', Buffer.from(JSON.stringify(metaObj, null, 2)));
  zip.writeZip(outputPath);
  fs.unlinkSync(binPath);
}

// Legacy helper kept for any code that writes the old two-file format.
export function writeMeta(path, meta) {
  fs.writeFileSync(`${path}.meta.json`, JSON.stringify(meta, null, 2));
}

export function updateMeta(logPath, updateFn) {
  try {
    if (isZip(logPath)) {
      const zip = new AdmZip(logPath);
      const entry = zip.getEntry('meta.json');
      let metaObj = entry ? JSON.parse(entry.getData().toString('utf8')) : {};
      metaObj = updateFn(metaObj) || metaObj;
      zip.addFile('meta.json', Buffer.from(JSON.stringify(metaObj, null, 2)));
      zip.writeZip(logPath);
      return metaObj;
    }
    const sidecar = `${logPath}.meta.json`;
    let metaObj = {};
    try { metaObj = JSON.parse(fs.readFileSync(sidecar, 'utf8')); } catch {}
    metaObj = updateFn(metaObj) || metaObj;
    fs.writeFileSync(sidecar, JSON.stringify(metaObj, null, 2));
    return metaObj;
  } catch { return null; }
}

// --- Read --------------------------------------------------------------------

export function readMeta(path) {
  try {
    if (isZip(path)) {
      const zip = new AdmZip(path);
      const entry = zip.getEntry('meta.json');
      return entry ? JSON.parse(entry.getData().toString('utf8')) : null;
    }
    // Legacy: sidecar .meta.json
    return JSON.parse(fs.readFileSync(`${path}.meta.json`, 'utf8'));
  } catch { return null; }
}

// Streaming reader. Handles both ZIP containers and legacy plain binary files.
// For ZIP files a temporary extraction is used so the existing seek-based read
// logic works unchanged; the temp file is cleaned up on close().
export class LogReader {
  constructor(filePath) {
    this.path = filePath;
    this.tmpPath = null;

    let binPath = filePath;
    if (isZip(filePath)) {
      const zip = new AdmZip(filePath);
      const entry = zip.getEntry('capture.bin');
      if (!entry) throw new Error('Not a valid DISLOG container (missing capture.bin)');
      const tmpName = `dislog-${crypto.randomBytes(6).toString('hex')}.tmp`;
      this.tmpPath = pathModule.join(os.tmpdir(), tmpName);
      fs.writeFileSync(this.tmpPath, entry.getData());
      binPath = this.tmpPath;
    }

    this.fd = fs.openSync(binPath, 'r');
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
    if (this.tmpPath) {
      try { fs.unlinkSync(this.tmpPath); } catch {}
      this.tmpPath = null;
    }
  }
}
