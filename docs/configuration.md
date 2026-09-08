# Configuration

DISkit stores its configuration in `config.json` in the application folder. Most settings can also be changed at runtime via the web UI and are saved automatically.

---

## config.json Reference

```jsonc
{
  "web": {
    "host": "0.0.0.0",   // Listen address for the web server (0.0.0.0 = all interfaces)
    "port": 8080          // HTTP / WebSocket port for the web UI
  },
  "capture": {
    "port": 3000,                    // UDP port to listen on for incoming DIS traffic
    "multicastGroup": "239.1.2.3",   // Multicast group to join (ignored for unicast/broadcast)
    "bindAddress": "0.0.0.0"         // Local interface to bind the DIS socket (0.0.0.0 = all)
  },
  "replay": {
    "destAddress": "127.0.0.1",  // Target IP for replayed PDUs (auto-calculated broadcast if omitted)
    "destPort": 3000,            // Target UDP port for replay
    "multicast": false,          // Send replayed PDUs as multicast
    "ttl": 16                    // Multicast TTL (hops)
  },
  "logDir": "logs",          // Directory for .dislog files (relative to executable, or absolute)
  "entityTimeoutSecs": 10,   // Seconds of silence before an entity is removed from tracking
  "openBrowser": true        // Open the default browser automatically on launch
}
```

---

## Key Settings Explained

### Web Server Address (`web.host`)

| Value | Effect |
|---|---|
| `127.0.0.1` | Web UI accessible on the local machine only |
| `0.0.0.0` | Web UI accessible from any host on the network |

When running DISkit as a remote server (e.g. a capture box), set `web.host` to `0.0.0.0` so the UI can be opened from another machine.

### Bind Address (`capture.bindAddress`)

Controls which network interface DISkit uses to receive DIS traffic.

| Value | Effect |
|---|---|
| `0.0.0.0` | Bind to all interfaces — receives traffic on any adapter |
| `192.168.1.x` | Bind to a specific interface — useful on multi-homed hosts |

> **Multicast**: Set `bindAddress` to the interface connected to the multicast-capable network, not `0.0.0.0`, to ensure the correct IGMP join.

### Entity Timeout (`entityTimeoutSecs`)

An entity that stops transmitting Entity State PDUs will be removed from the Entities table after `entityTimeoutSecs × 3` seconds (minimum 12 s). The multiplier gives a generous grace period for slow-transmitting simulators. Munition entities use a fixed 2-second TTL regardless of this setting.

### Log Directory (`logDir`)

Accepts relative paths (resolved from the executable location) or absolute paths. The web UI allows browsing and overriding this at runtime from the Log tab.

---

## Runtime Settings

The following settings are adjustable in the web UI without editing `config.json`:

| Setting | Where | Persists? |
|---|---|---|
| Capture port, multicast, bind address | Log tab → Capture section | Config file |
| Replay destination, speed, version | Replay tab | Session only |
| Entity timeout | PDU Monitor → stats bar | Config file |
| Site/App name table | PDU Monitor → settings gear | Config file |
| Map display options (tiles, DR, history, etc.) | View tab → Map Settings | localStorage |
| Force filter, symbol size | View tab → Map Settings | localStorage |

---

## Site and Application Name Tables

DIS uses numeric Site ID and Application ID fields to identify simulation participants. DISkit lets you map these to human-readable names via the Monitor Settings panel (gear icon on the PDU Monitor bar).

Example mapping:

| Site ID | Name |
|---|---|
| 1 | Blue Force HQ |
| 2 | Red Force HQ |

These mappings are saved to `config.json` and applied across all tables and the map callout.
