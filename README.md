# DISLogger

A simple-to-deploy logger and replay utility for **IEEE 1278 DIS** (Distributed
Interactive Simulation) network traffic, with a live browser dashboard.

- **Capture** unicast or multicast UDP DIS traffic on a configurable port.
- **Record** to a compact binary log; optionally **filter PDU types** to shrink files.
- **Replay** recorded logs back onto the network at **0.5x–1000x** speed, with
  optional **continuous looping** and a replay-time type filter.
- **Live visualisation** of PDU type counts, PDU/s rate, entity count, emitter
  details (band/frequency/PRF/ERP) during both capture and replay.
- **Map view** of entity positions — offline canvas with bundled low-resolution
  world coastlines (no internet), or switchable to online OpenStreetMap tiles.
  Scroll to zoom, drag to pan, double-click to reset.
- **PCAP export** so logs open in Wireshark.

## Requirements

Node.js 18+ (developed against v24). No native modules.

## Setup

```bash
npm install
npm start
```

Then open the UI it prints, e.g. <http://127.0.0.1:8080>.

## Try it without a live DIS source

In a second terminal, start the built-in traffic generator:

```bash
npm run sim                       # 6 entities @ 10 Hz, unicast to 127.0.0.1:3000
node src/simulator.js --count 12 --hz 20 --group 239.1.2.3 --port 3000   # multicast
```

In the UI (capture defaults to unicast): **Start Listening** → **● Record** →
stop → switch to the **Replay** tab → pick the log → choose a speed → **▶ Play**.
If you run the simulator with a multicast `--group`, tick **Multicast** in the
Capture tab to match.

## Configuration

Edit `config.json`:

| Key | Meaning |
| --- | --- |
| `web.host` / `web.port` | Address the dashboard is served on |
| `capture.port` | UDP port to listen on |
| `capture.multicastGroup` | Multicast group to join (ignore for unicast) |
| `capture.bindAddress` | Interface to bind / join the group on |
| `replay.destAddress` / `replay.destPort` | Where replayed PDUs are sent |
| `replay.multicast` / `replay.ttl` | Multicast send options |
| `logDir` | Where `.dislog` files are written |

These are also editable live in the UI.

## Log format

`*.dislog` — 32-byte file header (magic, version, start wall-clock) followed by
records of `[uint64 offset µs][uint16 port][uint16 length][PDU bytes]`. A
sidecar `*.dislog.meta.json` stores capture config, duration and PDU-type counts
for fast summaries. Use **Export to PCAP** for Wireshark-compatible output.

## PDU decoding

Every PDU's common 12-byte header is parsed for counting and filtering. Bodies
are fully decoded for Entity State (position/orientation/marking/force),
Fire, Detonation, Electromagnetic Emission (emitter/beam details), Designator
and Transmitter. Other PDUs are logged and counted by header. Entity positions
are converted from WGS84 geocentric (ECEF) metres to lat/lon/alt for the map.

## Project layout

```
src/
  server.js      HTTP + WebSocket orchestrator
  capture.js     UDP listen, filter, record
  logformat.js   binary log read/write + meta sidecar
  player.js      variable-speed looping replay
  pcap.js        PCAP export
  stats.js       rolling PDU/entity/emitter aggregation
  simulator.js   built-in DIS traffic generator
  dis/           enums, header parse, body decoders, ECEF<->geodetic
public/          browser dashboard (UI, map, charts)
  coastline.json bundled low-res world coastline (Natural Earth 110m, public domain)
```
