// Entity map with two interchangeable backends:
//   - offline canvas: auto-fitting lat/lon plot with a grid, no internet needed
//   - online tiles: Leaflet + OpenStreetMap, loaded lazily from CDN on demand
// The active backend is toggled by the "Online tiles" checkbox.

const MapView = (() => {
  let canvas, ctx, leafletEl;
  let useTiles = false;
  let useSatellite = false;
  let baseTileLayer = null; // currently active Leaflet tile layer
  let leaflet = null;       // Leaflet map instance
  let markers = new Map();  // key -> Leaflet marker
  let lastEntities = [];
  let coastlines = null;    // [ [[lon,lat],...], ... ] low-res world coastline polylines
  const WORLD = { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 };
  const forceColors = { 0: '#c9a227', 1: '#4aa3ff', 2: '#ff5b5b', 3: '#4cd964' };

  // Offline-canvas view transform (zoom + pan), applied on top of the fit.
  let zoom = 1, panX = 0, panY = 0;
  let dragging = false, lastX = 0, lastY = 0;
  let mouseDownX = 0, mouseDownY = 0;

  // Persisted view state for each provider to allow sync on switch
  let canvasSyncView = null;   // { minLat, maxLat, minLon, maxLon } — last visible bounds on canvas
  let leafletSyncView = null;  // { lat, lon, zoom } — last Leaflet view

  // History trail
  const posHistory = new Map(); // entityKey → [{lat, lon}] oldest→newest
  let showHistory = false;
  let historyLength = 100;
  let historyColor = '#f0c674';
  const historyLayers = new Map(); // entityKey → L.polyline[]

  let selectedKey = null;
  let onEntityClick = null;
  let animFrame = null;
  let calloutEl = null, calloutSvgEl = null, calloutSvgLine = null, calloutSvgDot = null;

  let showDirections = false;  // draw heading arrows
  let showDR = false;          // overlay dead-reckoned positions
  let showBoth = false;        // show ground-truth AND DR together
  let followSelected = false;  // keep map centred on selected entity
  let showMunitions    = true;
  let showDesignations = true;
  let showDetonations  = true;
  let forceFilter = null; // null = show all; Set of forceId numbers otherwise

  // WGS-84 ECEF → geodetic (lat°, lon°, alt m)
  function ecefToLlh(x, y, z) {
    const a = 6378137.0, f = 1 / 298.257223563;
    const e2 = 2 * f - f * f;
    const lon = Math.atan2(y, x);
    const p = Math.hypot(x, y);
    let lat = Math.atan2(z, p * (1 - e2));
    for (let i = 0; i < 10; i++) {
      const sinLat = Math.sin(lat);
      const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
      lat = Math.atan2(z + e2 * N * sinLat, p);
    }
    const sinLat = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const alt = p / Math.cos(lat) - N;
    return { lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI, alt };
  }

  // Extrapolate entity ECEF position using its DR algorithm + elapsed time.
  function computeDrPosition(e) {
    if (!e.location || !e.drAlgorithm || e.drAlgorithm === 0 || e.drAlgorithm === 1) return null;
    const dt = (Date.now() - (e.lastSeen || 0)) / 1000;
    if (dt <= 0 || dt > 300) return null;
    const v = e.velocity || {};
    const acc = e.drLinearAcceleration || {};
    let dx, dy, dz;
    if (e.drAlgorithm === 4 || e.drAlgorithm === 8) {
      dx = (v.x||0)*dt + 0.5*(acc.x||0)*dt*dt;
      dy = (v.y||0)*dt + 0.5*(acc.y||0)*dt*dt;
      dz = (v.z||0)*dt + 0.5*(acc.z||0)*dt*dt;
    } else {
      dx = (v.x||0)*dt; dy = (v.y||0)*dt; dz = (v.z||0)*dt;
    }
    return ecefToLlh(e.location.x + dx, e.location.y + dy, e.location.z + dz);
  }

  // Milsymbol canvas symbol cache: "sidc@size" -> { img, ready, size, anchor } | null
  const symbolCache = new Map();
  let symbolSize = 28;

  // DIS entity type → MIL-STD-2525D SIDC lookup tree (20-character format).
  // Structure: kind → domain → category → { ss, entity, label }
  //   ss     = Symbol Set (2-digit string): '10'=LandUnit, '30'=SeaSurface,
  //            '35'=SeaSubsurface, '50'=Air, '05'=Space
  //   entity = Entity code (6-digit string, symbol-set specific)
  //   label  = Human-readable symbol category name
  // Each level has a '_' fallback used when the next key is not found.
  // Country (parts[2]) is intentionally skipped — affiliation covers friend/foe.
  // Entity codes are milsymbol v3 2525D values (verified against embedded icon table).
  const SIDC_TREE = {
    1: { // Platform
      _: { ss: '10', entity: '120900', label: 'Combat' },
      1: { // Land
        _:  { ss: '10', entity: '120900', label: 'Combat' },
         0: { ss: '10', entity: '120900', label: 'Combat' },
         1: { ss: '10', entity: '120500', label: 'Armor' },               // Tank
         2: { ss: '10', entity: '121100', label: 'Infantry (Mech)' },     // AIFV
         3: { ss: '10', entity: '121100', label: 'Infantry (Mech)' },     // MICV
         4: { ss: '10', entity: '121100', label: 'Infantry' },            // Armored car
         5: { ss: '10', entity: '120900', label: 'Combat' },              // Armored cmd post
         6: { ss: '10', entity: '121300', label: 'Reconnaissance' },      // Wheeled recon
         7: { ss: '10', entity: '120900', label: 'Combat' },              // Wheeled cmd post
         8: { ss: '10', entity: '121100', label: 'Infantry' },            // Wheeled utility (sm)
         9: { ss: '10', entity: '121100', label: 'Infantry' },            // Wheeled utility (lg)
        10: { ss: '10', entity: '130800', label: 'Mortar' },              // Mortar
        11: { ss: '10', entity: '140700', label: 'Engineer' },            // Mine plow
        12: { ss: '10', entity: '140700', label: 'Engineer' },            // Mine rake
        13: { ss: '10', entity: '140700', label: 'Engineer' },            // Mine roller
        14: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        15: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        16: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        17: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        18: { ss: '10', entity: '140700', label: 'Engineer' },            // Engineer equip
        19: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        20: { ss: '10', entity: '161100', label: 'Maintenance' },         // Maintenance trailer
        21: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        22: { ss: '10', entity: '140100', label: 'CBRN' },               // Chemical decon
        23: { ss: '10', entity: '120900', label: 'Combat' },              // Warning system
        24: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        25: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        26: { ss: '10', entity: '160600', label: 'Combat Service Support' },
        28: { ss: '10', entity: '130100', label: 'Air Defence' },         // Air defense / SAM
        29: { ss: '10', entity: '140200', label: 'Combat Support' },      // C3I system
        30: { ss: '10', entity: '140200', label: 'Combat Support' },      // Operations facility
        31: { ss: '10', entity: '140200', label: 'Combat Support' },      // Intelligence facility
        32: { ss: '10', entity: '140200', label: 'Combat Support' },      // Surveillance facility
        33: { ss: '10', entity: '140200', label: 'Combat Support' },      // Comms facility
        34: { ss: '10', entity: '140200', label: 'Combat Support' },      // Command facility
        35: { ss: '10', entity: '140200', label: 'Combat Support' },      // C4I facility
        36: { ss: '10', entity: '140200', label: 'Combat Support' },      // Control facility
        37: { ss: '10', entity: '130300', label: 'Field Artillery' },     // Fire control
        38: { ss: '10', entity: '130100', label: 'Air Defence' },         // Missile defense
        39: { ss: '10', entity: '140200', label: 'Combat Support' },      // Field cmd post
        40: { ss: '10', entity: '121300', label: 'Reconnaissance' },      // Observation post
      },
      2: { // Air — Symbol Set 01 (Air) in MIL-STD-2525D
        _:  { ss: '01', entity: '110100', label: 'Fixed Wing' },
         0: { ss: '01', entity: '110100', label: 'Fixed Wing' },
         1: { ss: '01', entity: '110104', label: 'Fighter' },
         2: { ss: '01', entity: '110102', label: 'Attack / Strike' },
         3: { ss: '01', entity: '110103', label: 'Bomber' },
         4: { ss: '01', entity: '110107', label: 'Cargo / Tanker' },
         5: { ss: '01', entity: '110110', label: 'Maritime Patrol' },     // ASW / MPA
         6: { ss: '01', entity: '110108', label: 'Electronic Warfare' },
         7: { ss: '01', entity: '110111', label: 'Reconnaissance' },
         8: { ss: '01', entity: '110116', label: 'AEW' },                 // Airborne Early Warning
        20: { ss: '01', entity: '110200', label: 'Helicopter (Attack)' },
        21: { ss: '01', entity: '110200', label: 'Helicopter (Utility)' },
        22: { ss: '01', entity: '110200', label: 'Helicopter (ASW)' },
        23: { ss: '01', entity: '110200', label: 'Helicopter (Cargo)' },
        24: { ss: '01', entity: '110200', label: 'Helicopter (Obs)' },
        25: { ss: '01', entity: '110200', label: 'Helicopter (SOF)' },
        40: { ss: '01', entity: '110100', label: 'Trainer' },
        50: { ss: '01', entity: '110300', label: 'UAV' },
      },
      3: { // Surface
        _:  { ss: '30', entity: '120203', label: 'Warship' },
         0: { ss: '30', entity: '120203', label: 'Warship' },
         1: { ss: '30', entity: '120100', label: 'Carrier' },
         2: { ss: '30', entity: '120203', label: 'Command Ship' },
         3: { ss: '30', entity: '120203', label: 'Cruiser' },
         4: { ss: '30', entity: '120203', label: 'Destroyer' },
         5: { ss: '30', entity: '120203', label: 'Destroyer' },
         6: { ss: '30', entity: '120204', label: 'Frigate' },
         7: { ss: '30', entity: '120500', label: 'Patrol Craft' },
         8: { ss: '30', entity: '120402', label: 'Minesweeper' },
         9: { ss: '30', entity: '120203', label: 'Amphibious Ship' },
        10: { ss: '30', entity: '120203', label: 'Landing Ship' },
        11: { ss: '30', entity: '120500', label: 'Landing Craft' },
        14: { ss: '30', entity: '120500', label: 'Patrol Craft' },        // Hydrofoil
        16: { ss: '30', entity: '120203', label: 'Auxiliary' },
        17: { ss: '30', entity: '120203', label: 'Auxiliary' },
        50: { ss: '30', entity: '120204', label: 'Frigate' },
        51: { ss: '30', entity: '120201', label: 'Battleship' },
        52: { ss: '30', entity: '120203', label: 'Cruiser' },
        53: { ss: '30', entity: '120203', label: 'Auxiliary' },
        54: { ss: '30', entity: '120203', label: 'Amphibious Assault' },
        55: { ss: '30', entity: '120203', label: 'Amphibious Cargo' },
        56: { ss: '30', entity: '120203', label: 'Amphibious Transport' },
        57: { ss: '30', entity: '120203', label: 'Auxiliary' },
        58: { ss: '30', entity: '120203', label: 'Auxiliary' },
        59: { ss: '30', entity: '120500', label: 'Surveillance' },
        60: { ss: '30', entity: '120203', label: 'Auxiliary' },
        61: { ss: '30', entity: '120203', label: 'Non-Combatant' },
        62: { ss: '30', entity: '120500', label: 'Coast Guard' },
        63: { ss: '30', entity: '120500', label: 'Coast Guard' },
      },
      4: { // Subsurface
        _:  { ss: '35', entity: '110100', label: 'Submarine' },
         0: { ss: '35', entity: '110100', label: 'Submarine' },
         1: { ss: '35', entity: '110100', label: 'Submarine (SSBN)' },
         2: { ss: '35', entity: '110100', label: 'Submarine (SSGN)' },
         3: { ss: '35', entity: '110100', label: 'Submarine (SSN)' },
         4: { ss: '35', entity: '110100', label: 'Submarine (SSG)' },
         5: { ss: '35', entity: '110100', label: 'Submarine (SS)' },
         6: { ss: '35', entity: '110100', label: 'Submarine (SSAN)' },
         7: { ss: '35', entity: '110100', label: 'Submarine (SSA)' },
      },
      5: { // Space
        _:  { ss: '05', entity: '110700', label: 'Satellite' },
         0: { ss: '05', entity: '110700', label: 'Satellite' },
         1: { ss: '05', entity: '110500', label: 'Space Vehicle' },
         2: { ss: '05', entity: '110700', label: 'Satellite' },
         3: { ss: '05', entity: '110700', label: 'Space Launch' },
      },
    },
    2: { // Munition — use missile-specific symbol sets per MIL-STD-2525D
      _:  { ss: '02', entity: '110000', label: 'Munition' },
      1: { _: { ss: '15', entity: '110000', label: 'Munition (Land)' } },   // Land Missile (ss 15)
      2: { _: { ss: '02', entity: '110000', label: 'Munition (Air)' } },    // Air Missile (ss 02)
      3: { _: { ss: '30', entity: '110000', label: 'Munition (Sea)' } },    // Sea Surface
      4: { _: { ss: '35', entity: '110000', label: 'Munition (Sub)' } },    // Sea Subsurface
      5: { _: { ss: '06', entity: '110000', label: 'Munition (Space)' } },  // Space Missile (ss 06)
    },
    3: { // Life Form
      _:  { ss: '10', entity: '121100', label: 'Infantry' },
      1: { // Land
        _:  { ss: '10', entity: '121100', label: 'Infantry' },
         0: { ss: '10', entity: '120900', label: 'Combat' },
         1: { ss: '10', entity: '121100', label: 'Infantry' },
         2: { ss: '10', entity: '121100', label: 'Infantry' },
      },
      2: { // Air
        _:  { ss: '01', entity: '110200', label: 'Helicopter' },
         1: { ss: '01', entity: '110200', label: 'Helicopter' },          // Parachutist
      },
      3: { _: { ss: '30', entity: '120203', label: 'Warship' } },
    },
    4: { _: { ss: '10', entity: '120900', label: 'Combat' } },           // Environmental
    8: { _: { ss: '01', entity: '110100', label: 'Fixed Wing' } },       // Expendable
    9: { _: { ss: '10', entity: '140200', label: 'Combat Support' } },   // Sensor / emitter
  };

  function lookupSidc(kind, domain, category) {
    const kindNode = SIDC_TREE[kind];
    if (!kindNode) return null;
    const domainNode = kindNode[domain];
    if (!domainNode) return kindNode._ ?? null;
    return domainNode[category] ?? domainNode._ ?? kindNode._ ?? null;
  }

  function entityToSidc(entity) {
    if (!window.ms) return null;
    // DIS forceId → 2525D Standard Identity
    const SI_MAP = ['01', '03', '06', '04'];  // Unknown, Friend, Hostile, Neutral
    const si = SI_MAP[entity.forceId] ?? '01';
    const parts = (entity.type || '0.0.0.0.0.0.0').split(/[.\-]/);
    const kind     = +parts[0] || 0;
    const domain   = +parts[1] || 0;
    // parts[2] = country, intentionally skipped
    const category = +parts[3] || 0;
    const entry = lookupSidc(kind, domain, category);
    if (!entry) return null;
    // 20-char 2525D: Version(10) + SI(2) + SymSet(2) + Status(0) + HQ(0) + Amp(00) + Entity(6) + Type(00) + Subtype(00)
    return `10${si}${entry.ss}0000${entry.entity}0000`;
  }

  function entityToSidcLabel(entity) {
    const parts = (entity.type || '0.0.0.0.0.0.0').split(/[.\-]/);
    const kind     = +parts[0] || 0;
    const domain   = +parts[1] || 0;
    const category = +parts[3] || 0;
    return lookupSidc(kind, domain, category)?.label ?? null;
  }

  function getOrCreateSymbol(sidc) {
    if (!window.ms || !sidc) return null;
    const cacheKey = `${sidc}@${symbolSize}`;
    if (symbolCache.has(cacheKey)) return symbolCache.get(cacheKey);
    try {
      const sym = new window.ms.Symbol(sidc, { size: symbolSize });
      const size = sym.getSize();
      const anchor = sym.getAnchor();
      const entry = { img: new Image(), ready: false, size, anchor };
      entry.img.onload = () => { entry.ready = true; if (!useTiles) draw(); };
      entry.img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sym.asSVG());
      symbolCache.set(cacheKey, entry);
      return entry;
    } catch {
      symbolCache.set(cacheKey, null);
      return null;
    }
  }

  function setSymbolSize(n) {
    symbolSize = Math.max(12, Math.min(60, n));
    symbolCache.clear();
    if (useTiles) updateLeaflet();
    else draw();
  }

  function init(opts = {}) {
    onEntityClick = opts.onEntityClick || null;
    canvas = document.getElementById('mapCanvas');
    leafletEl = document.getElementById('leafletMap');
    ctx = canvas.getContext('2d');
    resize();
    loadCoastline();
    // ResizeObserver fires on any layout change (window resize, grid reflow, etc.)
    // so the canvas coordinate space always matches the container's current size.
    new ResizeObserver(() => { resize(); if (!useTiles) draw(); else if (leaflet) leaflet.invalidateSize(); })
      .observe(canvas.parentElement);

    canvas.addEventListener('click', (e) => {
      if (useTiles) return;
      if (Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY) > 5) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const b = bounds(lastEntities) || WORLD;
      const w = canvas.width, h = canvas.height;
      const { mapW: cMapW, mapH: cMapH, ox: cOx, oy: cOy } = projGeo(b, w, h);
      const proj = (lat, lon) => ({
        x: ((lon - b.minLon) / (b.maxLon - b.minLon) * cMapW + cOx) * zoom + panX,
        y: ((1 - (lat - b.minLat) / (b.maxLat - b.minLat)) * cMapH + cOy) * zoom + panY,
      });
      let best = null, bestDist = 22;
      for (const ent of lastEntities) {
        if (!isFinite(ent.lat) || !isFinite(ent.lon)) continue;
        const p = proj(ent.lat, ent.lon);
        const d = Math.hypot(p.x - mx, p.y - my);
        if (d < bestDist) { bestDist = d; best = ent; }
      }
      if (onEntityClick) onEntityClick(best ? best.key : null);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const nz = Math.min(500, Math.max(0.02, zoom * factor));
      const k = nz / zoom;
      panX = mx - (mx - panX) * k;
      panY = my - (my - panY) * k;
      zoom = nz;
      draw();
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      mouseDownX = e.clientX; mouseDownY = e.clientY;
      canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('mousemove', (e) => {
      if (dragging || useTiles) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const b = bounds(lastEntities) || WORLD;
      const w = canvas.width, h = canvas.height;
      const { mapW: hMapW, mapH: hMapH, ox: hOx, oy: hOy } = projGeo(b, w, h);
      let nearEntity = false;
      for (const ent of lastEntities) {
        if (!isFinite(ent.lat) || !isFinite(ent.lon)) continue;
        const px = ((ent.lon - b.minLon) / (b.maxLon - b.minLon) * hMapW + hOx) * zoom + panX;
        const py = ((1 - (ent.lat - b.minLat) / (b.maxLat - b.minLat)) * hMapH + hOy) * zoom + panY;
        if (Math.hypot(px - mx, py - my) < 22) { nearEntity = true; break; }
      }
      canvas.style.cursor = nearEntity ? 'pointer' : 'grab';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panX += e.clientX - lastX; panY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      draw();
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      if (!useTiles) canvas.style.cursor = 'grab';
    });
    canvas.addEventListener('dblclick', () => resetView());

    // Touch: single-finger pan, two-finger pinch-zoom, double-tap reset
    let touchPinchDist = 0, touchPinchMidX = 0, touchPinchMidY = 0;
    let lastTapTime = 0;

    function hitTestTouch(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const mx = clientX - rect.left, my = clientY - rect.top;
      const b = bounds(lastEntities) || WORLD;
      const { mapW: tMapW, mapH: tMapH, ox: tOx, oy: tOy } = projGeo(b, canvas.width, canvas.height);
      let best = null, bestDist = 22;
      for (const ent of lastEntities) {
        if (!isFinite(ent.lat) || !isFinite(ent.lon)) continue;
        const px = ((ent.lon - b.minLon) / (b.maxLon - b.minLon) * tMapW + tOx) * zoom + panX;
        const py = ((1 - (ent.lat - b.minLat) / (b.maxLat - b.minLat)) * tMapH + tOy) * zoom + panY;
        const d = Math.hypot(px - mx, py - my);
        if (d < bestDist) { bestDist = d; best = ent; }
      }
      if (onEntityClick) onEntityClick(best ? best.key : null);
    }

    canvas.addEventListener('touchstart', (e) => {
      if (useTiles) return;
      e.preventDefault();
      if (e.touches.length === 1) {
        dragging = true;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        mouseDownX = lastX; mouseDownY = lastY;
        touchPinchDist = 0;
        const now = Date.now();
        if (now - lastTapTime < 300) resetView();
        lastTapTime = now;
      } else if (e.touches.length === 2) {
        dragging = false;
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        touchPinchDist = Math.hypot(dx, dy);
        touchPinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        touchPinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (useTiles) return;
      e.preventDefault();
      if (e.touches.length === 1 && dragging) {
        panX += e.touches[0].clientX - lastX;
        panY += e.touches[0].clientY - lastY;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        draw();
      } else if (e.touches.length === 2 && touchPinchDist > 0) {
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const newDist = Math.hypot(dx, dy);
        const factor = newDist / touchPinchDist;
        const rect = canvas.getBoundingClientRect();
        const mx = touchPinchMidX - rect.left, my = touchPinchMidY - rect.top;
        const nz = Math.min(500, Math.max(0.02, zoom * factor));
        const k = nz / zoom;
        panX = mx - (mx - panX) * k;
        panY = my - (my - panY) * k;
        zoom = nz;
        touchPinchDist = newDist;
        touchPinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        touchPinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        draw();
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (useTiles) return;
      e.preventDefault();
      if (e.touches.length === 0 && dragging) {
        const t = e.changedTouches[0];
        if (Math.hypot(t.clientX - mouseDownX, t.clientY - mouseDownY) < 10) hitTestTouch(t.clientX, t.clientY);
        dragging = false;
      } else if (e.touches.length === 1) {
        dragging = true;
        lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
        touchPinchDist = 0;
      }
    }, { passive: false });
  }

  function resetView() {
    if (useTiles && leaflet) {
      const b = bounds(lastEntities);
      if (b) leaflet.fitBounds([[b.minLat, b.minLon], [b.maxLat, b.maxLon]]);
      return;
    }
    zoom = 1; panX = 0; panY = 0; draw();
  }

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    canvas.width = r.width; canvas.height = r.height;
  }

  function loadCoastline() {
    fetch('coastline.json')
      .then((r) => r.json())
      .then((data) => { coastlines = data; draw(); })
      .catch(() => { coastlines = null; });
  }

  function bounds(entities) {
    const pts = entities.filter((e) => isFinite(e.lat) && isFinite(e.lon));
    if (!pts.length) return null;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const e of pts) {
      minLat = Math.min(minLat, e.lat); maxLat = Math.max(maxLat, e.lat);
      minLon = Math.min(minLon, e.lon); maxLon = Math.max(maxLon, e.lon);
    }
    const padLat = Math.max(0.01, (maxLat - minLat) * 0.15);
    const padLon = Math.max(0.01, (maxLon - minLon) * 0.15);
    return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLon: minLon - padLon, maxLon: maxLon + padLon };
  }

  // Returns the letterboxed map rect inside (w×h) with cosLat aspect correction.
  function projGeo(b, w, h) {
    const midLat = (b.minLat + b.maxLat) / 2;
    const cosLat = Math.cos(midLat * Math.PI / 180) || 1;
    const natural = ((b.maxLon - b.minLon) * cosLat) / (b.maxLat - b.minLat);
    const actual = w / h;
    let mapW, mapH, ox, oy;
    if (actual > natural) {
      mapH = h; mapW = h * natural; ox = (w - mapW) / 2; oy = 0;
    } else {
      mapW = w; mapH = w / natural; ox = 0; oy = (h - mapH) / 2;
    }
    return { mapW, mapH, ox, oy };
  }

  function draw() {
    if (useTiles) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const hasEntities = lastEntities.some((e) => isFinite(e.lat) && isFinite(e.lon));
    const b = bounds(lastEntities) || WORLD;

    const { mapW, mapH, ox, oy } = projGeo(b, w, h);
    const project = (lat, lon) => ({
      x: ((lon - b.minLon) / (b.maxLon - b.minLon) * mapW + ox) * zoom + panX,
      y: ((1 - (lat - b.minLat) / (b.maxLat - b.minLat)) * mapH + oy) * zoom + panY,
    });

    // grid
    ctx.strokeStyle = 'rgba(120,160,150,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * w, y = (i / 8) * h;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // world coastlines
    if (coastlines) {
      ctx.strokeStyle = 'rgba(90,150,170,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const line of coastlines) {
        for (let i = 0; i < line.length; i++) {
          const p = project(line[i][1], line[i][0]);
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
    }

    // --- Pass 1: ground-truth entities (+ connecting lines to DR) ---
    const drawGT = !showDR || showBoth;
    for (const e of lastEntities) {
      if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
      if (forceFilter && !forceFilter.has(e.forceId)) continue;
      const hdg = (e.heading || 0) * Math.PI / 180;
      const col = forceColors[e.forceId] || '#c9a227';

      if (drawGT) {
        const p = project(e.lat, e.lon);
        if (p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) continue;
        if (e.key === selectedKey) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(255,255,255,0.2)';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.fill(); ctx.stroke();
        }
        const simKind = munitionSimpleKind(e);
        if (!showMunitions && simKind !== null) {
          // munitions hidden by toggle — skip
        } else if (simKind === 'ballistic') {
          // Bullet silhouette: pointed nose, flat base — half missile size
          ctx.save();
          ctx.translate(p.x, p.y); ctx.rotate(hdg);
          ctx.fillStyle = col;
          ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(0, -4);
          ctx.lineTo(1.5, -2);
          ctx.lineTo(1.5, 3);
          ctx.lineTo(0.5, 4);
          ctx.lineTo(-0.5, 4);
          ctx.lineTo(-1.5, 3);
          ctx.lineTo(-1.5, -2);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.restore();
        } else if (simKind === 'missile') {
          // Top-down missile silhouette: fuselage + swept delta wings + tail fins
          ctx.save();
          ctx.translate(p.x, p.y); ctx.rotate(hdg);
          ctx.fillStyle = col;
          ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(0, -8);
          ctx.lineTo(1, -3);
          ctx.lineTo(5, 2);
          ctx.lineTo(1.5, 3);
          ctx.lineTo(2, 7);
          ctx.lineTo(0.5, 6);
          ctx.lineTo(0.5, 4);
          ctx.lineTo(-0.5, 4);
          ctx.lineTo(-0.5, 6);
          ctx.lineTo(-2, 7);
          ctx.lineTo(-1.5, 3);
          ctx.lineTo(-5, 2);
          ctx.lineTo(-1, -3);
          ctx.closePath();
          ctx.fill(); ctx.stroke();
          ctx.restore();
        } else {
          const sidc = entityToSidc(e);
          const sym = sidc ? getOrCreateSymbol(sidc) : null;
          if (sym?.ready) {
            ctx.drawImage(sym.img, p.x - sym.anchor.x, p.y - sym.anchor.y, sym.size.width, sym.size.height);
          } else {
            ctx.save();
            ctx.translate(p.x, p.y); ctx.rotate(hdg);
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(-5, 6); ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
        if (showDirections) {
          const len = 25;
          const dx = Math.sin(hdg) * len, dy = -Math.cos(hdg) * len;
          ctx.save();
          ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + dx, p.y + dy); ctx.stroke();
          const ax = p.x + dx, ay = p.y + dy;
          ctx.fillStyle = '#3fb950';
          ctx.beginPath();
          ctx.moveTo(ax + Math.sin(hdg - 2.5) * 5, ay - Math.cos(hdg - 2.5) * 5);
          ctx.lineTo(ax + Math.sin(hdg) * 8,       ay - Math.cos(hdg) * 8);
          ctx.lineTo(ax + Math.sin(hdg + 2.5) * 5, ay - Math.cos(hdg + 2.5) * 5);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        ctx.fillStyle = '#c7d0da'; ctx.font = '10px system-ui';
        ctx.fillText(e.marking || '', p.x + 8, p.y + 3);

        // Dashed line GT → DR when showing both (drawn in pass 1 so it's behind DR icon)
        if (showBoth) {
          const drPos = computeDrPosition(e);
          if (drPos && isFinite(drPos.lat) && isFinite(drPos.lon)) {
            const dp = project(drPos.lat, drPos.lon);
            ctx.save();
            ctx.globalAlpha = 0.3;
            ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(dp.x, dp.y); ctx.stroke();
            ctx.restore();
          }
        }
      }
    }

    // --- Pass 2: DR positions on top of ground-truth ---
    if (showDR || showBoth) {
      for (const e of lastEntities) {
        if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
        if (forceFilter && !forceFilter.has(e.forceId)) continue;
        const drPos = computeDrPosition(e);
        if (!drPos || !isFinite(drPos.lat) || !isFinite(drPos.lon)) continue;
        const dp = project(drPos.lat, drPos.lon);
        if (dp.x < -40 || dp.x > w + 40 || dp.y < -40 || dp.y > h + 40) continue;
        const hdg = (e.heading || 0) * Math.PI / 180;
        const col = forceColors[e.forceId] || '#c9a227';
        if (showBoth) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.translate(dp.x, dp.y);
          ctx.strokeStyle = '#3fb950'; ctx.fillStyle = col;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(0, 0, 7, 0, 2 * Math.PI);
          ctx.fill(); ctx.stroke();
          ctx.restore();
        } else {
          const simKind2 = munitionSimpleKind(e);
          ctx.save();
          ctx.globalAlpha = 0.45;
          if (simKind2 === 'ballistic') {
            ctx.translate(dp.x, dp.y); ctx.rotate(hdg);
            ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(0,-4); ctx.lineTo(1.5,-2); ctx.lineTo(1.5,3);
            ctx.lineTo(0.5,4); ctx.lineTo(-0.5,4); ctx.lineTo(-1.5,3); ctx.lineTo(-1.5,-2);
            ctx.closePath(); ctx.fill(); ctx.stroke();
          } else if (simKind2 === 'missile') {
            ctx.translate(dp.x, dp.y); ctx.rotate(hdg);
            ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(0,-8); ctx.lineTo(1,-3); ctx.lineTo(5,2);
            ctx.lineTo(1.5,3); ctx.lineTo(2,7); ctx.lineTo(0.5,6); ctx.lineTo(0.5,4);
            ctx.lineTo(-0.5,4); ctx.lineTo(-0.5,6); ctx.lineTo(-2,7);
            ctx.lineTo(-1.5,3); ctx.lineTo(-5,2); ctx.lineTo(-1,-3);
            ctx.closePath(); ctx.fill(); ctx.stroke();
          } else {
            const sidc = entityToSidc(e);
            const sym = sidc ? getOrCreateSymbol(sidc) : null;
            if (sym?.ready) {
              ctx.drawImage(sym.img, dp.x - sym.anchor.x, dp.y - sym.anchor.y, sym.size.width, sym.size.height);
            } else {
              ctx.translate(dp.x, dp.y); ctx.rotate(hdg);
              ctx.fillStyle = col;
              ctx.beginPath(); ctx.moveTo(0,-7); ctx.lineTo(5,6); ctx.lineTo(-5,6); ctx.closePath(); ctx.fill();
            }
          }
          ctx.restore();
        }
        if (showDirections && isFinite(e.heading)) {
          const len = 25;
          const dx2 = Math.sin(hdg) * len, dy2 = -Math.cos(hdg) * len;
          ctx.save();
          ctx.globalAlpha = 0.45;
          ctx.strokeStyle = '#3fb950'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(dp.x, dp.y); ctx.lineTo(dp.x + dx2, dp.y + dy2); ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Draw history trails on canvas
    if (showHistory) {
      ctx.save();
      for (const [, hist] of posHistory) {
        if (hist.length < 2) continue;
        const CHUNKS = Math.min(15, hist.length - 1);
        const chunkSize = Math.ceil((hist.length - 1) / CHUNKS);
        for (let c = 0; c < CHUNKS; c++) {
          const start = c * chunkSize;
          const end = Math.min(start + chunkSize + 1, hist.length);
          if (start >= hist.length - 1) break;
          ctx.beginPath();
          ctx.strokeStyle = historyColor;
          ctx.globalAlpha = ((c + 1) / CHUNKS) * 0.85;
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          for (let i = start; i < end; i++) {
            const p = hist[i];
            const px = ((p.lon - b.minLon) / (b.maxLon - b.minLon) * mapW + ox) * zoom + panX;
            const py = ((1 - (p.lat - b.minLat) / (b.maxLat - b.minLat)) * mapH + oy) * zoom + panY;
            if (i === start) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // --- Designation lines ---
    if (lastDesignators.length && showDesignations) {
      const entMap = new Map(lastEntities.map(e => [e.key, e]));
      const dashOffset = (performance.now() / 40) % 10; // marching-ants speed
      ctx.save();
      ctx.strokeStyle = '#ff3300';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.85;
      for (const d of lastDesignators) {
        const src = entMap.get(d.designatingKey);
        if (!src || !isFinite(src.lat)) continue;
        const tgt = resolveDesigTarget(d, entMap);
        if (!tgt || !isFinite(tgt.lat)) continue;
        const sp = project(src.lat, src.lon);
        const tp = project(tgt.lat, tgt.lon);
        // Animated dashed laser line
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -dashOffset;
        ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
        // Crosshair at lase point: circle + gap-separated tick marks
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        const r = 4;
        ctx.beginPath(); ctx.arc(tp.x, tp.y, r, 0, 2 * Math.PI); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tp.x - r - 5, tp.y); ctx.lineTo(tp.x - r, tp.y);
        ctx.moveTo(tp.x + r, tp.y);     ctx.lineTo(tp.x + r + 5, tp.y);
        ctx.moveTo(tp.x, tp.y - r - 5); ctx.lineTo(tp.x, tp.y - r);
        ctx.moveTo(tp.x, tp.y + r);     ctx.lineTo(tp.x, tp.y + r + 5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- Detonation burst animations ---
    if (detonationAnims.length) {
      const now = performance.now();
      ctx.save();
      for (let i = detonationAnims.length - 1; i >= 0; i--) {
        const anim = detonationAnims[i];
        const elapsed = now - anim.startTime;
        const DURATION = 700;
        if (elapsed >= DURATION) { detonationAnims.splice(i, 1); continue; }
        const t = elapsed / DURATION;
        const ap = project(anim.lat, anim.lon);
        ctx.beginPath();
        ctx.arc(ap.x, ap.y, t * 44, 0, 2 * Math.PI);
        ctx.fillStyle = `rgba(255,80,0,${(1 - t) * 0.55})`;
        ctx.fill();
      }
      ctx.restore();
    }

    // Save current visible canvas geographic extent for provider-switch sync
    canvasSyncView = {
      minLon: b.minLon + ((0 - panX) / zoom - ox) / mapW * (b.maxLon - b.minLon),
      maxLon: b.minLon + ((w - panX) / zoom - ox) / mapW * (b.maxLon - b.minLon),
      maxLat: b.maxLat - ((0 - panY) / zoom - oy) / mapH * (b.maxLat - b.minLat),
      minLat: b.maxLat - ((h - panY) / zoom - oy) / mapH * (b.maxLat - b.minLat),
    };

    ctx.fillStyle = '#5c6b7a'; ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${b.maxLat.toFixed(2)}, ${b.minLon.toFixed(2)}`, 4, 12);
    ctx.fillText(`${b.minLat.toFixed(2)}, ${b.maxLon.toFixed(2)}`, w - 92, h - 6);
    ctx.fillText(`zoom ${zoom.toFixed(2)}x`, 4, h - 6);
    if (!hasEntities) {
      ctx.fillStyle = '#5c6b7a';
      ctx.fillText('No entity positions yet — showing world coastlines', 4, 26);
    }
    if (zoom === 1 && panX === 0 && panY === 0) {
      ctx.fillStyle = '#465261';
      const isTouchDevice = navigator.maxTouchPoints > 0;
      ctx.fillText(isTouchDevice
        ? 'pinch to zoom · drag to pan · double-tap to reset'
        : 'scroll to zoom · drag to pan · dbl-click to reset', 4, h - 18);
    }
    updateCalloutPosition();
  }

  // Pulse ring is a CSS-animated divIcon — no JS RAF needed for the animation itself.
  // The RAF loop is only used for: canvas pulse/DR (via draw()), Leaflet DR position smoothing.
  function needsLoop() {
    return (!useTiles && (showDR || showBoth || detonationAnims.length > 0 || (showDesignations && lastDesignators.length > 0))) || (useTiles && (showDR || showBoth));
  }

  function ensureLoop() {
    if (animFrame || !needsLoop()) return;
    function tick() {
      if (!needsLoop()) { animFrame = null; return; }
      if (useTiles) {
        // Smooth Leaflet DR markers between PDU arrivals
        for (const e of lastEntities) {
          const dm = drMarkers.get(e.key);
          if (!dm) continue;
          const drPos = computeDrPosition(e);
          if (drPos && isFinite(drPos.lat) && isFinite(drPos.lon)) dm.setLatLng([drPos.lat, drPos.lon]);
        }
      } else {
        draw(); // canvas: selection pulse + DR handled inside draw()
      }
      animFrame = requestAnimationFrame(tick);
    }
    animFrame = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  }

  function updateCalloutPosition() {
    if (!calloutEl || calloutEl.classList.contains('hidden') || !selectedKey) return;
    const ent = lastEntities.find(x => x.key === selectedKey);
    if (!ent || !isFinite(ent.lat) || !isFinite(ent.lon)) return;
    let sx, sy, containerW, containerH;
    if (useTiles && leaflet) {
      const pt = leaflet.latLngToContainerPoint([ent.lat, ent.lon]);
      sx = pt.x; sy = pt.y;
      containerW = leafletEl.offsetWidth; containerH = leafletEl.offsetHeight;
    } else if (canvas) {
      const b = bounds(lastEntities) || WORLD;
      const w = canvas.width, h = canvas.height;
      const { mapW, mapH, ox, oy } = projGeo(b, w, h);
      sx = ((ent.lon - b.minLon) / (b.maxLon - b.minLon) * mapW + ox) * zoom + panX;
      sy = ((1 - (ent.lat - b.minLat) / (b.maxLat - b.minLat)) * mapH + oy) * zoom + panY;
      containerW = w; containerH = h;
    } else return;
    const M = 8;
    const cw = calloutEl.offsetWidth || 220;
    const ch = calloutEl.offsetHeight || 160;
    // Place in the corner diagonally opposite the entity for maximum separation
    const left = sx < containerW / 2 ? containerW - cw - M : M;
    const top  = sy < containerH / 2 ? containerH - ch - M : M;
    calloutEl.style.left = left + 'px';
    calloutEl.style.top  = top  + 'px';
    // SVG connector: line from entity to nearest point on callout rect
    if (!calloutSvgEl) {
      calloutSvgEl  = document.getElementById('mapCalloutSvg');
      calloutSvgLine = document.getElementById('mapCalloutSvgLine');
      calloutSvgDot  = document.getElementById('mapCalloutSvgDot');
    }
    if (calloutSvgLine && calloutSvgDot) {
      const lineX2 = Math.max(left, Math.min(left + cw, sx));
      const lineY2 = Math.max(top,  Math.min(top  + ch, sy));
      calloutSvgLine.setAttribute('x1', sx);     calloutSvgLine.setAttribute('y1', sy);
      calloutSvgLine.setAttribute('x2', lineX2); calloutSvgLine.setAttribute('y2', lineY2);
      calloutSvgDot.setAttribute('cx', sx);      calloutSvgDot.setAttribute('cy', sy);
    }
  }

  function showCallout(html) {
    if (!calloutEl) calloutEl = document.getElementById('mapCallout');
    if (!calloutSvgEl) calloutSvgEl = document.getElementById('mapCalloutSvg');
    if (!calloutEl) return;
    if (!html) {
      calloutEl.classList.add('hidden');
      if (calloutSvgEl) calloutSvgEl.classList.add('hidden');
      return;
    }
    calloutEl.innerHTML = html;
    calloutEl.classList.remove('hidden');
    if (calloutSvgEl) calloutSvgEl.classList.remove('hidden');
    requestAnimationFrame(() => updateCalloutPosition());
  }

  function setSelected(key) {
    selectedKey = key;
    const ent = key ? lastEntities.find(x => x.key === key) : null;
    if (ent && isFinite(ent.lat) && isFinite(ent.lon)) {
      if (useTiles && leaflet) {
        leaflet.panTo([ent.lat, ent.lon]);
      } else if (canvas) {
        const b = bounds(lastEntities) || WORLD;
        const w = canvas.width, h = canvas.height;
        const { mapW: sMapW, mapH: sMapH, ox: sOx, oy: sOy } = projGeo(b, w, h);
        const relX = ((ent.lon - b.minLon) / (b.maxLon - b.minLon) * sMapW + sOx) * zoom;
        const relY = ((1 - (ent.lat - b.minLat) / (b.maxLat - b.minLat)) * sMapH + sOy) * zoom;
        panX = w / 2 - relX;
        panY = h / 2 - relY;
      }
    }
    if (!key) {
      if (calloutEl) calloutEl.classList.add('hidden');
      if (calloutSvgEl) calloutSvgEl.classList.add('hidden');
    }
    if (useTiles) {
      updateLeaflet();
    } else {
      draw();
    }
    if (needsLoop()) ensureLoop(); else stopLoop();
  }

  // Detonation animations (canvas mode)
  const detonationAnims = []; // { lat, lon, startTime }

  // Returns 'missile' or 'ballistic' for any kind=2 (Munition) entity, null otherwise.
  // DRM_FVW (5) and DRM_FVB (9) are fixed-velocity DR — used for unguided projectiles.
  function munitionSimpleKind(entity) {
    const parts = (entity.type || '').split(/[.\-]/);
    if (+parts[0] !== 2) return null;
    const dr = entity.drAlgorithm;
    return (dr === 5 || dr === 9) ? 'ballistic' : 'missile';
  }

  function update(entities) {
    lastEntities = entities || [];
    if (showHistory && !useTiles) {
      for (const e of lastEntities) {
        if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
        let hist = posHistory.get(e.key);
        if (!hist) { hist = []; posHistory.set(e.key, hist); }
        const last = hist[hist.length - 1];
        if (!last || last.lat !== e.lat || last.lon !== e.lon) {
          hist.push({ lat: e.lat, lon: e.lon });
          if (hist.length > historyLength) hist.shift();
        }
      }
    }
    if (followSelected && selectedKey) {
      const ent = lastEntities.find(x => x.key === selectedKey);
      if (ent && isFinite(ent.lat) && isFinite(ent.lon)) {
        if (useTiles && leaflet) {
          leaflet.panTo([ent.lat, ent.lon], { animate: true, duration: 0.3 });
        } else if (canvas) {
          const b = bounds(lastEntities) || WORLD;
          const w = canvas.width, h = canvas.height;
          const { mapW: fMapW, mapH: fMapH, ox: fOx, oy: fOy } = projGeo(b, w, h);
          const relX = ((ent.lon - b.minLon) / (b.maxLon - b.minLon) * fMapW + fOx) * zoom;
          const relY = ((1 - (ent.lat - b.minLat) / (b.maxLat - b.minLat)) * fMapH + fOy) * zoom;
          panX = w / 2 - relX;
          panY = h / 2 - relY;
        }
      }
    }
    if (useTiles && leaflet) updateLeaflet();
    else if (!animFrame) draw(); // loop already calling draw() if running
    ensureLoop(); // start loop if DR or selection needs it
  }

  function makeMilIcon(entity) {
    if (!window.ms || !window.L) return null;
    const sidc = entityToSidc(entity);
    if (!sidc) return null;
    try {
      const sym = new window.ms.Symbol(sidc, { size: symbolSize + 7 });
      const anchor = sym.getAnchor();
      const size = sym.getSize();
      return window.L.divIcon({
        html: sym.asSVG(),
        className: 'mil-icon',
        iconSize: [size.width, size.height],
        iconAnchor: [anchor.x, anchor.y],
      });
    } catch { return null; }
  }

  function makeSimpleMunitionIcon(col, hdgDeg, kind) {
    const r = (hdgDeg || 0).toFixed(1);
    let svg, w, h, ax, ay;
    if (kind === 'ballistic') {
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="14" viewBox="-6 -7 12 14">
        <g transform="rotate(${r})">
          <polygon points="0,-4 1.5,-2 1.5,3 0.5,4 -0.5,4 -1.5,3 -1.5,-2"
                   fill="${col}" stroke="rgba(0,0,0,0.4)" stroke-width="0.5"/>
        </g>
      </svg>`;
      w = 12; h = 14; ax = 6; ay = 7;
    } else {
      svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="20" viewBox="-11 -9 22 18">
        <g transform="rotate(${r})">
          <polygon points="0,-8 1,-3 5,2 1.5,3 2,7 0.5,6 0.5,4 -0.5,4 -0.5,6 -2,7 -1.5,3 -5,2 -1,-3"
                   fill="${col}" stroke="rgba(0,0,0,0.4)" stroke-width="0.5"/>
        </g>
      </svg>`;
      w = 22; h = 20; ax = 11; ay = 9;
    }
    return window.L.divIcon({ html: svg, className: '', iconSize: [w, h], iconAnchor: [ax, ay] });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // key -> Leaflet polyline (direction line), polygon (arrowhead), and drMarker (DR circle)
  const dirLines = new Map();
  const dirArrows = new Map();
  const drMarkers = new Map();

  let lastDesignators = [];
  const desigLines = new Map();  // _key -> Leaflet polyline
  const desigSpots = new Map();  // _key -> Leaflet circleMarker

  // Compute a lat/lon endpoint `d` metres in the heading direction (degrees,
  // clockwise from North).  headingDeg is already a true compass bearing after
  // the PSI→heading transformation in decoders.js, so no offset is needed.
  function headingEndpoint(lat, lon, hdgDeg, d = 1000) {
    const R = 6378137;
    const hdgRad = hdgDeg * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const dlat = Math.cos(hdgRad) * d / R;
    const dlon = Math.sin(hdgRad) * d / (R * Math.cos(latRad));
    return [lat + dlat * 180 / Math.PI, lon + dlon * 180 / Math.PI];
  }

  function headingLineMeters(lat) {
    if (!leaflet) return 1000;
    const z = leaflet.getZoom();
    const mpp = 40075016.686 * Math.abs(Math.cos(lat * Math.PI / 180)) / Math.pow(2, z + 8);
    return Math.max(200, Math.min(50000, 65 * mpp)); // 65 screen-pixels worth of metres
  }

  function ensurePanes() {
    if (!leaflet) return;
    if (!leaflet.getPane('drPane')) {
      leaflet.createPane('drPane');
      leaflet.getPane('drPane').style.zIndex = 650; // above markerPane (600)
      leaflet.getPane('drPane').style.pointerEvents = 'none';
    }
    if (!leaflet.getPane('selPane')) {
      leaflet.createPane('selPane');
      leaflet.getPane('selPane').style.zIndex = 700; // above everything
      leaflet.getPane('selPane').style.pointerEvents = 'none';
    }
  }

  function updateLeaflet(entities) {
    if (!leaflet) return;
    ensurePanes();
    const list = entities || lastEntities || [];
    const seen = new Set();
    for (const e of list) {
      if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
      const simKind = munitionSimpleKind(e);
      if (simKind !== null && !showMunitions) continue; // hidden munition — not added to seen → marker cleaned up
      if (forceFilter && !forceFilter.has(e.forceId)) continue; // hidden by force filter
      seen.add(e.key);
      const col = forceColors[e.forceId] || '#c9a227';
      let m = markers.get(e.key);
      const label = escapeHtml(e.marking || e.key);
      const isSelected = e.key === selectedKey;

      if (!m) {
        if (simKind !== null) {
          m = window.L.marker([e.lat, e.lon], { icon: makeSimpleMunitionIcon(col, e.heading, simKind) });
        } else {
          const milIcon = makeMilIcon(e);
          if (milIcon) {
            m = window.L.marker([e.lat, e.lon], { icon: milIcon });
          } else {
            m = window.L.circleMarker([e.lat, e.lon], { radius: isSelected ? 10 : 6, color: isSelected ? '#ffffff' : col, fillColor: col, fillOpacity: 0.8, weight: isSelected ? 3 : 1 });
          }
        }
        m.addTo(leaflet); markers.set(e.key, m);
        m.bindTooltip(label, { permanent: false, sticky: true });
        m.on('click', (ev) => { window.L.DomEvent.stopPropagation(ev); if (onEntityClick) onEntityClick(e.key); });
      } else {
        if (simKind !== null) {
          if (m.setStyle) {
            // was a circleMarker — replace with marker
            leaflet.removeLayer(m);
            m = window.L.marker([e.lat, e.lon], { icon: makeSimpleMunitionIcon(col, e.heading, simKind) });
            m.addTo(leaflet); markers.set(e.key, m);
            m.bindTooltip(label, { permanent: false, sticky: true });
            m.on('click', (ev) => { window.L.DomEvent.stopPropagation(ev); if (onEntityClick) onEntityClick(e.key); });
          } else {
            m.setLatLng([e.lat, e.lon]);
            m.setIcon(makeSimpleMunitionIcon(col, e.heading, simKind));
          }
        } else {
          const milIcon = makeMilIcon(e);
          const isMilMarker = !m.setStyle;
          if (milIcon && !isMilMarker) {
            leaflet.removeLayer(m);
            m = window.L.marker([e.lat, e.lon], { icon: milIcon });
            m.addTo(leaflet); markers.set(e.key, m);
            m.bindTooltip(label, { permanent: false, sticky: true });
            m.on('click', (ev) => { window.L.DomEvent.stopPropagation(ev); if (onEntityClick) onEntityClick(e.key); });
          } else {
            m.setLatLng([e.lat, e.lon]);
            if (milIcon) {
              m.setIcon(milIcon);
            } else if (m.setStyle) {
              m.setStyle({ color: isSelected ? '#ffffff' : col, fillColor: col, weight: isSelected ? 3 : 1 });
              m.setRadius(isSelected ? 10 : 6);
            }
          }
        }
        if (m.getTooltip()?.getContent() !== label) m.setTooltipContent(label);
      }

      // Show/hide ground-truth marker based on DR mode
      const gtVisible = !(showDR && !showBoth);
      if (m.setOpacity) {
        m.setOpacity(gtVisible ? 1 : 0);
      } else if (m.setStyle) {
        m.setStyle({ opacity: gtVisible ? 1 : 0, fillOpacity: gtVisible ? 0.8 : 0 });
      }

      // Direction arrow (shaft + arrowhead), scaled to zoom level
      if (showDirections && isFinite(e.heading)) {
        const d = headingLineMeters(e.lat);
        const ep = headingEndpoint(e.lat, e.lon, e.heading, d);
        let dl = dirLines.get(e.key);
        if (!dl) {
          dl = window.L.polyline([[e.lat, e.lon], ep], { color: '#3fb950', weight: 2, interactive: false }).addTo(leaflet);
          dirLines.set(e.key, dl);
        } else {
          dl.setLatLngs([[e.lat, e.lon], ep]);
        }
        // Pointy arrowhead: tip at ep, two wings set back and offset perpendicular
        const wingBack = headingEndpoint(e.lat, e.lon, e.heading, d * 0.72);
        const leftWing  = headingEndpoint(wingBack[0], wingBack[1], e.heading - 90, d * 0.09);
        const rightWing = headingEndpoint(wingBack[0], wingBack[1], e.heading + 90, d * 0.09);
        const arrowPts = [ep, leftWing, rightWing];
        let da = dirArrows.get(e.key);
        if (!da) {
          da = window.L.polygon(arrowPts, { color: '#3fb950', fillColor: '#3fb950', fillOpacity: 1, weight: 1, interactive: false }).addTo(leaflet);
          dirArrows.set(e.key, da);
        } else {
          da.setLatLngs(arrowPts);
        }
      } else {
        const dl = dirLines.get(e.key);
        if (dl) { leaflet.removeLayer(dl); dirLines.delete(e.key); }
        const da = dirArrows.get(e.key);
        if (da) { leaflet.removeLayer(da); dirArrows.delete(e.key); }
      }

      // DR position marker — in drPane (z 650) so it renders above entity markers
      const drPos = (showDR || showBoth) ? computeDrPosition(e) : null;
      if (drPos && isFinite(drPos.lat) && isFinite(drPos.lon)) {
        let dm = drMarkers.get(e.key);
        const wantCircle = showBoth;
        const hasCircle = dm ? !!dm.setStyle : null;
        if (!dm || wantCircle !== hasCircle) {
          if (dm) { leaflet.removeLayer(dm); }
          if (wantCircle) {
            dm = window.L.circleMarker([drPos.lat, drPos.lon], {
              pane: 'drPane', radius: 7, color: '#3fb950', fillColor: col,
              fillOpacity: 0.5, weight: 2, interactive: false, opacity: 0.8,
            }).addTo(leaflet);
          } else {
            const drIcon = simKind ? makeSimpleMunitionIcon(col, e.heading, simKind) : makeMilIcon(e);
            if (drIcon) {
              dm = window.L.marker([drPos.lat, drPos.lon], {
                icon: drIcon, pane: 'drPane', interactive: false,
              }).addTo(leaflet);
              dm.setOpacity(0.45);
            } else {
              dm = window.L.circleMarker([drPos.lat, drPos.lon], {
                pane: 'drPane', radius: 6, color: '#3fb950', fillColor: col,
                fillOpacity: 0.35, weight: 2, interactive: false,
              }).addTo(leaflet);
            }
          }
          drMarkers.set(e.key, dm);
        } else {
          dm.setLatLng([drPos.lat, drPos.lon]);
          if (!wantCircle && dm.setIcon) {
            const drIcon = simKind ? makeSimpleMunitionIcon(col, e.heading, simKind) : makeMilIcon(e);
            if (drIcon) dm.setIcon(drIcon);
          }
        }
      } else {
        const dm = drMarkers.get(e.key);
        if (dm) { leaflet.removeLayer(dm); drMarkers.delete(e.key); }
      }

      // Highlight selected entity by toggling CSS class on the marker element
      const el = m.getElement?.();
      if (el) el.classList.toggle('entity-selected', isSelected);

      // History trail
      if (showHistory) {
        let hist = posHistory.get(e.key);
        if (!hist) { hist = []; posHistory.set(e.key, hist); }
        const last = hist[hist.length - 1];
        if (!last || last.lat !== e.lat || last.lon !== e.lon) {
          hist.push({ lat: e.lat, lon: e.lon });
          if (hist.length > historyLength) hist.shift();
        }
        const oldLayers = historyLayers.get(e.key) || [];
        for (const l of oldLayers) leaflet.removeLayer(l);
        const newLayers = [];
        if (hist.length >= 2) {
          const CHUNKS = Math.min(15, hist.length - 1);
          const chunkSize = Math.ceil((hist.length - 1) / CHUNKS);
          for (let c = 0; c < CHUNKS; c++) {
            const start = c * chunkSize;
            const end = Math.min(start + chunkSize + 1, hist.length);
            if (start >= hist.length - 1) break;
            const pts = hist.slice(start, end).map(p => [p.lat, p.lon]);
            if (pts.length < 2) continue;
            const opacity = Math.round(((c + 1) / CHUNKS) * 0.85 * 100) / 100;
            const l = window.L.polyline(pts, { color: historyColor, weight: 2, opacity, smoothFactor: 1, interactive: false }).addTo(leaflet);
            newLayers.push(l);
          }
        }
        historyLayers.set(e.key, newLayers);
      } else {
        const old = historyLayers.get(e.key);
        if (old) { for (const l of old) leaflet.removeLayer(l); historyLayers.delete(e.key); }
      }
    }
    for (const [k, m] of markers) {
      if (!seen.has(k)) {
        leaflet.removeLayer(m); markers.delete(k);
        const dl = dirLines.get(k); if (dl) { leaflet.removeLayer(dl); dirLines.delete(k); }
        const da = dirArrows.get(k); if (da) { leaflet.removeLayer(da); dirArrows.delete(k); }
        const dm = drMarkers.get(k); if (dm) { leaflet.removeLayer(dm); drMarkers.delete(k); }
        const hl = historyLayers.get(k); if (hl) { for (const l of hl) leaflet.removeLayer(l); historyLayers.delete(k); }
      }
    }
  }

  function loadLeaflet() {
    return new Promise((resolve, reject) => {
      if (window.L) return resolve();
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function setTiles(on, infoEl) {
    useTiles = on;
    if (on) {
      try {
        await loadLeaflet();
        canvas.classList.add('hidden');
        leafletEl.classList.remove('hidden');
        if (!leaflet) {
          leaflet = window.L.map(leafletEl).setView([51.2, -1.8], 8);
          baseTileLayer = window.L.tileLayer(
            useSatellite
              ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
              : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
            useSatellite
              ? { maxZoom: 19, attribution: '© Esri World Imagery' }
              : { maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap' }
          ).addTo(leaflet);
          leaflet.on('click', () => { if (onEntityClick) onEntityClick(null); });
          leaflet.on('zoomend', () => updateLeaflet());
          leaflet.on('move', () => updateCalloutPosition());
        }
        setTimeout(() => {
          leaflet.invalidateSize();
          // Restore view after size is known
          if (leafletSyncView) {
            leaflet.setView([leafletSyncView.lat, leafletSyncView.lon], leafletSyncView.zoom);
          } else if (canvasSyncView) {
            const { minLat, maxLat, minLon, maxLon } = canvasSyncView;
            if (isFinite(minLat) && isFinite(maxLat))
              leaflet.fitBounds([[minLat, minLon], [maxLat, maxLon]]);
          } else {
            const bv = bounds(lastEntities);
            if (bv) leaflet.fitBounds([[bv.minLat, bv.minLon], [bv.maxLat, bv.maxLon]]);
          }
        }, 100);
        updateLeaflet();
        if (infoEl) infoEl.innerHTML = '<span class="map-source-pill on">online</span>';
        if (needsLoop()) ensureLoop();
      } catch (err) {
        console.error('Leaflet tile error:', err);
        useTiles = false;
        if (infoEl) infoEl.innerHTML = '<span class="map-source-pill err">offline (tiles unavailable)</span>';
        canvas.classList.remove('hidden'); leafletEl.classList.add('hidden');
        draw();
      }
    } else {
      // Save Leaflet view so we can restore it if switching back
      if (leaflet) {
        const c = leaflet.getCenter();
        leafletSyncView = { lat: c.lat, lon: c.lng, zoom: leaflet.getZoom() };
      }
      leafletEl.classList.add('hidden');
      canvas.classList.remove('hidden');
      if (infoEl) infoEl.innerHTML = '<span class="map-source-pill off">offline</span>';
      if (needsLoop()) ensureLoop(); else draw();
    }
  }

  function triggerResize() {
    resize();
    if (useTiles && leaflet) leaflet.invalidateSize();
    else draw();
  }

  function setShowDirections(on) {
    showDirections = on;
    if (useTiles) updateLeaflet(); else draw();
  }

  function setShowDR(on, both) {
    showDR = on; showBoth = !!both;
    if (useTiles) updateLeaflet(); else draw();
    if (needsLoop()) ensureLoop(); else stopLoop();
  }

  function setFollow(on) { followSelected = on; }

  function setHistory(on, length, color) {
    showHistory = on;
    if (length) historyLength = Math.max(10, Math.min(500, length));
    if (color) historyColor = color;
    if (!on) {
      for (const layers of historyLayers.values()) for (const l of layers) leaflet?.removeLayer(l);
      historyLayers.clear();
      posHistory.clear();
    }
    if (needsLoop()) ensureLoop(); else draw();
  }

  // Resolve designation target: relative spot (entity body-frame, treated as local-tangent
  // offset) takes priority; falls back to absolute ECEF spot location.
  function resolveDesigTarget(desig, entMap) {
    if (desig.spotRelIsNonZero) {
      const ent = entMap.get(desig.designatedKey);
      if (ent && isFinite(ent.lat) && isFinite(ent.lon)) {
        const R = 6378137;
        const { x, y } = desig.spotRelative; // treat x≈north, y≈east in local tangent plane
        const dlat = x / R;
        const dlon = y / (R * Math.cos(ent.lat * Math.PI / 180));
        return { lat: ent.lat + dlat * 180 / Math.PI, lon: ent.lon + dlon * 180 / Math.PI };
      }
    }
    if (desig.spotGeo && isFinite(desig.spotGeo.lat)) return desig.spotGeo;
    return null;
  }

  function makeCrosshairIcon() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-12 -12 24 24">
      <circle r="4" fill="none" stroke="#ff3300" stroke-width="1.5"/>
      <line x1="-11" y1="0" x2="-5" y2="0" stroke="#ff3300" stroke-width="1.5"/>
      <line x1="5"  y1="0" x2="11" y2="0" stroke="#ff3300" stroke-width="1.5"/>
      <line x1="0" y1="-11" x2="0" y2="-5" stroke="#ff3300" stroke-width="1.5"/>
      <line x1="0" y1="5"  x2="0" y2="11" stroke="#ff3300" stroke-width="1.5"/>
    </svg>`;
    return window.L.divIcon({
      html: `<div class="desig-crosshair">${svg}</div>`,
      className: '',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
  }

  function setDesignators(designators, entities) {
    lastDesignators = designators || [];
    if (!showDesignations) {
      for (const [k, l] of desigLines) { if (useTiles && leaflet) leaflet.removeLayer(l); desigLines.delete(k); }
      for (const [k, s] of desigSpots) { if (useTiles && leaflet) leaflet.removeLayer(s); desigSpots.delete(k); }
      if (!useTiles && !animFrame) draw();
      return;
    }
    const entMap = new Map((entities || []).map(e => [e.key, e]));

    if (useTiles && leaflet) {
      const seen = new Set();
      for (const d of lastDesignators) {
        const src = entMap.get(d.designatingKey);
        if (!src || !isFinite(src.lat)) continue;
        const tgt = resolveDesigTarget(d, entMap);
        if (!tgt || !isFinite(tgt.lat)) continue;
        seen.add(d._key);
        const latlngs = [[src.lat, src.lon], [tgt.lat, tgt.lon]];
        let line = desigLines.get(d._key);
        if (!line) {
          line = window.L.polyline(latlngs, {
            color: '#ff3300', weight: 2, opacity: 0.85,
            interactive: false, className: 'desig-line',
          }).addTo(leaflet);
          desigLines.set(d._key, line);
        } else {
          line.setLatLngs(latlngs);
        }
        let dot = desigSpots.get(d._key);
        if (!dot) {
          dot = window.L.marker([tgt.lat, tgt.lon], {
            icon: makeCrosshairIcon(), interactive: false,
          }).addTo(leaflet);
          desigSpots.set(d._key, dot);
        } else {
          dot.setLatLng([tgt.lat, tgt.lon]);
        }
      }
      for (const [k, l] of desigLines) {
        if (!seen.has(k)) { leaflet.removeLayer(l); desigLines.delete(k); }
      }
      for (const [k, s] of desigSpots) {
        if (!seen.has(k)) { leaflet.removeLayer(s); desigSpots.delete(k); }
      }
    } else {
      if (!animFrame) draw();
    }
  }

  function addDetonation(geo) {
    if (!showDetonations) return;
    if (!geo || !isFinite(geo.lat) || !isFinite(geo.lon)) return;
    if (useTiles && leaflet) {
      const icon = window.L.divIcon({
        html: '<div class="det-ring"></div>',
        className: '',
        iconSize: [80, 80],
        iconAnchor: [40, 40],
      });
      const m = window.L.marker([geo.lat, geo.lon], { icon, interactive: false, pane: 'markerPane' }).addTo(leaflet);
      setTimeout(() => leaflet.removeLayer(m), 800);
    } else {
      detonationAnims.push({ lat: geo.lat, lon: geo.lon, startTime: performance.now() });
      ensureLoop();
    }
  }

  function setShowMunitions(v) {
    showMunitions = v;
    if (useTiles && leaflet) updateLeaflet();
    else if (!animFrame) draw();
  }
  function setShowDesignations(v) {
    showDesignations = v;
    setDesignators(lastDesignators, lastEntities);
  }
  function setShowDetonations(v) { showDetonations = v; }

  function setSatellite(v) {
    useSatellite = v;
    if (leaflet && baseTileLayer) {
      leaflet.removeLayer(baseTileLayer);
      baseTileLayer = window.L.tileLayer(
        useSatellite
          ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
          : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        useSatellite
          ? { maxZoom: 19, attribution: '© Esri World Imagery' }
          : { maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap' }
      ).addTo(leaflet);
    }
  }

  function setForceFilter(forces) {
    forceFilter = forces;
    if (useTiles && leaflet) updateLeaflet();
    else if (!animFrame) draw();
  }

  return { init, update, setTiles, resetView, setSelected, showCallout, setSymbolSize, setShowDirections, setShowDR, setFollow, setHistory, setDesignators, addDetonation, setShowMunitions, setShowDesignations, setShowDetonations, setSatellite, setForceFilter, entityToSidc, entityToSidcLabel, resize: triggerResize };
})();

window.MapView = MapView;
