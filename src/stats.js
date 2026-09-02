// Rolling aggregation of decoded PDUs for the live UI. Tracks per-type counts,
// a live entity table (with positions for the map), and active emitters.
// Entities/emitters that stop transmitting are aged out.

import { pduTypeName } from './dis/enums.js';

const EMITTER_TTL_MS = 15000;
const SIGNAL_TTL_MS  = 30000;

export class Stats {
  constructor({ entityTimeoutSecs = 5 } = {}) {
    this.entityTtlMs = Math.max(entityTimeoutSecs * 1000 * 3, 12000); // 3× timeout, min 12 s
    this.reset();
  }

  reset() {
    this.typeCounts = {};       // pduType -> count
    this.familyCounts = {};     // familyName -> count
    this.siteCounts = {};       // site ID -> count
    this.appCounts = {};        // application ID -> count
    this.totalPdus = 0;
    this.totalBytes = 0;
    this.entities = new Map();      // key -> entity record
    this.emitters = new Map();      // emittingKey -> { systems, lastSeen }
    this.fires = [];                // rolling log of last 200 Fire events
    this.detonations = [];          // rolling log of last 200 Detonation events
    this.transmitters = new Map();  // entityKey|radioId -> transmitter record
    this.signalStates = new Map();  // entityKey|radioId -> latest signal state
    this.startTime = Date.now();
    this.rateWindow = [];           // timestamps (ms) for PDU/s estimate
    this.byteRateWindow = [];       // {t, b} pairs for MB/s estimate
  }

  // header: parsed common header. body: decoded body (may be null).
  ingest(header, body, byteLen, rawBuf) {
    const now = Date.now();
    this.totalPdus += 1;
    this.totalBytes += byteLen || 0;
    this.typeCounts[header.pduType] = (this.typeCounts[header.pduType] || 0) + 1;
    this.familyCounts[header.protocolFamilyName] =
      (this.familyCounts[header.protocolFamilyName] || 0) + 1;
    if (rawBuf && rawBuf.length >= 18) {
      const site = rawBuf.readUInt16BE(12);
      const app  = rawBuf.readUInt16BE(14);
      this.siteCounts[site] = (this.siteCounts[site] || 0) + 1;
      this.appCounts[app]   = (this.appCounts[app]   || 0) + 1;
    }

    this.rateWindow.push(now);
    if (this.rateWindow.length > 2000) this.rateWindow.shift();
    this.byteRateWindow.push({ t: now, b: byteLen || 0 });
    if (this.byteRateWindow.length > 5000) this.byteRateWindow.shift();

    if (header.pduType === 1 && body && body.entityIdKey) {
      this.entities.set(body.entityIdKey, {
        key: body.entityIdKey,
        marking: body.marking || body.entityIdKey,
        siteId: body.entityId?.site,
        appId: body.entityId?.application,
        force: body.forceName,
        forceId: body.forceId,
        type: body.entityTypeString,
        kind: body.entityType?.kindName,
        domain: body.entityType?.domainName,
        lat: body.geo?.lat,
        lon: body.geo?.lon,
        alt: body.geo?.alt,
        heading: body.headingDeg,
        speed: body.speed,
        velocity: body.velocity,
        orientation: body.orientation,
        appearance: body.appearance,
        capabilities: body.capabilities,
        location: body.location,
        drAlgorithm: body.drAlgorithm,
        drLinearAcceleration: body.drLinearAcceleration,
        drAngularVelocity: body.drAngularVelocity,
        markingCharset: body.markingCharset,
        articulationParams: body.articulationParams,
        lastSeen: now,
      });
    }

    if (header.pduType === 2 && body && body.firingKey) {
      this.fires.unshift({
        ts: now,
        firingKey: body.firingKey,
        targetKey: body.targetKey,
        munitionType: body.munitionTypeString,
        range: body.range,
        geo: body.geo,
      });
      if (this.fires.length > 200) this.fires.pop();
    }

    if (header.pduType === 3 && body && body.firingKey) {
      this.detonations.unshift({
        ts: now,
        firingKey: body.firingKey,
        targetKey: body.targetKey,
        munitionType: body.munitionTypeString,
        result: body.resultName,
        geo: body.geo,
      });
      if (this.detonations.length > 200) this.detonations.pop();
    }

    if (header.pduType === 23 && body && body.emittingKey) {
      this.emitters.set(body.emittingKey, {
        key: body.emittingKey,
        stateUpdateIndicator: body.stateUpdateIndicator,
        numSystems: body.numSystems,
        systems: body.systems,
        lastSeen: now,
      });
    }

    if (header.pduType === 25 && body && body.entityIdKey) {
      const key = `${body.entityIdKey}|${body.radioId}`;
      this.transmitters.set(key, {
        _key: key,
        entityKey: body.entityIdKey,
        radioId: body.radioId,
        txState: body.txState,
        txStateName: body.txState === 2 ? 'Transmitting' : body.txState === 1 ? 'On (idle)' : 'Off',
        frequency: body.frequency,
        freqMHz: body.frequency ? +(body.frequency / 1e6).toFixed(3) : 0,
        band: body.band,
        power: body.power ? +body.power.toFixed(1) : 0,
        geo: body.geo,
        lastSeen: now,
      });
    }

    if (header.pduType === 26 && body && body.entityIdKey) {
      const key = body._key || `${body.entityIdKey}|${body.radioId}`;
      this.signalStates.set(key, { ...body, lastSeen: now });
    }
  }

  ageOut() {
    const now = Date.now();
    for (const [k, e] of this.entities) {
      if (now - e.lastSeen > this.entityTtlMs) this.entities.delete(k);
    }
    for (const [k, e] of this.emitters) {
      if (now - e.lastSeen > EMITTER_TTL_MS) this.emitters.delete(k);
    }
    for (const [k, t] of this.transmitters) {
      if (now - t.lastSeen > EMITTER_TTL_MS) this.transmitters.delete(k);
    }
    for (const [k, s] of this.signalStates) {
      if (now - s.lastSeen > SIGNAL_TTL_MS) this.signalStates.delete(k);
    }
  }

  pduRate() {
    const now = Date.now();
    const cutoff = now - 1000;
    let n = 0;
    for (let i = this.rateWindow.length - 1; i >= 0; i--) {
      if (this.rateWindow[i] >= cutoff) n += 1; else break;
    }
    return n;
  }

  byteRate() {
    const now = Date.now();
    const cutoff = now - 1000;
    let bytes = 0;
    for (let i = this.byteRateWindow.length - 1; i >= 0; i--) {
      if (this.byteRateWindow[i].t >= cutoff) bytes += this.byteRateWindow[i].b;
      else break;
    }
    return bytes;
  }

  setEntityTimeout(secs) {
    this.entityTtlMs = Math.max(secs * 1000 * 3, 12000);
  }

  snapshot() {
    this.ageOut();
    const types = Object.entries(this.typeCounts)
      .map(([t, count]) => ({ type: Number(t), name: pduTypeName(Number(t)), count }))
      .sort((a, b) => b.count - a.count);
    const families = Object.entries(this.familyCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    const sites = Object.entries(this.siteCounts)
      .map(([id, count]) => ({ id: Number(id), count }))
      .sort((a, b) => b.count - a.count);
    const apps = Object.entries(this.appCounts)
      .map(([id, count]) => ({ id: Number(id), count }))
      .sort((a, b) => b.count - a.count);

    // Flatten active emitters into beam rows for the panel.
    const emitterRows = [];
    for (const e of this.emitters.values()) {
      for (const sys of e.systems || []) {
        for (const beam of sys.beams || []) {
          emitterRows.push({
            _key: `${e.key}|${sys.emitterNumber}|${beam.beamNumber}`,
            entity: e.key,
            emitter: sys.emitterName,
            emitterName: sys.emitterName,
            emitterNumber: sys.emitterNumber,
            emitterFunction: sys.emitterFunction,
            beamNumber: beam.beamNumber,
            beamFunction: beam.beamFunctionName,
            function: beam.beamFunctionName,
            band: beam.band,
            freqMHz: beam.frequency ? +(beam.frequency / 1e6).toFixed(1) : 0,
            prf: beam.pulseRepetitionFreq ? Math.round(beam.pulseRepetitionFreq) : 0,
            erp: beam.effectiveRadiatedPower ? +beam.effectiveRadiatedPower.toFixed(1) : 0,
            pulseWidth: beam.pulseWidth ? +beam.pulseWidth.toFixed(1) : 0,
            azimuthCenter: beam.azimuthCenter ? +beam.azimuthCenter.toFixed(3) : 0,
            azimuthSweep: beam.azimuthSweep ? +beam.azimuthSweep.toFixed(3) : 0,
            elevationCenter: beam.elevationCenter ? +beam.elevationCenter.toFixed(3) : 0,
            elevationSweep: beam.elevationSweep ? +beam.elevationSweep.toFixed(3) : 0,
            numTargets: beam.numTargets || 0,
            systemLocation: sys.location,
            stateUpdateIndicator: e.stateUpdateIndicator,
            lastSeen: e.lastSeen,
          });
        }
      }
    }

    return {
      totalPdus: this.totalPdus,
      totalBytes: this.totalBytes,
      pduRate: this.pduRate(),
      byteRate: this.byteRate(),
      entityCount: this.entities.size,
      emitterCount: this.emitters.size,
      types,
      families,
      sites,
      apps,
      entities: Array.from(this.entities.values()),
      emitters: emitterRows,
      fires: this.fires.slice(0, 100),
      detonations: this.detonations.slice(0, 100),
      transmitters: Array.from(this.transmitters.values()),
      signals: Array.from(this.signalStates.values()),
    };
  }
}
