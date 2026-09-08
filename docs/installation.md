# Installation

DISkit is distributed as a **standalone single executable** — no runtime dependencies or installation required. It can also be run directly from source with Node.js.

---

## Option 1 — Standalone Executable (Recommended)

Download the latest release from the [Releases page](https://github.com/shprice/DISkit/releases/latest) and extract the ZIP for your platform.

```
diskit-windows.zip  →  Windows x64
diskit-linux.zip    →  Linux x64
```

### Windows

```powershell
# Extract and run
.\diskit.exe
```

DISkit will automatically open your default browser to `http://127.0.0.1:8080`.

**Optional: Install system-wide with a Desktop shortcut**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

The installer places the executable at `%LOCALAPPDATA%\DISkit\` and creates a Desktop shortcut.

### Linux

```bash
# Make executable and run
chmod +x diskit
./diskit
```

**Optional: Install as a systemd background service**

```bash
sudo bash scripts/install-linux.sh
```

This installs DISkit as a systemd service that starts automatically on boot, runs as the current user, and logs to the system journal (`journalctl -u diskit -f`).

---

## Option 2 — Run from Source

Requires **Node.js 18 or later** (Node.js 20 LTS recommended).

```bash
# 1. Clone the repository
git clone https://github.com/shprice/DISkit.git
cd DISkit

# 2. Install dependencies
npm install

# 3. Start DISkit
npm start
```

The web UI opens automatically at `http://127.0.0.1:8080`. To suppress auto-open:

```bash
node src/server.js --no-open
```

---

## Building Standalone Executables from Source

```bash
npm run build:sea
```

Output is placed in `dist/diskit-dist/`. The build packages the Node.js SEA (Single Executable Application) binary alongside the `public/` web assets, `config.json`, and `sample_logs/`.

---

## Network Considerations

DISkit listens for DIS UDP traffic on the configured port (default `3000`). Depending on your environment:

- **Unicast / Broadcast**: Ensure no local firewall blocks incoming UDP on that port.
- **Multicast**: The host must be on a network where multicast routing is enabled. Enable the Multicast toggle in the UI and enter your group address.
- **Windows**: Windows Firewall may prompt to allow access the first time DISkit binds a socket — allow access on the relevant network profile (Private/Domain).

---

## Testing Without a Live DIS Network

DISkit ships with a built-in traffic simulator. In a second terminal:

```bash
# 6 entities at 10 Hz, unicast to localhost
npm run sim

# Customised: 12 entities at 20 Hz over multicast
node src/simulator.js --count 12 --hz 20 --group 239.1.2.3 --port 3000
```

See [Configuration](configuration.md) and the [View mode guide](view-mode.md) for next steps.
