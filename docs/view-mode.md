# View Mode

The **View** tab is DISkit's live monitoring mode. It displays two panels side by side:

- **Left / top**: [Map display](map-display.md) — geospatial positions of all active entities
- **Right / bottom**: [PDU Monitor](pdu-monitor.md) — live tables of decoded PDU data

> 📸 *Screenshot: Full View tab showing map on the left and PDU monitor on the right.*

---

## Layout

The divider between the map and monitor panels is draggable. Both panels can be collapsed using the **▾** toggle button at the top of each panel. All column widths in every table are individually draggable and persist across sessions.

---

## Statistics Bar

Below the main tab bar, a statistics strip shows:

| Metric | Description |
|---|---|
| **PDUs Received** | Total PDUs received since DISkit started (or last reset) |
| **PDU/s** | Rolling 1-second PDU rate, with a mini sparkline graph |
| **Entities** | Current number of active tracked entities |
| **Data Rate** | Incoming data throughput (auto-scales: b/s → kb/s → Mb/s) |
| **Data Received** | Total bytes received |

---

## Details Pane

The bottom strip shows the full decoded detail of whatever is currently selected — click any row in any PDU Monitor table, or click an entity on the map, to populate it.

The pane updates in real time as new PDU data arrives for the selected item (e.g. a moving entity's position, or an emitter's changing beam parameters). It only re-renders when the data actually changes, to avoid interrupting text selection.

For entities the details pane shows:
- Entity ID (Site · Application · Entity)
- Marking / callsign, force, entity type (decoded SISO-REF-010 label)
- Position (lat/lon/alt in metres and feet)
- Heading and speed
- Velocity vector (body frame)
- Orientation (Euler angles Ψ/Θ/Φ)
- Dead Reckoning algorithm
- Damage state and other appearance flags
- Articulated/attached part parameters
- MIL-STD-2525D symbol preview

---

## Selecting Entities

- **Map click**: Click any entity symbol on the map to select it. The symbol is highlighted (colours inverted). Click away from any entity to deselect.
- **Table click**: Click any row in the Entities tab to select that entity. The map pans to it (if *Follow selection* is enabled) and the Entities table scrolls the row into view automatically.
- **Deselect**: Click on empty map space, or click the same row again.

When an entity is selected and the Entities tab is active, the table automatically scrolls to keep the selected row visible even as new entities arrive and re-sort the table.
