// DIS PDU header parsing. The 12-byte header is common to every PDU and is all
// we need for counting/filtering. Full body decode is delegated to decoders.js.

import { pduTypeName, pduFamilyName } from './enums.js';
import { decodeBody } from './decoders.js';

// Parse only the common header. Cheap; used for filtering and counting.
// Returns null if the buffer is too short to be a valid PDU.
export function parseHeader(buf) {
  if (!buf || buf.length < 12) return null;
  const protocolVersion = buf.readUInt8(0);
  const exerciseId = buf.readUInt8(1);
  const pduType = buf.readUInt8(2);
  const protocolFamily = buf.readUInt8(3);
  const timestamp = buf.readUInt32BE(4);
  const length = buf.readUInt16BE(8);
  const pduStatus = buf.readUInt8(10);
  return {
    protocolVersion,
    exerciseId,
    pduType,
    pduTypeName: pduTypeName(pduType),
    protocolFamily,
    protocolFamilyName: pduFamilyName(protocolFamily),
    timestamp,
    length,
    pduStatus,
  };
}

// Full parse: header + decoded body fields where a decoder exists.
export function parsePdu(buf) {
  const header = parseHeader(buf);
  if (!header) return null;
  const body = decodeBody(header.pduType, buf);
  return { header, body };
}
