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

// Classify a frequency (Hz) into ITU, IEEE/radar, and NATO band designations.
export function freqBandInfo(freqHz) {
  if (!freqHz || freqHz <= 0) return { ituName: 'Unknown', ituBand: null, ieeeBand: 'Unknown', natoBand: '—' };
  const hz = freqHz;
  const ghz = hz / 1e9;

  let ituName, ituBand;
  if (hz < 30e3)       { ituName = 'VLF'; ituBand = 4; }
  else if (hz < 300e3) { ituName = 'LF';  ituBand = 5; }
  else if (hz < 3e6)   { ituName = 'MF';  ituBand = 6; }
  else if (hz < 30e6)  { ituName = 'HF';  ituBand = 7; }
  else if (hz < 300e6) { ituName = 'VHF'; ituBand = 8; }
  else if (hz < 3e9)   { ituName = 'UHF'; ituBand = 9; }
  else if (hz < 30e9)  { ituName = 'SHF'; ituBand = 10; }
  else if (hz < 300e9) { ituName = 'EHF'; ituBand = 11; }
  else                 { ituName = 'THF'; ituBand = 12; }

  let ieeeBand;
  if (ghz < 0.03)      ieeeBand = 'HF';
  else if (ghz < 0.3)  ieeeBand = 'VHF';
  else if (ghz < 1)    ieeeBand = 'UHF';
  else if (ghz < 2)    ieeeBand = 'L';
  else if (ghz < 4)    ieeeBand = 'S';
  else if (ghz < 8)    ieeeBand = 'C';
  else if (ghz < 12)   ieeeBand = 'X';
  else if (ghz < 18)   ieeeBand = 'Ku';
  else if (ghz < 27)   ieeeBand = 'K';
  else if (ghz < 40)   ieeeBand = 'Ka';
  else if (ghz < 75)   ieeeBand = 'V';
  else                 ieeeBand = 'W';

  let natoBand;
  if (hz < 250e6)      natoBand = 'A';
  else if (hz < 500e6) natoBand = 'B';
  else if (hz < 1e9)   natoBand = 'C';
  else if (hz < 2e9)   natoBand = 'D';
  else if (hz < 3e9)   natoBand = 'E';
  else if (hz < 4e9)   natoBand = 'F';
  else if (hz < 6e9)   natoBand = 'G';
  else if (hz < 8e9)   natoBand = 'H';
  else if (hz < 10e9)  natoBand = 'I';
  else if (hz < 20e9)  natoBand = 'J';
  else if (hz < 40e9)  natoBand = 'K';
  else if (hz < 60e9)  natoBand = 'L';
  else                 natoBand = 'M';

  return { ituName, ituBand, ieeeBand, natoBand };
}

// Returns the IEEE/radar letter band for a frequency in Hz (backward-compat).
export function radarBand(freqHz) {
  if (!freqHz || freqHz <= 0) return 'Unknown';
  return freqBandInfo(freqHz).ieeeBand;
}

export function pduTypeName(t) {
  return PduType[t] || `Type${t}`;
}

export function pduFamilyName(f) {
  return PduFamily[f] || `Family${f}`;
}
