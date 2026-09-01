// Export a DISLOG binary log to a standard libpcap (.pcap) file so it can be
// opened in Wireshark. Each DIS PDU is wrapped in synthetic Ethernet/IPv4/UDP
// framing. Link type is Ethernet (DLT_EN10MB = 1).

import fs from 'fs';
import { LogReader, readMeta } from './logformat.js';

function ipToBytes(ip) {
  const parts = ip.split('.').map((n) => parseInt(n, 10) & 0xff);
  return Buffer.from(parts.length === 4 ? parts : [127, 0, 0, 1]);
}

function ipChecksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) sum += buf.readUInt16BE(i);
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return (~sum) & 0xffff;
}

function buildFrame(pdu, srcIp, dstIp, srcPort, dstPort) {
  const eth = Buffer.alloc(14);
  // dst MAC, src MAC left zero; ethertype IPv4.
  eth.writeUInt16BE(0x0800, 12);

  const udpLen = 8 + pdu.length;
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(srcPort, 0);
  udp.writeUInt16BE(dstPort, 2);
  udp.writeUInt16BE(udpLen, 4);
  // checksum 0 = not computed (legal for IPv4 UDP)

  const ipTotal = 20 + udpLen;
  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);          // version 4, IHL 5
  ip.writeUInt16BE(ipTotal, 2);    // total length
  ip.writeUInt8(64, 8);            // TTL
  ip.writeUInt8(17, 9);            // protocol UDP
  ipToBytes(srcIp).copy(ip, 12);
  ipToBytes(dstIp).copy(ip, 16);
  ip.writeUInt16BE(ipChecksum(ip), 10);

  return Buffer.concat([eth, ip, udp, pdu]);
}

// Returns { buffer, packets, bytes } — builds the entire PCAP in memory.
export function exportToPcapBuffer(logPath, opts = {}) {
  const meta = readMeta(logPath) || {};
  const srcIp = opts.srcIp || '10.0.0.1';
  const dstIp = opts.dstIp || meta.multicastGroup || meta.destination || '239.1.2.3';
  const srcPort = opts.srcPort || 3000;

  const reader = new LogReader(logPath);
  try {
    const gh = Buffer.alloc(24);
    gh.writeUInt32LE(0xa1b2c3d4, 0);
    gh.writeUInt16LE(2, 4);
    gh.writeUInt16LE(4, 6);
    gh.writeUInt32LE(65535, 16);
    gh.writeUInt32LE(1, 20);

    const chunks = [gh];
    const startMs = reader.startWallClockMs;
    let packets = 0, bytes = 0, rec;
    while ((rec = reader.readNext()) !== null) {
      const frame = buildFrame(rec.pdu, srcIp, dstIp, srcPort, rec.port || 3000);
      const absMicros = startMs * 1000 + rec.offsetMicros;
      const ph = Buffer.alloc(16);
      ph.writeUInt32LE(Math.floor(absMicros / 1e6), 0);
      ph.writeUInt32LE(Math.floor(absMicros % 1e6), 4);
      ph.writeUInt32LE(frame.length, 8);
      ph.writeUInt32LE(frame.length, 12);
      chunks.push(ph, frame);
      packets += 1;
      bytes += frame.length;
    }
    return { buffer: Buffer.concat(chunks), packets, bytes };
  } finally {
    reader.close();
  }
}

// Returns { packets, bytes } — writes PCAP to disk (kept for CLI use).
export function exportToPcap(logPath, pcapPath, opts = {}) {
  const { buffer, packets, bytes } = exportToPcapBuffer(logPath, opts);
  fs.writeFileSync(pcapPath, buffer);
  return { packets, bytes };
}
