// IEEE 1278.1 DIS enumerations (subset of the most commonly used values).
// References: IEEE 1278.1-2012 and SISO-REF-010.

// Protocol Version (header byte 0) — supported versions only
export const ProtocolVersion = {
  4: 'IEEE 1278-1993',
  5: 'IEEE 1278.1-1995',
  6: 'IEEE 1278.1a-1998',
  7: 'IEEE 1278.1-2012',
};

// Minimum DIS version in which each PDU type was introduced.
// Types absent here have been defined since version 4.
export const PduMinVersion = {
  46: 6, 47: 6, 48: 6,   // Live Entity PDUs added in DIS 6
  67: 7, 68: 7,           // DirectedEnergyFire / EntityDamageStatus added in DIS 7
};

export function protocolVersionName(v) {
  return ProtocolVersion[v] || `Version ${v}`;
}

// PDU Type (header byte 2)
export const PduType = {
  1: 'EntityState',
  2: 'Fire',
  3: 'Detonation',
  4: 'Collision',
  5: 'ServiceRequest',
  6: 'ResupplyOffer',
  7: 'ResupplyReceived',
  8: 'ResupplyCancel',
  9: 'RepairComplete',
  10: 'RepairResponse',
  11: 'CreateEntity',
  12: 'RemoveEntity',
  13: 'StartResume',
  14: 'StopFreeze',
  15: 'Acknowledge',
  16: 'ActionRequest',
  17: 'ActionResponse',
  18: 'DataQuery',
  19: 'SetData',
  20: 'Data',
  21: 'EventReport',
  22: 'Comment',
  23: 'ElectromagneticEmission',
  24: 'Designator',
  25: 'Transmitter',
  26: 'Signal',
  27: 'Receiver',
  28: 'IFF',
  29: 'UnderwaterAcoustic',
  30: 'SupplementalEmission',
  31: 'IntercomSignal',
  32: 'IntercomControl',
  33: 'AggregateState',
  34: 'IsGroupOf',
  35: 'TransferOwnership',
  36: 'IsPartOf',
  37: 'MinefieldState',
  38: 'MinefieldQuery',
  39: 'MinefieldData',
  40: 'MinefieldResponseNACK',
  41: 'EnvironmentalProcess',
  42: 'GriddedData',
  43: 'PointObjectState',
  44: 'LinearObjectState',
  45: 'ArealObjectState',
  46: 'TSPI',
  47: 'Appearance',
  48: 'ArticulatedParts',
  51: 'EventReportR',
  67: 'DirectedEnergyFire',
  68: 'EntityDamageStatus',
};

// Protocol Family (header byte 3)
export const PduFamily = {
  0: 'Other',
  1: 'EntityInformation',
  2: 'Warfare',
  3: 'Logistics',
  4: 'RadioCommunications',
  5: 'SimulationManagement',
  6: 'DistributedEmissionRegeneration',
  7: 'EntityManagement',
  8: 'Minefield',
  9: 'SyntheticEnvironment',
  10: 'SimulationManagementWithReliability',
  11: 'LiveEntity',
  12: 'NonRealTime',
  13: 'InformationOperations',
};

export const ForceId = {
  0: 'Other',
  1: 'Friendly',
  2: 'Opposing',
  3: 'Neutral',
};

export const EntityKind = {
  0: 'Other',
  1: 'Platform',
  2: 'Munition',
  3: 'LifeForm',
  4: 'Environmental',
  5: 'CulturalFeature',
  6: 'Supply',
  7: 'Radio',
  8: 'Expendable',
  9: 'SensorEmitter',
};

export const Domain = {
  0: 'Other',
  1: 'Land',
  2: 'Air',
  3: 'Surface',
  4: 'Subsurface',
  5: 'Space',
};

// Detonation result (Detonation PDU)
export const DetonationResult = {
  0: 'Other',
  1: 'EntityImpact',
  2: 'EntityProximateDetonation',
  3: 'GroundImpact',
  4: 'GroundProximateDetonation',
  5: 'Detonation',
  6: 'NoDetonationDud',
};

// Beam function (EM Emission PDU)
export const BeamFunction = {
  0: 'Other',
  1: 'Search',
  2: 'HeightFinding',
  3: 'Acquisition',
  4: 'Tracking',
  5: 'AcquisitionAndTracking',
  6: 'CommandGuidance',
  7: 'Illumination',
  8: 'Ranging',
  9: 'MissileBeacon',
  10: 'MissileFusing',
  11: 'ActiveRadarMissileSeeker',
  12: 'Jamming',
  13: 'IFF',
  14: 'NavigationWeather',
  15: 'Meteorological',
  16: 'DataTransmission',
  17: 'NavigationalDirectionalBeacon',
};

// Helper: classify a frequency (Hz) into a rough radar band label.
export function radarBand(freqHz) {
  if (!freqHz || freqHz <= 0) return 'Unknown';
  const ghz = freqHz / 1e9;
  if (ghz < 0.25) return 'HF';
  if (ghz < 0.5) return 'VHF';
  if (ghz < 1) return 'UHF';
  if (ghz < 2) return 'L';
  if (ghz < 4) return 'S';
  if (ghz < 8) return 'C';
  if (ghz < 12) return 'X';
  if (ghz < 18) return 'Ku';
  if (ghz < 27) return 'K';
  if (ghz < 40) return 'Ka';
  if (ghz < 75) return 'V';
  return 'W';
}

export function pduTypeName(t) {
  return PduType[t] || `Type${t}`;
}

export function pduFamilyName(f) {
  return PduFamily[f] || `Family${f}`;
}
