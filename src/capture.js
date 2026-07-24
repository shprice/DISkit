// UDP capture: listens on a unicast or multicast port, parses each datagram as
// a DIS PDU, feeds the stats aggregator, and (when recording) writes matching
// PDUs to a binary log. Record filtering is an allow-list of PDU type numbers;
// an empty list records everything.

import dgram from 'dgram';
import path from 'path';
import { parseHeader } from './dis/pdu.js';
import { decodeBody } from './dis/decoders.js';
import { LogWriter, writeMeta } from './logformat.js';

export class Capture {
  constructor(opts, hooks = {}) {
    this.opts = opts;               // { port, multicastGroup?, bindAddress? }
    this.stats = hooks.stats;
    this.onError = hooks.onError || (() => {});
    this.onSample = hooks.onSample || (() => {}); // throttled live PDU samples
    this.socket = null;
    this.running = false;
    this.recorder = null;              // LogWriter
    this.recordFilter = new Set();     // allow-list by PDU type; empty = all
    this.versionFilter = new Set();    // allow-list by protocol version; empty = all
    this.recordPath = null;
    this.captureStartHr = 0n;
    this.recordedCount = 0;
    this.bookmarks = [];            // [{ offsetMicros, label }] for the active recording
    this._lastSample = 0;
  }

  // Current position (microseconds) within the active recording.
  currentOffsetMicros() {
    if (!this.recorder) return 0;
    return Number(process.hrtime.bigint() - this.captureStartHr) / 1000;
  }

  // Tag the current recording position with a label. No-op if not recording.
  addBookmark(label) {
    if (!this.recorder) return null;
    const bm = {
      offsetMicros: this.currentOffsetMicros(),
      label: String(label || '').slice(0, 200) || 'bookmark',
    };
    this.bookmarks.push(bm);
    return bm;
  }

  start() {
    if (this.running) return;
    const { port, multicastGroup, bindAddress } = this.opts;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => this.onError(err));
    socket.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));

    socket.bind(port, multicastGroup ? undefined : bindAddress, () => {
      try {
        socket.setBroadcast(true);
        if (multicastGroup) {
          socket.addMembership(multicastGroup, bindAddress || undefined);
          socket.setMulticastLoopback(true);
        }
      } catch (err) {
        this.onError(err);
      }
    });
    this.running = true;
    this.captureStartHr = process.hrtime.bigint();
  }

  _onMessage(msg, rinfo) {
    const header = parseHeader(msg);
    if (!header) return;
    const body = decodeBody(header.pduType, msg);
    if (this.stats) this.stats.ingest(header, body, msg.length);

    if (this.recorder) {
      const allowed =
        (this.recordFilter.size === 0 || this.recordFilter.has(header.pduType)) &&
        (this.versionFilter.size === 0 || this.versionFilter.has(header.protocolVersion));
      if (allowed) {
        const offsetMicros = Number(process.hrtime.bigint() - this.captureStartHr) / 1000;
        this.recorder.write(offsetMicros, rinfo.port || this.opts.port, msg);
        this.recordedCount += 1;
      }
    }

    // Throttle live samples to ~20/s to avoid flooding the UI socket.
    const now = Date.now();
    if (now - this._lastSample > 50) {
      this._lastSample = now;
      this.onSample({ header, body });
    }
  }

  setRecordFilter(types) {
    this.recordFilter = new Set((types || []).map(Number));
  }

  setVersionFilter(versions) {
    this.versionFilter = new Set((versions || []).map(Number));
  }

  startRecording(filePath, filterTypes, versionFilter) {
    if (this.recorder) this.stopRecording();
    this.setRecordFilter(filterTypes);
    this.setVersionFilter(versionFilter);
    this.recorder = new LogWriter(filePath, Date.now());
    this.recordPath = filePath;
    this.captureStartHr = process.hrtime.bigint();
    this.recordedCount = 0;
    this.bookmarks = [];
    this.recordStartMs = Date.now();
    return filePath;
  }

  stopRecording() {
    if (!this.recorder) return null;
    const r = this.recorder;
    r.close();
    const meta = {
      file: path.basename(this.recordPath),
      formatVersion: 1,
      startTime: new Date(this.recordStartMs).toISOString(),
      durationMs: Date.now() - this.recordStartMs,
      records: r.records,
      bytes: r.bytes,
      port: this.opts.port,
      multicastGroup: this.opts.multicastGroup || null,
      recordFilter: Array.from(this.recordFilter),
      versionFilter: Array.from(this.versionFilter),
      typeCounts: this.stats ? this.stats.typeCounts : {},
      bookmarks: this.bookmarks.slice(),
    };
    writeMeta(this.recordPath, meta);
    this.recorder = null;
    const result = { ...meta, path: this.recordPath };
    this.recordPath = null;
    return result;
  }

  stop() {
    this.stopRecording();
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.running = false;
  }
}
