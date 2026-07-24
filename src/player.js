// Replay engine. Streams a DISLOG file back onto the network over UDP at a
// configurable speed multiplier, with optional continuous looping and an
// allow-list type filter. Records are dispatched on wall-clock timing scaled
// by `speed`; bursts due at the same instant are flushed together so high
// multipliers (10x, 100x, ...) stay accurate without one-timer-per-PDU drift.

import dgram from 'dgram';
import { LogReader, readMeta } from './logformat.js';
import { parseHeader } from './dis/pdu.js';
import { decodeBody } from './dis/decoders.js';
import { PduMinVersion } from './dis/enums.js';

export class Player {
  constructor(opts, hooks = {}) {
    this.opts = opts;               // { destAddress, destPort, multicast?, ttl? }
    this.stats = hooks.stats;
    this.onSample = hooks.onSample || (() => {});
    this.onProgress = hooks.onProgress || (() => {});
    this.onEnd = hooks.onEnd || (() => {});
    this.onError = hooks.onError || (() => {});
    this.onVersionWarning = hooks.onVersionWarning || (() => {});
    this.reader = null;
    this.socket = null;
    this.timer = null;
    this.state = 'idle';            // idle | playing | paused | stopped
    this.speed = 1;
    this.loop = false;
    this.typeFilter = new Set();
    this.versionFilter = new Set();
    this.replayAsVersion = null;    // null = send as-is; number = rewrite version byte
    this.meta = null;
    this.sentCount = 0;
    this.loops = 0;
    this.versionWarnings = 0;
    this._warnedTypes = new Set();
    this._next = null;              // pre-read upcoming record
    this._lastSample = 0;
  }

  load(logPath) {
    this.stop();
    this.logPath = logPath;
    this.meta = readMeta(logPath);
    this.reader = new LogReader(logPath);
    this.totalMicros = this.meta ? this.meta.durationMs * 1000 : 0;
    return this.meta;
  }

  play({ speed = 1, loop = false, typeFilter = [], versionFilter = [], replayAsVersion = null } = {}) {
    if (!this.reader) throw new Error('No log loaded');
    this.speed = Math.max(0.01, speed);
    this.loop = !!loop;
    this.typeFilter = new Set((typeFilter || []).map(Number));
    this.versionFilter = new Set((versionFilter || []).map(Number));
    this.replayAsVersion = replayAsVersion || null;
    this.versionWarnings = 0;
    this._warnedTypes = new Set();

    if (!this.socket) {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket.bind(() => {
        try {
          this.socket.setBroadcast(true);
          if (this.opts.multicast) {
            this.socket.setMulticastTTL(this.opts.ttl || 16);
            this.socket.setMulticastLoopback(true);
          }
        } catch (err) { this.onError(err); }
      });
    }

    this.reader.reset();
    this._next = this.reader.readNext();
    this.baseOffsetMicros = this._next ? this._next.offsetMicros : 0;
    this.playbackStartMs = Date.now();
    this.state = 'playing';
    this._pump();
  }

  _scaledElapsedMicros() {
    return (Date.now() - this.playbackStartMs) * 1000 * this.speed;
  }

  _pump() {
    if (this.state !== 'playing') return;
    const dueMicros = this._scaledElapsedMicros();

    // Flush every record whose scheduled time has arrived.
    while (this._next && (this._next.offsetMicros - this.baseOffsetMicros) <= dueMicros) {
      this._send(this._next);
      this._next = this.reader.readNext();
    }

    if (!this._next) {
      this._finishPass();
      return;
    }

    // Schedule the next wake-up at the next record's due time.
    const aheadMicros = (this._next.offsetMicros - this.baseOffsetMicros) - this._scaledElapsedMicros();
    const delayMs = Math.max(0, aheadMicros / 1000 / this.speed);
    this.timer = setTimeout(() => this._pump(), delayMs);
  }

  _send(rec) {
    const header = parseHeader(rec.pdu);
    if (!header) return;
    if (this.typeFilter.size && !this.typeFilter.has(header.pduType)) return;
    if (this.versionFilter.size && !this.versionFilter.has(header.protocolVersion)) return;

    let pdu = rec.pdu;
    if (this.replayAsVersion !== null && header.protocolVersion !== this.replayAsVersion) {
      pdu = Buffer.from(rec.pdu);
      pdu.writeUInt8(this.replayAsVersion, 0);
      // pduStatus (byte 10) was introduced in DIS 6; zero it when downgrading to v5 or earlier
      if (this.replayAsVersion <= 5 && header.protocolVersion >= 6) {
        pdu.writeUInt8(0, 10);
      }
      // Warn once per PDU type that is not defined in the target version
      const minVer = PduMinVersion[header.pduType];
      if (minVer && this.replayAsVersion < minVer && !this._warnedTypes.has(header.pduType)) {
        this._warnedTypes.add(header.pduType);
        this.versionWarnings += 1;
        this.onVersionWarning({
          pduType: header.pduType,
          pduTypeName: header.pduTypeName,
          targetVersion: this.replayAsVersion,
          minVersion: minVer,
        });
      }
    }

    this.socket.send(pdu, this.opts.destPort, this.opts.destAddress, (err) => {
      if (err) this.onError(err);
    });
    this.sentCount += 1;

    const body = decodeBody(header.pduType, rec.pdu);
    if (this.stats) this.stats.ingest(header, body, rec.pdu.length);

    const now = Date.now();
    if (now - this._lastSample > 50) {
      this._lastSample = now;
      this.onSample({ header, body });
    }
    this.onProgress(this._progress());
  }

  _progress() {
    const playedMicros = Math.min(this._scaledElapsedMicros(), this.totalMicros || Infinity);
    return {
      state: this.state,
      sentCount: this.sentCount,
      loops: this.loops,
      speed: this.speed,
      loop: this.loop,
      positionMs: Math.round(playedMicros / 1000),
      durationMs: this.meta ? this.meta.durationMs : 0,
      replayAsVersion: this.replayAsVersion,
      versionWarnings: this.versionWarnings,
    };
  }

  _finishPass() {
    this.loops += 1;
    if (this.loop) {
      this.reader.reset();
      this._next = this.reader.readNext();
      this.baseOffsetMicros = this._next ? this._next.offsetMicros : 0;
      this.playbackStartMs = Date.now();
      this._pump();
    } else {
      this.state = 'stopped';
      this.onProgress(this._progress());
      this.onEnd({ sentCount: this.sentCount, loops: this.loops });
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    clearTimeout(this.timer);
    this.timer = null;
    // Freeze elapsed time by recording how far we've played.
    this._pausedAtMicros = this._scaledElapsedMicros();
    this.state = 'paused';
    this.onProgress(this._progress());
  }

  // Jump playback to an absolute offset (microseconds from start of file).
  // Records before the target are skipped without being sent. Keeps the
  // current play/pause state.
  seek(targetOffsetMicros) {
    if (!this.reader) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const target = Math.max(0, targetOffsetMicros || 0);
    this.reader.reset();
    if (this.baseOffsetMicros == null) {
      const first = this.reader.readNext();
      this.baseOffsetMicros = first ? first.offsetMicros : 0;
      this.reader.reset();
    }
    let rec = this.reader.readNext();
    while (rec && rec.offsetMicros < target) rec = this.reader.readNext();
    this._next = rec;
    const scaled = target - this.baseOffsetMicros;
    this.playbackStartMs = Date.now() - (scaled / 1000 / this.speed);
    if (this.state === 'playing') {
      this._pump();
    } else {
      this.state = 'paused';
      this._pausedAtMicros = scaled;
      this.onProgress(this._progress());
    }
  }

  resume() {
    if (this.state !== 'paused') return;
    // Rebase playback start so elapsed continues from the paused position.
    this.playbackStartMs = Date.now() - (this._pausedAtMicros / 1000 / this.speed);
    this.state = 'playing';
    this._pump();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.state = 'stopped';
    if (this.reader) this.reader.reset();
    this._next = null;
    this.onProgress(this._progress());
  }

  dispose() {
    this.stop();
    if (this.reader) { this.reader.close(); this.reader = null; }
    if (this.socket) { try { this.socket.close(); } catch { /* noop */ } this.socket = null; }
    this.state = 'idle';
  }
}
