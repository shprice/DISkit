// Unit Test Suite for DIS Protocol Body Decoders and Map Registry

import { parseHeader } from '../src/dis/pdu.js';
import { decodeBody, registerPduDecoder, PDU_DECODERS } from '../src/dis/decoders.js';

console.log('=== Running PDU Decoders & Registry Unit Tests ===');

// 1. Check registry defaults
if (!PDU_DECODERS.has(1) || !PDU_DECODERS.has(2) || !PDU_DECODERS.has(23)) {
  console.error('FAIL default PDU decoders missing from registry');
  process.exit(1);
}
console.log('OK  default PDU decoders registered in Map');

// 2. Test custom decoder registration
registerPduDecoder(99, (buf) => ({ customParsed: true, len: buf.length }));
const customResult = decodeBody(99, Buffer.alloc(20));
if (!customResult || !customResult.customParsed || customResult.len !== 20) {
  console.error('FAIL custom PDU decoder registration');
  process.exit(1);
}
console.log('OK  custom PDU decoder registered dynamically');

// 3. Test Entity State PDU (Type 1) decoding
const espduBuf = Buffer.alloc(144);
espduBuf.writeUInt8(6, 0);   // DIS v6
espduBuf.writeUInt8(1, 1);   // Exercise ID 1
espduBuf.writeUInt8(1, 2);   // PDU Type 1 (Entity State)
espduBuf.writeUInt8(1, 3);   // Protocol Family 1 (Entity Information)
espduBuf.writeUInt16BE(144, 8); // Length 144

// Site 10, App 20, Entity 30
espduBuf.writeUInt16BE(10, 12);
espduBuf.writeUInt16BE(20, 14);
espduBuf.writeUInt16BE(30, 16);

// Force ID = 1 (Friendly)
espduBuf.writeUInt8(1, 18);

// Marking text "TANK_1"
espduBuf.writeUInt8(1, 118); // ASCII set
espduBuf.write('TANK_1', 119, 'utf8');

const espduHeader = parseHeader(espduBuf);
const espduBody = decodeBody(1, espduBuf);

if (!espduBody || espduBody.entityIdKey !== '10:20:30' || espduBody.forceName !== 'Friendly') {
  console.error('FAIL EntityState PDU decode verification', espduBody);
  process.exit(1);
}
console.log('OK  EntityState PDU decoded successfully (Key: 10:20:30, Force: Friendly)');

// 4. Test Fire PDU (Type 2) decoding
const fireBuf = Buffer.alloc(96);
fireBuf.writeUInt8(6, 0);
fireBuf.writeUInt8(2, 2); // PDU Type 2 (Fire)
fireBuf.writeUInt16BE(96, 8);
// Firing Entity 1:1:1, Target Entity 1:1:2
fireBuf.writeUInt16BE(1, 12); fireBuf.writeUInt16BE(1, 14); fireBuf.writeUInt16BE(1, 16);
fireBuf.writeUInt16BE(1, 18); fireBuf.writeUInt16BE(1, 20); fireBuf.writeUInt16BE(2, 22);

const fireBody = decodeBody(2, fireBuf);
if (!fireBody || fireBody.firingKey !== '1:1:1' || fireBody.targetKey !== '1:1:2') {
  console.error('FAIL Fire PDU decode verification', fireBody);
  process.exit(1);
}
console.log('OK  Fire PDU decoded successfully');

// 5. Test Detonation PDU (Type 3) decoding
const detBuf = Buffer.alloc(104);
detBuf.writeUInt8(6, 0);
detBuf.writeUInt8(3, 2); // PDU Type 3 (Detonation)
detBuf.writeUInt16BE(104, 8);
detBuf.writeUInt16BE(2, 12); detBuf.writeUInt16BE(2, 14); detBuf.writeUInt16BE(1, 16);
detBuf.writeUInt16BE(2, 18); detBuf.writeUInt16BE(2, 20); detBuf.writeUInt16BE(5, 22);
detBuf.writeUInt8(1, 100); // Detonation Result = Entity Impact

const detBody = decodeBody(3, detBuf);
if (!detBody || detBody.firingKey !== '2:2:1' || detBody.targetKey !== '2:2:5' || detBody.resultName !== 'EntityImpact') {
  console.error('FAIL Detonation PDU decode verification', detBody);
  process.exit(1);
}
console.log('OK  Detonation PDU decoded successfully (Result: Entity Impact)');

// 6. Test Truncated Buffer resilience
const truncatedBuf = Buffer.alloc(16);
const truncBody = decodeBody(1, truncatedBuf);
if (!truncBody || !truncBody.truncated) {
  console.error('FAIL Truncated buffer resilience check');
  process.exit(1);
}
console.log('OK  Truncated PDU body handled gracefully without throwing');

console.log('\nAll PDU decoder unit tests PASSED!');
