// Per-PDU-type body decoders. All DIS fields are big-endian.
// We decode the families that carry information useful for the UI: Entity
// Information, Warfare, and Distributed Emission Regeneration are decoded in
// detail; others return a light summary so the broad-decode UI still has labels.

import {
  ForceId, EntityKind, Domain, DetonationResult, BeamFunction, radarBand, freqBandInfo,
} from './enums.js';
import { ecefToGeodetic } from './coords.js';
import { decodeTdlData } from './tdl-decoders.js';

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
    // Convert ECEF Euler angles to a true compass heading.
    // Full Z-Y-X rotation: forward body vector = first col of Rz(psi)*Ry(theta)*Rx(phi).
    // phi (roll) cancels out; theta (pitch) tilts the vector out of the horizontal plane.
    // Project forward vector onto local ENU then take atan2(east, north).
    headingDeg: (() => {
      const latRad = geo.lat * Math.PI / 180;
      const lonRad = geo.lon * Math.PI / 180;
      const psi = orientation.psi, theta = orientation.theta;
      const cT = Math.cos(theta), sT = Math.sin(theta);
      const east  = cT * Math.sin(psi - lonRad);
      const north = -Math.sin(latRad) * cT * Math.cos(psi - lonRad) - Math.cos(latRad) * sT;
      return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
    })(),
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
    munitionId, munitionKey: entityIdKey(munitionId),
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
const DESIGNATOR_CODE_NAME = {
  0:'Other', 1:'ACCU', 2:'GLTD-II', 3:'LTLD', 4:'MULE',
  5:'AN/PED-1 LLDR', 6:'ANGQ-11', 7:'DR-ULD', 8:'G/VLLD', 9:'GLTD',
};

function decodeDesignator(buf) {
  // Core fields: 6+2+6+2+4+4 = 24 bytes. Later fields (spot, DR, accel, vel) are optional.
  if (buf.length < HDR + 24) return { truncated: true };
  let o = HDR;
  const designatingEntity = readEntityId(buf, o); o += 6;
  const codeName = buf.readUInt16BE(o); o += 2;
  const designatedEntity = readEntityId(buf, o); o += 6;
  const code = buf.readUInt16BE(o); o += 2;
  const power = buf.readFloatBE(o); o += 4;
  const wavelength = buf.readFloatBE(o); o += 4;

  let spotRelX = 0, spotRelY = 0, spotRelZ = 0;
  if (o + 12 <= buf.length) {
    spotRelX = buf.readFloatBE(o); spotRelY = buf.readFloatBE(o + 4); spotRelZ = buf.readFloatBE(o + 8);
    o += 12;
  }

  let spotX = 0, spotY = 0, spotZ = 0;
  if (o + 24 <= buf.length) {
    spotX = buf.readDoubleBE(o); spotY = buf.readDoubleBE(o + 8); spotZ = buf.readDoubleBE(o + 16);
    o += 24;
  }

  let drAlgorithm = 0;
  if (o + 4 <= buf.length) { drAlgorithm = buf.readUInt8(o); o += 4; } // 1 byte + 3 padding

  let accX = 0, accY = 0, accZ = 0;
  if (o + 12 <= buf.length) {
    accX = buf.readFloatBE(o); accY = buf.readFloatBE(o + 4); accZ = buf.readFloatBE(o + 8);
    o += 12;
  }

  let velX = 0, velY = 0, velZ = 0;
  if (o + 12 <= buf.length) {
    velX = buf.readFloatBE(o); velY = buf.readFloatBE(o + 4); velZ = buf.readFloatBE(o + 8);
  }

  const spotRelIsNonZero = spotRelX !== 0 || spotRelY !== 0 || spotRelZ !== 0;
  const spotGeo = (spotX || spotY || spotZ) ? ecefToGeodetic(spotX, spotY, spotZ) : null;
  return {
    designatingEntity, designatingKey: entityIdKey(designatingEntity),
    designatedEntity, designatedKey: entityIdKey(designatedEntity),
    codeName, codeNameStr: DESIGNATOR_CODE_NAME[codeName] || String(codeName),
    code,
    power: isFinite(power) ? +power.toFixed(2) : null,
    wavelengthMicrons: isFinite(wavelength) ? +wavelength.toFixed(4) : null,
    wavelengthNm: isFinite(wavelength) ? +(wavelength * 1000).toFixed(1) : null,
    spotRelative: { x: +spotRelX.toFixed(3), y: +spotRelY.toFixed(3), z: +spotRelZ.toFixed(3) },
    spotRelIsNonZero, spotGeo,
    drAlgorithm,
    acceleration: { x: +accX.toFixed(3), y: +accY.toFixed(3), z: +accZ.toFixed(3) },
    velocity: { x: +velX.toFixed(3), y: +velY.toFixed(3), z: +velZ.toFixed(3) },
    _key: `designator|${entityIdKey(designatingEntity)}`,
  };
}

const RADIO_SYSTEM = {
  0:'Other', 1:'Generic', 2:'HQ', 3:'HQII', 4:'HQIIA', 5:'SINCGARS',
  6:'CCTT SINCGARS', 7:'EPLRS', 8:'JTIDS/MIDS (Link-16)', 9:'Link 11',
  10:'Link 11B', 11:'L-Band SATCOM', 12:'Enhanced SINCGARS 7.3',
};

const MAJOR_MODULATION = {
  0:'Other', 1:'AM', 2:'AM-DSB', 3:'AM-USB', 4:'AM-LSB',
  5:'AM-DSB-LC', 6:'AM-DSB-RC', 7:'FM', 8:'FSK', 9:'MSK',
  10:'NFSK', 11:'Pulse', 12:'Unmodulated',
};

const CRYPTO_SYSTEM = {
  0:'Other', 1:'KY-28', 2:'VINSON', 3:'Narrow Spectrum HOPSET',
  4:'Have Quick I', 5:'Have Quick II', 6:'Have Quick IIA',
};

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
  // relative antenna location (12)
  o += 12;
  const antennaPatternType = buf.readUInt16BE(o); o += 2;
  o += 2; // antenna pattern length
  const frequency = Number(buf.readBigUInt64BE(o)); o += 8;
  o += 4; // transmit freq bandwidth
  const power = buf.readFloatBE(o); o += 4;

  let spreadSpectrum = null, majorModulation = null, modulationDetail = null, radioSystem = null;
  let cryptoSystem = null, cryptoKeyId = null, modParamLength = 0, modulationParams = null;
  if (o + 16 <= buf.length) {
    spreadSpectrum = buf.readUInt16BE(o); o += 2;
    majorModulation = buf.readUInt16BE(o); o += 2;
    modulationDetail = buf.readUInt16BE(o); o += 2;
    radioSystem = buf.readUInt16BE(o); o += 2;
    cryptoSystem = buf.readUInt16BE(o); o += 2;
    cryptoKeyId = buf.readUInt16BE(o); o += 2;
    modParamLength = buf.readUInt8(o); o += 1;
    o += 7; // padding
    if (modParamLength > 0 && o + modParamLength <= buf.length) {
      modulationParams = Array.from(buf.subarray(o, o + modParamLength));
    }
  }

  return {
    entityId, entityIdKey: entityIdKey(entityId), radioId,
    txState, frequency, band: radarBand(frequency),
    bandInfo: freqBandInfo(frequency),
    power, antennaPatternType,
    spreadSpectrum, majorModulation,
    majorModulationName: majorModulation != null ? (MAJOR_MODULATION[majorModulation] || `Type ${majorModulation}`) : null,
    modulationDetail, radioSystem,
    radioSystemName: radioSystem != null ? (RADIO_SYSTEM[radioSystem] || `System ${radioSystem}`) : null,
    cryptoSystem,
    cryptoSystemName: cryptoSystem != null ? (CRYPTO_SYSTEM[cryptoSystem] || `System ${cryptoSystem}`) : null,
    cryptoKeyId, modParamLength, modulationParams,
    geo: ecefToGeodetic(x, y, z),
  };
}

// --- SetData PDU (type 19) -------------------------------------------------
function decodeSetData(buf) {
  if (buf.length < HDR + 28) return { truncated: true };
  let o = HDR;
  const originatingEntityId = readEntityId(buf, o); o += 6;
  const receivingEntityId = readEntityId(buf, o); o += 6;
  const requestId = buf.readUInt32BE(o); o += 4;
  o += 4; // padding
  const numFixedDatums = buf.readUInt32BE(o); o += 4;
  const numVariableDatums = buf.readUInt32BE(o); o += 4;

  const fixedDatums = [];
  for (let i = 0; i < numFixedDatums && o + 8 <= buf.length; i++) {
    const datumId = buf.readUInt32BE(o);
    const value = Array.from(buf.subarray(o + 4, o + 8));
    fixedDatums.push({ datumId, value });
    o += 8;
  }

  const variableDatums = [];
  for (let i = 0; i < numVariableDatums && o + 8 <= buf.length; i++) {
    const startO = o;
    const datumId = buf.readUInt32BE(o); o += 4;
    const lengthBits = buf.readUInt32BE(o); o += 4;
    const byteLen = Math.ceil(lengthBits / 8);
    // datum record padded to 64-bit (8-byte) boundary from start of datum ID
    const paddedLen = Math.ceil((8 + byteLen) / 8) * 8;
    const value = o + byteLen <= buf.length ? Array.from(buf.subarray(o, o + byteLen)) : [];
    variableDatums.push({ datumId, lengthBits, value });
    o = startO + paddedLen;
  }

  const originatingEntityKey = entityIdKey(originatingEntityId);
  return {
    originatingEntityId, originatingEntityKey,
    receivingEntityId, receivingEntityKey: entityIdKey(receivingEntityId),
    requestId, numFixedDatums, numVariableDatums,
    fixedDatums, variableDatums,
    _key: `setdata|${originatingEntityKey}|${requestId}`,
  };
}

// --- Signal PDU (type 26) ---------------------------------------------------
const ENCODING_CLASS_NAMES = { 0: 'Encoded audio', 1: 'Raw binary', 2: 'Application specific', 3: 'Database index' };
const TDL_TYPE_NAMES = {
  0: 'Other',
  1: 'PADIL',
  2: 'NATO Link-1',
  3: 'ATDL-1',
  4: 'Link-11B',
  5: 'Link-11B (TADIL-B)',
  6: 'SADL',
  7: 'Link-11A (TADIL-A)',
  8: 'Link-16 (JTIDS/MIDS/TADIL-J)',
  9: 'FBCB2',
  10: 'IBIT',
  11: 'L-Band SATCOM',
  12: 'Enhanced SINCGARS 7.3',
  13: 'HAVE QUICK II',
  14: 'SINCGARS',
  15: 'EPLRS (SUNIL)',
  16: 'SINCGARS ICOM',
  100: 'Link-16 (JTIDS/MIDS/TADIL-J)',
};

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
  const rawPayload = buf.length > o ? buf.subarray(o) : null;
  const key = `${entityIdKey(entityId)}|${radioId}`;
  const tdlData = (tdlType && rawPayload) ? decodeTdlData(tdlType, rawPayload) : null;
  const signalBytes = rawPayload ? Array.from(rawPayload.subarray(0, 512)) : null;
  return {
    entityId, entityIdKey: entityIdKey(entityId), radioId,
    encodingClass, encodingClassName: ENCODING_CLASS_NAMES[encodingClass] || 'Unknown',
    encodingType, tdlType,
    tdlTypeName: TDL_TYPE_NAMES[tdlType] != null ? `${tdlType} – ${TDL_TYPE_NAMES[tdlType]}` : `TDL ${tdlType}`,
    sampleRate, dataLengthBits, numSamples,
    audioData: rawPayload, // kept for audio pipeline; stripped from stats storage
    signalBytes, tdlData,  // client-side display
    _key: key,
  };
}

// --- Receiver PDU (type 27) ---------------------------------------------------
const RECEIVER_STATE = { 0: 'Off', 1: 'On (idle)', 2: 'Receiving' };

function decodeReceiver(buf) {
  if (buf.length < HDR + 24) return { truncated: true };
  let o = HDR;
  const entityId = readEntityId(buf, o); o += 6;
  const radioId = buf.readUInt16BE(o); o += 2;
  const receiverState = buf.readUInt16BE(o); o += 2;
  o += 2; // padding
  const receivedPower = buf.readFloatBE(o); o += 4;
  const transmitterEntityId = readEntityId(buf, o); o += 6;
  const transmitterRadioId = buf.readUInt16BE(o); o += 2;
  return {
    entityId, entityIdKey: entityIdKey(entityId), radioId,
    receiverState, receiverStateName: RECEIVER_STATE[receiverState] || `State ${receiverState}`,
    receivedPower: isFinite(receivedPower) ? +receivedPower.toFixed(1) : null,
    transmitterEntityId,
    transmitterEntityKey: entityIdKey(transmitterEntityId),
    transmitterRadioId,
    _key: `${entityIdKey(entityId)}|${radioId}`,
  };
}

// --- Intercom Signal PDU (type 31) -------------------------------------------
function decodeIntercomSignal(buf) {
  if (buf.length < HDR + 20) return { truncated: true };
  let o = HDR;
  const entityId = readEntityId(buf, o); o += 6;
  const deviceId = buf.readUInt16BE(o); o += 2;
  const encodingWord = buf.readUInt16BE(o); o += 2;
  const encodingClass = (encodingWord >> 14) & 0x3;
  const encodingType = encodingWord & 0x3FFF;
  const tdlType = buf.readUInt16BE(o); o += 2;
  const sampleRate = buf.readUInt32BE(o); o += 4;
  const dataLengthBits = buf.readUInt16BE(o); o += 2;
  const numSamples = buf.readUInt16BE(o); o += 2;
  const audioData = buf.length > o ? buf.subarray(o) : null;
  return {
    entityId, entityIdKey: entityIdKey(entityId), deviceId,
    encodingClass, encodingClassName: ENCODING_CLASS_NAMES[encodingClass] || 'Unknown',
    encodingType, tdlType,
    tdlTypeName: TDL_TYPE_NAMES[tdlType] != null ? `${tdlType} – ${TDL_TYPE_NAMES[tdlType]}` : `TDL ${tdlType}`,
    sampleRate, dataLengthBits, numSamples, audioData,
    _key: `ic-sig|${entityIdKey(entityId)}|${deviceId}`,
  };
}

// --- Intercom Control PDU (type 32) ------------------------------------------
const IC_CONTROL_TYPE = { 0: 'Reserved', 1: 'Status', 2: 'Request (ack)', 3: 'Request (no ack)', 4: 'Ack', 5: 'Nack' };
const IC_CHANNEL_TYPE = { 0: 'Reserved', 1: 'Connection A', 2: 'Connection B' };
const IC_COMMAND = { 0: 'No command', 1: 'Status', 2: 'Connect', 3: 'Disconnect', 4: 'Freeze signal', 5: 'Thaw signal', 6: 'Freeze', 7: 'Thaw' };

function decodeIntercomControl(buf) {
  if (buf.length < HDR + 14) return { truncated: true };
  let o = HDR;
  const controlType = buf.readUInt8(o); o += 1;
  const channelType = buf.readUInt8(o); o += 1;
  const sourceEntityId = readEntityId(buf, o); o += 6;
  const sourceDeviceId = buf.readUInt16BE(o); o += 2;
  const sourceLineId = buf.readUInt8(o); o += 1;
  const transmitPriority = buf.readUInt8(o); o += 1;
  const transmitLineState = buf.readUInt8(o); o += 1;
  const command = buf.readUInt8(o); o += 1;
  const masterEntityId = (o + 6 <= buf.length) ? readEntityId(buf, o) : null;
  if (masterEntityId) o += 6;
  const masterDeviceId = (o + 2 <= buf.length) ? buf.readUInt16BE(o) : null;
  if (masterDeviceId !== null) o += 2;
  const masterChannelId = (o + 2 <= buf.length) ? buf.readUInt16BE(o) : null;
  const sourceKey = entityIdKey(sourceEntityId);
  return {
    sourceEntityId, sourceEntityKey: sourceKey,
    sourceDeviceId, sourceLineId,
    controlType, controlTypeName: IC_CONTROL_TYPE[controlType] || `Type ${controlType}`,
    channelType, channelTypeName: IC_CHANNEL_TYPE[channelType] || `Chan ${channelType}`,
    transmitPriority, transmitLineState,
    command, commandName: IC_COMMAND[command] || `Cmd ${command}`,
    masterEntityId, masterEntityKey: masterEntityId ? entityIdKey(masterEntityId) : null,
    masterDeviceId, masterChannelId,
    _key: `ic-ctrl|${sourceKey}|${sourceDeviceId}|${sourceLineId}`,
  };
}

// --- Decoder Registry Map ----------------------------------------------------

export const PDU_DECODERS = new Map([
  [1, decodeEntityState],
  [2, decodeFire],
  [3, decodeDetonation],
  [19, decodeSetData],
  [23, decodeEmission],
  [24, decodeDesignator],
  [25, decodeTransmitter],
  [26, decodeSignal],
  [27, decodeReceiver],
  [31, decodeIntercomSignal],
  [32, decodeIntercomControl],
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
