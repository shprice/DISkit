// Per-PDU-type body decoders. All DIS fields are big-endian.
// We decode the families that carry information useful for the UI: Entity
// Information, Warfare, and Distributed Emission Regeneration are decoded in
// detail; others return a light summary so the broad-decode UI still has labels.

import {
  ForceId, EntityKind, Domain, DetonationResult, BeamFunction, radarBand,
} from './enums.js';
import { ecefToGeodetic } from './coords.js';

const HDR = 12; // common header length

function readEntityId(buf, off) {
  return {
    site: buf.readUInt16BE(off),
    application: buf.readUInt16BE(off + 2),
    entity: buf.readUInt16BE(off + 4),
  };
}

export function entityIdKey(id) {
  return `${id.site}:${id.application}:${id.entity}`;
}

function readEntityType(buf, off) {
  return {
    kind: buf.readUInt8(off),
    kindName: EntityKind[buf.readUInt8(off)] || 'Unknown',
    domain: buf.readUInt8(off + 1),
    domainName: Domain[buf.readUInt8(off + 1)] || 'Unknown',
    country: buf.readUInt16BE(off + 2),
    category: buf.readUInt8(off + 4),
    subcategory: buf.readUInt8(off + 5),
    specific: buf.readUInt8(off + 6),
    extra: buf.readUInt8(off + 7),
  };
}

function entityTypeString(t) {
  return `${t.kind}.${t.domain}.${t.country}.${t.category}.${t.subcategory}.${t.specific}.${t.extra}`;
}

function readMarking(buf, off) {
  // 1 byte char set + 11 bytes of characters.
  const bytes = buf.subarray(off + 1, off + 12);
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    if (b >= 32 && b < 127) s += String.fromCharCode(b);
  }
  return s.trim();
}

// --- Entity State PDU (type 1) ---------------------------------------------
function decodeEntityState(buf) {
  if (buf.length < HDR + 132) return { truncated: true };
  let o = HDR;
  const entityId = readEntityId(buf, o); o += 6;
  const forceId = buf.readUInt8(o); o += 1;
  const numArticulation = buf.readUInt8(o); o += 1;
  const entityType = readEntityType(buf, o); o += 8;
  const altEntityType = readEntityType(buf, o); o += 8;
  const velocity = {
    x: buf.readFloatBE(o), y: buf.readFloatBE(o + 4), z: buf.readFloatBE(o + 8),
  }; o += 12;
  const x = buf.readDoubleBE(o);
  const y = buf.readDoubleBE(o + 8);
  const z = buf.readDoubleBE(o + 16);
  o += 24;
  const orientation = {
    psi: buf.readFloatBE(o), theta: buf.readFloatBE(o + 4), phi: buf.readFloatBE(o + 8),
  }; o += 12;
  const appearance = buf.readUInt32BE(o); o += 4;
  // Dead reckoning parameters (40 bytes)
  const drAlgorithm = buf.readUInt8(o); o += 1;
  o += 15; // other DR params (usually padding)
  const drLinearAcceleration = {
    x: buf.readFloatBE(o), y: buf.readFloatBE(o + 4), z: buf.readFloatBE(o + 8),
  }; o += 12;
  const drAngularVelocity = {
    x: buf.readFloatBE(o), y: buf.readFloatBE(o + 4), z: buf.readFloatBE(o + 8),
  }; o += 12;
  const markingCharset = buf.readUInt8(o);
  const marking = readMarking(buf, o); o += 12;
  const capabilities = buf.readUInt32BE(o); o += 4;
  // Articulation parameters (16 bytes each)
  const articulationParams = [];
  for (let i = 0; i < numArticulation; i++) {
    if (o + 16 > buf.length) break;
    articulationParams.push({
      typeDesignator: buf.readUInt8(o),
      changeIndicator: buf.readUInt8(o + 1),
      attachmentId: buf.readUInt16BE(o + 2),
      parameterType: buf.readUInt32BE(o + 4),
      parameterValue: buf.readDoubleBE(o + 8),
    });
    o += 16;
  }

  const geo = ecefToGeodetic(x, y, z);
  const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);

  return {
    entityId,
    entityIdKey: entityIdKey(entityId),
    forceId,
    forceName: ForceId[forceId] || 'Unknown',
    numArticulation,
    entityType,
    entityTypeString: entityTypeString(entityType),
    location: { x, y, z },
    geo,
    velocity,
    speed,
    orientation,
    appearance,
    drAlgorithm,
    drLinearAcceleration,
    drAngularVelocity,
    markingCharset,
    marking,
    capabilities,
    articulationParams,
    headingDeg: ((((orientation.psi * 180) / Math.PI) % 360 + 360) % 360),
  };
}

// --- Fire PDU (type 2) ------------------------------------------------------
function decodeFire(buf) {
  if (buf.length < HDR + 84) return { truncated: true };
  let o = HDR;
  const firingEntity = readEntityId(buf, o); o += 6;
  const targetEntity = readEntityId(buf, o); o += 6;
  const munitionId = readEntityId(buf, o); o += 6;
  const eventId = readEntityId(buf, o); o += 6;
  o += 4; // fire mission index
  const x = buf.readDoubleBE(o); const y = buf.readDoubleBE(o + 8); const z = buf.readDoubleBE(o + 16);
  o += 24;
  // descriptor (16) + velocity (12) + range (4)
  const munitionType = readEntityType(buf, o); o += 16;
  o += 12;
  const range = buf.readFloatBE(o);
  return {
    firingEntity, firingKey: entityIdKey(firingEntity),
    targetEntity, targetKey: entityIdKey(targetEntity),
    munitionType, munitionTypeString: entityTypeString(munitionType),
    location: { x, y, z }, geo: ecefToGeodetic(x, y, z), range,
  };
}

// --- Detonation PDU (type 3) -----------------------------------------------
function decodeDetonation(buf) {
  if (buf.length < HDR + 92) return { truncated: true };
  let o = HDR;
  const firingEntity = readEntityId(buf, o); o += 6;
  const targetEntity = readEntityId(buf, o); o += 6;
  const munitionId = readEntityId(buf, o); o += 6;
  const eventId = readEntityId(buf, o); o += 6;
  o += 12; // velocity
  const x = buf.readDoubleBE(o); const y = buf.readDoubleBE(o + 8); const z = buf.readDoubleBE(o + 16);
  o += 24;
  const munitionType = readEntityType(buf, o); o += 16;
  o += 12; // location in entity coords
  const result = buf.readUInt8(o);
  return {
    firingEntity, firingKey: entityIdKey(firingEntity),
    targetEntity, targetKey: entityIdKey(targetEntity),
    munitionType, munitionTypeString: entityTypeString(munitionType),
    location: { x, y, z }, geo: ecefToGeodetic(x, y, z),
    result, resultName: DetonationResult[result] || 'Unknown',
  };
}

// --- Electromagnetic Emission PDU (type 23) --------------------------------
function decodeEmission(buf) {
  if (buf.length < HDR + 16) return { truncated: true };
  let o = HDR;
  const emittingEntity = readEntityId(buf, o); o += 6;
  o += 6; // event id
  const stateUpdateIndicator = buf.readUInt8(o); o += 1;
  const numSystems = buf.readUInt8(o); o += 1;
  o += 2; // padding
  const systems = [];
  for (let s = 0; s < numSystems && o + 20 <= buf.length; s++) {
    const sysStart = o;
    const systemDataLength = buf.readUInt8(o) * 4; // length in 32-bit words
    const numBeams = buf.readUInt8(o + 1);
    o += 4; // length(1) + numBeams(1) + padding(2)
    const emitterName = buf.readUInt16BE(o);
    const emitterFunction = buf.readUInt8(o + 2);
    const emitterNumber = buf.readUInt8(o + 3);
    o += 4;
    const locX = buf.readFloatBE(o), locY = buf.readFloatBE(o + 4), locZ = buf.readFloatBE(o + 8);
    o += 12;
    const beams = [];
    for (let b = 0; b < numBeams && o + 48 <= buf.length; b++) {
      const beamStart = o;
      const beamDataLength = buf.readUInt8(o) * 4;
      const beamNumber = buf.readUInt8(o + 1);
      o += 4; // beamDataLength(1)+beamNumber(1)+paramIndex(2)
      const frequency = buf.readFloatBE(o);
      o += 4;
      o += 4; // frequency range
      const effectiveRadiatedPower = buf.readFloatBE(o); o += 4;
      const pulseRepetitionFreq = buf.readFloatBE(o); o += 4;
      const pulseWidth = buf.readFloatBE(o); o += 4;
      const azimuthCenter = buf.readFloatBE(o); o += 4;
      const azimuthSweep = buf.readFloatBE(o); o += 4;
      const elevationCenter = buf.readFloatBE(o); o += 4;
      const elevationSweep = buf.readFloatBE(o); o += 4;
      o += 4; // sweep sync
      const beamFunction = buf.readUInt8(o); o += 1;
      const numTargets = buf.readUInt8(o); o += 1;
      o += 2; // jamming + padding
      // skip track/jam targets (8 bytes each) and remaining beam bytes
      o = beamStart + (beamDataLength || (48 + numTargets * 8));
      beams.push({
        beamNumber, frequency, band: radarBand(frequency),
        effectiveRadiatedPower, pulseRepetitionFreq, pulseWidth,
        azimuthCenter, azimuthSweep, elevationCenter, elevationSweep,
        beamFunction, beamFunctionName: BeamFunction[beamFunction] || 'Unknown',
        numTargets,
      });
    }
    const minSysLen = o - sysStart;
    o = sysStart + (systemDataLength && systemDataLength >= 20 ? systemDataLength : Math.max(20, minSysLen));
    systems.push({ emitterName, emitterFunction, emitterNumber, numBeams, beams, location: { x: locX, y: locY, z: locZ } });
  }
  return {
    emittingEntity, emittingKey: entityIdKey(emittingEntity),
    stateUpdateIndicator, numSystems, systems,
  };
}

// --- Designator PDU (type 24) ----------------------------------------------
function decodeDesignator(buf) {
  if (buf.length < HDR + 76) return { truncated: true };
  let o = HDR;
  const designatingEntity = readEntityId(buf, o); o += 6;
  o += 2; // code name
  const designatedEntity = readEntityId(buf, o); o += 6;
  const code = buf.readUInt16BE(o); o += 2;
  const power = buf.readFloatBE(o); o += 4;
  const wavelength = buf.readFloatBE(o); o += 4;
  return {
    designatingEntity, designatingKey: entityIdKey(designatingEntity),
    designatedEntity, code, power, wavelength,
  };
}

// --- Transmitter PDU (type 25) ---------------------------------------------
function decodeTransmitter(buf) {
  if (buf.length < HDR + 92) return { truncated: true };
  let o = HDR;
  const entityId = readEntityId(buf, o); o += 6;
  const radioId = buf.readUInt16BE(o); o += 2;
  o += 2; // radio entity type kind/domain
  o += 6; // remaining radio entity type
  const txState = buf.readUInt8(o); o += 1;
  const inputSource = buf.readUInt8(o); o += 1;
  o += 2; // padding
  const x = buf.readDoubleBE(o); const y = buf.readDoubleBE(o + 8); const z = buf.readDoubleBE(o + 16);
  o += 24;
  // relative antenna location (12) + pattern type(2) + length(2)
  o += 16;
  const frequency = Number(buf.readBigUInt64BE(o)); o += 8;
  o += 4; // transmit freq bandwidth
  const power = buf.readFloatBE(o);
  return {
    entityId, entityIdKey: entityIdKey(entityId), radioId,
    txState, frequency, band: radarBand(frequency), power,
    geo: ecefToGeodetic(x, y, z),
  };
}

// --- Signal PDU (type 26) ---------------------------------------------------
const ENCODING_CLASS_NAMES = { 0: 'Encoded audio', 1: 'Raw binary', 2: 'Application specific', 3: 'Database index' };
const TDL_TYPE_NAMES = { 0: 'Other', 1: 'PADIL', 2: 'NATO Link-1', 3: 'ATDL-1', 5: 'Link-11B', 6: 'SADL', 7: 'Link-11A', 8: 'Link-16' };

function decodeSignal(buf) {
  if (buf.length < HDR + 20) return { truncated: true };
  let o = HDR;
  const entityId = readEntityId(buf, o); o += 6;
  const radioId = buf.readUInt16BE(o); o += 2;
  const encodingWord = buf.readUInt16BE(o); o += 2;
  const encodingClass = (encodingWord >> 14) & 0x3;
  const encodingType = encodingWord & 0x3FFF;
  const tdlType = buf.readUInt16BE(o); o += 2;
  const sampleRate = buf.readUInt32BE(o); o += 4;
  const dataLengthBits = buf.readUInt16BE(o); o += 2;
  const numSamples = buf.readUInt16BE(o); o += 2;
  const key = `${entityIdKey(entityId)}|${radioId}`;
  return {
    entityId, entityIdKey: entityIdKey(entityId), radioId,
    encodingClass, encodingClassName: ENCODING_CLASS_NAMES[encodingClass] || 'Unknown',
    encodingType, tdlType, tdlTypeName: TDL_TYPE_NAMES[tdlType] || `TDL ${tdlType}`,
    sampleRate, dataLengthBits, numSamples, _key: key,
  };
}

// --- Decoder Registry Map ----------------------------------------------------

export const PDU_DECODERS = new Map([
  [1, decodeEntityState],
  [2, decodeFire],
  [3, decodeDetonation],
  [23, decodeEmission],
  [24, decodeDesignator],
  [25, decodeTransmitter],
  [26, decodeSignal],
]);

/**
 * Register or override a PDU body decoder dynamically for a given DIS PDU type ID.
 */
export function registerPduDecoder(pduType, decoderFn) {
  PDU_DECODERS.set(pduType, decoderFn);
}

// Decode the body for a known PDU type. Returns null when no decoder exists
// (the PDU is still logged and counted via its header). Never throws.
export function decodeBody(pduType, buf) {
  const fn = PDU_DECODERS.get(pduType);
  if (!fn) return null;
  try {
    return fn(buf);
  } catch (err) {
    return { decodeError: String(err && err.message ? err.message : err) };
  }
}
