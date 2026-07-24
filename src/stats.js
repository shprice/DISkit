// Rolling aggregation of decoded PDUs for the live UI. Tracks per-type counts,
// a live entity table (with positions for the map), and active emitters.
// Entities/emitters that stop transmitting are aged out.

import { pduTypeName } from './dis/enums.js';

const ENTITY_TTL_MS = 12000;   // drop entities not heard from for this long
const EMITTER_TTL_MS = 15000;

export class Stats {
  constructor() {
    this.reset();
  }

  reset() {
    this.typeCounts = {};       // pduType -> count
    this.familyCounts = {};     // familyName -> count
    this.totalPdus = 0;
    this.totalBytes = 0;
    this.entities = new Map();  // key -> entity record
    this.emitters = new Map();  // emittingKey -> { systems, lastSeen }
    this.startTime = Date.now();
    this.rateWindow = [];       // timestamps (ms) for PDU/s estimate
  }

  // header: parsed common header. body: decoded body (may be null).
  ingest(header, body, byteLen) {
    const now = Date.now();
    this.totalPdus += 1;
    this.totalBytes += byteLen || 0;
    this.typeCounts[header.pduType] = (this.typeCounts[header.pduType] || 0) + 1;
    this.familyCounts[header.protocolFamilyName] =
      (this.familyCounts[header.protocolFamilyName] || 0) + 1;

    this.rateWindow.push(now);
    if (this.rateWindow.length > 2000) this.rateWindow.shift();

    if (header.pduType === 1 && body && body.entityIdKey) {
      this.entities.set(body.entityIdKey, {
        key: body.entityIdKey,
        marking: body.marking || body.entityIdKey,
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
        lastSeen: now,
      });
    }

    if (header.pduType === 23 && body && body.emittingKey) {
      this.emitters.set(body.emittingKey, {
        key: body.emittingKey,
        numSystems: body.numSystems,
        systems: body.systems,
        lastSeen: now,
      });
    }
  }

  ageOut() {
    const now = Date.now();
    for (const [k, e] of this.entities) {
      if (now - e.lastSeen > ENTITY_TTL_MS) this.entities.delete(k);
    }
    for (const [k, e] of this.emitters) {
      if (now - e.lastSeen > EMITTER_TTL_MS) this.emitters.delete(k);
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

  snapshot() {
    this.ageOut();
    const types = Object.entries(this.typeCounts)
      .map(([t, count]) => ({ type: Number(t), name: pduTypeName(Number(t)), count }))
      .sort((a, b) => b.count - a.count);
    const families = Object.entries(this.familyCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // Flatten active emitters into beam rows for the panel.
    const emitterRows = [];
    for (const e of this.emitters.values()) {
      for (const sys of e.systems || []) {
        for (const beam of sys.beams || []) {
          emitterRows.push({
            entity: e.key,
            emitter: sys.emitterName,
            function: beam.beamFunctionName,
            band: beam.band,
            freqMHz: beam.frequency ? +(beam.frequency / 1e6).toFixed(1) : 0,
            prf: beam.pulseRepetitionFreq ? Math.round(beam.pulseRepetitionFreq) : 0,
            erp: beam.effectiveRadiatedPower ? +beam.effectiveRadiatedPower.toFixed(1) : 0,
          });
        }
      }
    }

    return {
      totalPdus: this.totalPdus,
      totalBytes: this.totalBytes,
      pduRate: this.pduRate(),
      entityCount: this.entities.size,
      emitterCount: this.emitters.size,
      types,
      families,
      entities: Array.from(this.entities.values()),
      emitters: emitterRows,
    };
  }
}
