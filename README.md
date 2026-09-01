<img width="100" height="100" alt="image" src="https://github.com/user-attachments/assets/90d9fa0f-3e47-4db1-bca2-1aaa5213332f" />

# DISkit

A lightweight, zero-dependency toolkit and single executable for **IEEE 1278 DIS** (Distributed Interactive Simulation) network traffic logging, replay, and live geospatial visualization.

- **Single Executable Application (SEA)**: Compiles into standalone binaries (`dislogger.exe` on Windows, `dislogger` on Linux) with zero runtime dependencies.
- **Capture**: Unicast or multicast UDP DIS traffic on a configurable port with real-time PDU type filtering.
- **Record & Bookmarks**: Save to compact `.dislog` ZIP containers. Add interactive bookmarks during recording or replay, persisted directly into log metadata.
- **Replay**: Replay logs back onto the network at **0.5x–1000x** speed, with continuous looping, version translation (DIS v4, v5, v6, v7), and broadcast address auto-calculation.
- **Live Visualization**: Real-time stats dashboard displaying PDU rates, entity tracking tables, emitter details (frequency, PRF, ERP), transmitters, signals, and fire/detonation logs.
- **Map View**: MIL-STD-2525 symbol rendering on an offline canvas with bundled world coastlines (no internet required), or switchable online OpenStreetMap Leaflet view.
- **Native OS Folder Picker**: Native Windows File Explorer and Linux folder selection dialogs for log directory browsing.
- **PCAP Export**: Export captured log files directly to `.pcap` format for Wireshark analysis.

<img width="948" height="459" alt="DISkit Dashboard" src="https://github.com/user-attachments/assets/59a9c20a-6dbf-4f8d-8baa-8694df72abee" />

---

## Quick Start & Installation

### Option 1: Standalone Single Executable (Recommended)

No Node.js installation required. Download or build the standalone executable binary:

#### Windows
```powershell
# Run standalone executable (automatically opens browser to http://127.0.0.1:8080)
.\dislogger.exe

# Optional: Install to system with Desktop shortcut
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

#### Linux
```bash
# Run standalone executable
./dislogger

# Optional: Install to system with Systemd background service
sudo bash scripts/install-linux.sh
```

---

### Option 2: Running from Source

Requires **Node.js 18+** (Node 20+ LTS recommended).

```bash
# 1. Install dependencies
npm install

# 2. Start DISkit (launches Web UI automatically)
npm start
```

---

## Building Executables

To package DISkit into a standalone Single Executable Application (SEA):

```bash
npm run build:sea
```
*Outputs distribution binaries and static assets to `dist/dislogger-dist/`.*

---

## Trying DISkit without a Live DIS Source

DISkit includes a built-in multi-entity DIS traffic simulator for quick testing:

In a second terminal, launch the simulator:

```bash
# 6 entities @ 10 Hz, unicast to 127.0.0.1:3000
npm run sim

# Advanced multicast simulation (12 entities @ 20 Hz)
node src/simulator.js --count 12 --hz 20 --group 239.1.2.3 --port 3000
```

In the Web UI:
1. On the **Capture** tab: Click **Start Listening** → **● Record**.
2. Stop recording, switch to the **Replay** tab, select the log file, and click **▶ Play**.

---

## Configuration

Settings can be changed via the Web UI or by editing `config.json` in the application folder:

| Key | Description | Default |
| :--- | :--- | :--- |
| `web.host` / `web.port` | Web dashboard server address & port | `127.0.0.1` / `8080` |
| `capture.port` | UDP port for incoming DIS traffic | `3000` |
| `capture.multicastGroup` | Multicast group to join (ignored for unicast) | `239.1.2.3` |
| `capture.bindAddress` | Local network interface to bind | `0.0.0.0` |
| `replay.destAddress` | Target IP address for PDU replay (auto-calculated broadcast IP if omitted) | Calculated Subnet Broadcast (e.g. `192.168.1.255`) |
| `replay.destPort` | Target UDP port for PDU replay | `3000` |
| `replay.multicast` / `ttl` | Multicast replay options | `false` / `16` |
| `logDir` | Directory for `.dislog` files (supports relative paths like `logs` or absolute paths) | `logs` |
| `openBrowser` | Automatically open default browser on launch | `true` |

---

## Log Format & PCAP Export

- **`*.dislog`**: Efficient ZIP container format storing binary PDU stream records `[uint64 offset µs][uint16 port][uint16 length][PDU bytes]` alongside `meta.json` containing capture metadata, duration, PDU type counts, and user bookmarks.
- **PCAP Export**: Click **Export PCAP** in the UI (or send command) to produce standard `.pcap` files compatible with Wireshark.

---

## PDU Decoding & Standards Support

DISkit decodes DIS protocol families (IEEE 1278.1 / 1278.1a):
- **Entity State PDU**: Geodetic WGS84 ECEF coordinate transformation, Euler orientation, entity marking, force ID, and MIL-STD-2525 force symbology mapping.
- **Fire & Detonation PDUs**: Weapon release, target tracking, range, and impact result logging.
- **Electromagnetic Emission PDU**: Emitter system status, frequency, PRF, pulse width, and ERP parameters.
- **Transmitter & Signal PDUs**: Radio state and audio/data communications.
- **Protocol Version Translation**: Replay DIS logs as DIS v4 (1993), v5 (1995), v6 (1998), or v7 (2012).

---

## Project Layout

```
dislogger/
├── src/
│   ├── server.js        HTTP, WebSocket orchestrator, OS folder picker & splash banner
│   ├── capture.js       UDP DIS socket listener, filtering, and ZIP recorder
│   ├── logformat.js     ZIP container & legacy binary log format reader/writer
│   ├── player.js        Variable-speed, looping, and timestamp-seeking replay engine
│   ├── pcap.js          PCAP export utility
│   ├── stats.js         Rolling PDU, entity, emitter, and event aggregator
│   ├── simulator.js     Built-in multi-entity DIS traffic generator
│   └── dis/             PDU decoders, enums, version mappers, ECEF <-> Lat/Lon/Alt math
├── public/              Web UI dashboard (HTML, CSS, JS, Leaflet map, Milsymbol icons)
├── scripts/
│   ├── build-sea.mjs    Node.js SEA single-executable build pipeline script
│   ├── install-windows.ps1 Windows PowerShell installer script
│   └── install-linux.sh Linux Systemd service installer script
└── dist/
    └── dislogger-dist/  Compiled standalone executable distribution package
```

---

## Third-Party Libraries & Acknowledgements

DISkit incorporates and relies upon the following third-party libraries and data resources:

- **[milsymbol](https://github.com/spatialillusions/milsymbol)** (MIT License) — MIL-STD-2525 military symbology generator by Måns Beckman ([spatialillusions.com](https://www.spatialillusions.com)).
- **[Leaflet](https://leafletjs.com/)** (BSD 2-Clause License) & **[OpenStreetMap](https://www.openstreetmap.org/)** (ODbL) — Interactive mapping library and map tile imagery (`© OpenStreetMap contributors`).
- **[Express](https://expressjs.com/)** (MIT License) — Web application framework for Node.js.
- **[ws](https://github.com/websockets/ws)** (MIT License) — WebSocket server and client for Node.js.
- **[adm-zip](https://github.com/cthackers/adm-zip)** (MIT License) — ZIP archive library for `.dislog` file container handling.
- **[SISO-STD-010 DIS Enumerations](https://github.com/open-dis/dis-enumerations)** — Standardized DIS protocol enumeration data provided by SISO / Open-DIS.

---

## License

MIT

