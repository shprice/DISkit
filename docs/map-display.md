# Map Display

The map panel provides a real-time geospatial view of all active entities received over DIS. It supports two rendering modes and a range of display options, all persisted to localStorage between sessions.

<img width="982" height="589" alt="Screenshot 2026-09-08 160629" src="https://github.com/user-attachments/assets/f15db30a-0323-4366-bf12-f7ce1dd434e9" />

---

## Rendering Modes

### Offline Canvas (default)

When online tiles are disabled, DISkit renders onto an HTML5 Canvas using bundled world coastline data. This mode works with **no internet connection** and is suitable for air-gapped networks.

- Entities are drawn as MIL-STD-2525D SVG symbols scaled to the **Symbol size** setting.
- Panning and zooming use canvas transforms.
- Dead Reckoning, history trails, designator lines, and detonation animations are all rendered directly on the canvas.

### Online Tiles (Leaflet)

Enable **Online tiles** in Map Settings to switch to an interactive Leaflet map.

- Standard map: **OpenStreetMap** tiles (© OpenStreetMap contributors)
- Satellite imagery: **ESRI World Imagery** (enable **Satellite imagery** toggle)

In tile mode, entities are rendered as HTML/SVG `L.marker` elements overlaid on the Leaflet map. All panning, zooming, and click interaction is handled by Leaflet.

> **Note**: Tile mode requires internet access. Satellite imagery is available up to zoom level 19.

---

## Map Settings

Open the **Map Settings** panel using the ⚙ button on the map header. All settings persist across sessions.

### Display

| Setting | Description |
|---|---|
| **Online tiles** | Switch between offline canvas and online Leaflet tile map |
| **Satellite imagery** | When online tiles are active, use ESRI satellite imagery instead of OSM street map |
| **Follow selection** | Pan the map to keep the selected entity centred as it moves |
| **Show heading** | Draw a heading line extending from each entity in its direction of travel |

### Dead Reckoning

DIS entities transmit position updates at a configurable rate (typically 5–20 Hz). Between updates, DISkit uses the entity's **Dead Reckoning (DR)** algorithm and velocity/acceleration data to extrapolate its position forward in time.

| Setting | Description |
|---|---|
| **DR position** | Show the dead-reckoned position of each entity |
| **Show both** | When enabled, render the last known position *and* the DR position simultaneously. The DR icon is shown as a circle. When disabled, only the DR position is shown (using the entity's normal symbol at reduced opacity). |

Supported DR algorithms:

| Algorithm | Name | Description |
|---|---|---|
| 2 | DRM_FPW | Fixed position, world frame |
| 4 | DRM_RVW | Rotating velocity, world frame (guided munitions) |
| 5 | DRM_FVW | Fixed velocity, world frame (unguided munitions) |
| 8 | DRM_FPB | Fixed position, body frame |
| 9 | DRM_FVB | Fixed velocity, body frame |

### History Trail

| Setting | Description |
|---|---|
| **History trail** | Draw a polyline trace of each entity's past positions |
| **Trail length** | Number of past positions to retain (10–500 points) |
| **Trail color** | Colour of the history trail polyline |

### Layers

| Setting | Description |
|---|---|
| **Show munitions** | Show/hide all munition (kind=2) entities |
| **Show designations** | Show/hide laser designator lines and lase-point crosshairs |
| **Show detonations** | Show/hide detonation expansion animations |

### Force Filter

Four toggle buttons (**U / F / H / N**) filter the map by DIS Force ID:

| Button | Force | Colour |
|---|---|---|
| **U** | Unknown | Yellow |
| **F** | Friendly | Blue |
| **H** | Hostile | Red |
| **N** | Neutral | Green |

Deactivating a button hides all entities with that force from the map. Entity State PDUs continue to be processed — only the map rendering is filtered.

### Symbol size

Slider controlling the pixel size of MIL-STD-2525D symbol icons (12–60 px). Affects both offline canvas and Leaflet tile modes.

---

## Entity Symbols

Entities are rendered using **MIL-STD-2525D** symbology via the [milsymbol](https://github.com/spatialillusions/milsymbol) library. The Symbol ID Code (SIDC) is derived from the DIS entity type enumeration (SISO-REF-010):

```
Entity type:  Kind . Domain . Country . Category . Subcategory . Specific . Extra
              ────────────────────────────────────────────────────────────────────
                      → mapped to MIL-STD-2525D Symbol Set and modifier
```

Force colours follow the standard 2525D scheme:

| Force ID | Name | Colour |
|---|---|---|
| 0 | Unknown | Yellow `#c9a227` |
| 1 | Friendly | Blue `#4aa3ff` |
| 2 | Hostile | Red `#ff5b5b` |
| 3 | Neutral | Green `#4cd964` |

### Munition Icons

Munition entities (entity kind = 2) use simplified custom icons instead of the full 2525D symbol set for clarity at small sizes:

- **Guided munitions** (e.g. missiles): A top-down missile silhouette, rotated to match current heading, force-coloured.
- **Ballistic munitions** (e.g. unguided rockets, bullets): A small bullet-shaped icon, rotated to match heading, force-coloured.

Classification is based on the entity's Dead Reckoning algorithm field: DRM_FVW (5) and DRM_FVB (9) indicate constant velocity (ballistic); all other DR algorithms are treated as guided.

---

## Designator Lines

When a **Designator PDU** (type 24) is received, DISkit draws:

- A **dashed animated line** (marching-ants style) from the designating entity to the lase point
- A **pulsing crosshair** at the lase point

> 📸 *Screenshot: Designator line from an aircraft to a ground target with crosshair marker.*

The lase point uses the **Relative Designated Spot** if available; otherwise the **Designated Spot** world coordinate is used. Designator entries age out after 15 seconds of silence.

---

## Detonation Animations

On receipt of a **Detonation PDU** (type 3), an expanding semi-transparent circle animation plays at the impact location. The corresponding munition entity is simultaneously removed from the map and entity table.

---

## Map Callout

Hovering over an entity (online tile mode) or clicking it (both modes) shows a callout bubble with:

- Marking / callsign
- Force badge
- Entity type label
- Lat / Lon / Altitude
- Heading and speed

---

## Offline Canvas — Technical Notes

The offline canvas uses a simple equirectangular projection. World coastlines are pre-bundled as a GeoJSON-derived path set and drawn at startup. The canvas is re-rendered:

- Continuously (60 fps animation loop) when DR position, Show both, detonation animations, or designator lines are active
- On each stats update (every ~250 ms) otherwise

In online tile mode, the Leaflet marker layer is refreshed on each stats push. Only the DR and designator rendering requires continuous animation in tile mode.
