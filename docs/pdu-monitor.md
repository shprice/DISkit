# PDU Monitor

The PDU Monitor panel occupies the right side of the [View tab](view-mode.md). It presents decoded DIS PDU data across 11 tabs, one per PDU family or type.

<img width="777" height="465" alt="Screenshot 2026-09-08 160804" src="https://github.com/user-attachments/assets/77e207aa-2989-4b62-a1d7-e01e777862b9" />


---

## Common Controls

### Tab Bar

The tab bar across the top shows all available PDU types. If the panel is too narrow to show all tabs, use the **‹** and **›** scroll buttons at either end to reveal hidden tabs.

### Sorting

Click any **column header** to sort by that column. Click again to reverse the sort direction. A ▲/▼ indicator shows the active sort column and direction.

### Filtering

A **Filter…** search box appears above each table. Type any text to filter rows — matches against all visible columns simultaneously (case-insensitive). The filter and sort state is preserved per-table across renders.

### Row Selection

Click any row to select it. The selected row is highlighted and its full decoded data appears in the **Details pane** at the bottom of the screen. Clicking the same row again deselects it.

### Entity Timeout

Entities that stop transmitting are aged out. The timeout threshold (default 10 s, but entities are retained for 3× the configured value, minimum 12 s) can be adjusted in the Monitor Settings panel (gear icon on the monitor header bar).

---

## Entities Tab

Shows all currently active tracked entities from **Entity State PDUs (type 1)**.

| Column | Description |
|---|---|
| **Entity** | Entity ID as `Site·App·Ent` — resolved to name if configured in site/app name tables |
| **Marking** | Entity callsign / marking string |
| **Force** | DIS Force ID (Unknown / Friendly / Hostile / Neutral) |
| **Type** | Entity type string (`Kind.Domain.Country.Cat.Sub.Spec.Extra`) resolved to a SISO-REF-010 label where available |
| **Lat / Lon** | WGS-84 geodetic position in decimal degrees |
| **Alt** | Altitude in metres |
| **Hdg** | Heading in degrees (0° = North) |
| **Spd** | Ground speed in knots |

Rows colour-code entity staleness: amber when halfway to timeout, red when near timeout.

**Details pane** for a selected entity additionally shows velocity (body frame), Euler orientation (Ψ/Θ/Φ), DR algorithm, damage state, appearance flags, articulated part parameters, and a MIL-STD-2525D symbol preview.

---

## Emissions Tab

Shows active electromagnetic emitter systems from **Electromagnetic Emission PDUs (type 23)**.

Each emitter system may have multiple beams; each beam appears as a separate row.

| Column | Description |
|---|---|
| **Entity** | Emitting entity ID |
| **Emitter** | Emitter system name (from SISO-REF-010 emitter catalogue) |
| **Function** | Beam function (Search, Acquisition, Track, etc.) |
| **Band** | ITU frequency band (HF, VHF, UHF, X, Ku, etc.) |
| **Freq (MHz)** | Centre frequency |
| **PRF (Hz)** | Pulse repetition frequency |
| **ERP (dBm)** | Effective radiated power |
| **PW (µs)** | Pulse width |

**Details pane** adds azimuth/elevation centre and sweep angles, system location offsets, number of tracked targets, and state update indicator.

---

## Fires Tab

Rolling log of **Fire PDUs (type 2)** — weapon release events.

| Column | Description |
|---|---|
| **Time** | Timestamp of the fire event |
| **Firing** | Firing entity ID |
| **Target** | Target entity ID (if specified) |
| **Munition** | Munition entity type label |
| **Range** | Initial range in metres |

**Details pane** adds the fire location (lat/lon/alt).

---

## Dets Tab

Rolling log of **Detonation PDUs (type 3)** — weapon impact / detonation events.

| Column | Description |
|---|---|
| **Time** | Timestamp |
| **Firing** | Firing entity ID |
| **Target** | Target entity ID |
| **Munition** | Munition entity type label |
| **Result** | Detonation result (None, Entity Impact, Ground Impact, Detonation, etc.) |

**Details pane** adds detonation location (lat/lon/alt).

---

## Transmitters Tab

Shows active radio transmitters from **Transmitter PDUs (type 25)**.

| Column | Description |
|---|---|
| **Host Entity** | Entity ID of the host platform |
| **Radio ID** | Radio number on the platform |
| **State** | Transmitter state (Off / On (idle) / Transmitting) |
| **Freq** | Transmit frequency (MHz) |
| **Band** | ITU band |
| **Power** | Transmit power (dBm) |

Rows highlighted green indicate actively transmitting radios.

**Details pane** adds modulation type, spread spectrum, crypto system and key, and modulation parameters.

---

## Receivers Tab

Shows radio receivers from **Receiver PDUs (type 27)**.

| Column | Description |
|---|---|
| **Host Entity** | Entity ID |
| **Radio ID** | Radio number |
| **State** | Receiver state |
| **Received Power** | Signal strength (dBm) |
| **Transmitter** | ID of the entity being received |

---

## Signals Tab

Shows active radio transmissions from **Signal PDUs (type 26)**. Audio signals are decoded where possible (CVSD codec).

| Column | Description |
|---|---|
| **Host Entity** | Transmitting entity ID |
| **Radio ID** | Radio number |
| **Encoding** | Signal encoding class and type |
| **Sample Rate** | Audio sample rate (Hz) |
| **Data Length** | PDU data field length (bits) |
| **TDL Type** | Tactical Data Link type label (e.g. `100 - Link-16 (JTIDS/MIDS/TADIL-J)`) |

**Details pane** shows TDL-decoded message fields (where supported) and a hex dump of the raw signal data.

---

## I/C Control Tab

Shows **Intercom Control PDUs (type 32)** — intercom net control messages.

| Column | Description |
|---|---|
| **Source** | Source entity ID |
| **Device** | Intercom device ID |
| **Line** | Intercom line ID |
| **Control** | Control type |
| **Transmit State** | Line transmit state |
| **Receive State** | Line receive state |

---

## I/C Signal Tab

Shows **Intercom Signal PDUs (type 31)** — intercom audio transmissions.

| Column | Description |
|---|---|
| **Entity** | Source entity ID |
| **Device** | Intercom device ID |
| **Encoding** | Signal encoding |
| **Sample Rate** | Audio sample rate |
| **Data Length** | Data field length |

---

## Set Data Tab

Shows **Set Data PDUs (type 19)** — simulation-specific data records.

| Column | Description |
|---|---|
| **Entity** | Originating entity ID |
| **Request ID** | Set Data request ID |
| **Fixed Datum Count** | Number of fixed-length datum records |
| **Variable Datum Count** | Number of variable-length datum records |

---

## Designators Tab

Shows active **Designator PDUs (type 24)** — laser designation events.

| Column | Description |
|---|---|
| **Designating Entity** | Entity performing the designation |
| **Code** | Designator code |
| **Power** | Designator power (W) |
| **Wavelength** | Laser wavelength (µm) |
| **Spot Lat / Lon** | Lase-point location |
| **Target** | Designated entity ID (if specified) |

**Details pane** adds designator system number, function, spot type, spot relative offset, and the designating entity's position.

---

## Monitor Settings

Click the **⚙ gear icon** on the monitor panel header to open the Monitor Settings panel.

| Setting | Description |
|---|---|
| **Entity timeout** | Seconds before a silent entity is aged out (applied as 3× internally, minimum 12 s) |
| **Site name table** | Map numeric Site IDs to human-readable names (e.g. `1 → Blue Force HQ`) |
| **App name table** | Map numeric Application IDs to human-readable names |

Name mappings are saved to `config.json` and persist across restarts.
