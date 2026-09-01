// Entity map with two interchangeable backends:
//   - offline canvas: auto-fitting lat/lon plot with a grid, no internet needed
//   - online tiles: Leaflet + OpenStreetMap, loaded lazily from CDN on demand
// The active backend is toggled by the "Online tiles" checkbox.

const MapView = (() => {
  let canvas, ctx, leafletEl;
  let useTiles = false;
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

  let selectedKey = null;
  let onEntityClick = null;
  let animFrame = null;

  // Milsymbol canvas symbol cache: "sidc@size" -> { img, ready, size, anchor } | null
  const symbolCache = new Map();
  let symbolSize = 28;

  // DIS entity type → MIL-STD-2525C SIDC lookup tree.
  // Structure: kind → domain → category → { bd, fn }
  // Each level has a '_' fallback used when the next key is not found.
  // Country (parts[2]) is intentionally skipped — affiliation covers friend/foe.
  const SIDC_TREE = {
    1: { // Platform
      _: { bd: 'G', fn: '------' },
      1: { // Land → G
        _: { bd: 'G', fn: '------' },
         0: { bd: 'G', fn: '------' },
         1: { bd: 'G', fn: 'UCAT--' },  // Tank
         2: { bd: 'G', fn: 'UCA---' },  // Armored fighting vehicle (IFV/APC)
         3: { bd: 'G', fn: 'USS---' },  // Armored utility vehicle
         4: { bd: 'G', fn: 'UCFHE-' },  // Self-propelled artillery
         5: { bd: 'G', fn: 'UCFH--' },  // Towed artillery
         6: { bd: 'G', fn: 'USS---' },  // Small wheeled utility
         7: { bd: 'G', fn: 'USS---' },  // Large wheeled utility
         8: { bd: 'G', fn: 'USS---' },  // Small tracked utility
         9: { bd: 'G', fn: 'USS---' },  // Large tracked utility
        10: { bd: 'G', fn: 'UCFM--' },  // Mortar
        11: { bd: 'G', fn: 'UCE---' },  // Mine plow
        12: { bd: 'G', fn: 'UCE---' },  // Mine rake
        13: { bd: 'G', fn: 'UCE---' },  // Mine roller
        14: { bd: 'G', fn: 'USS---' },  // Cargo trailer
        15: { bd: 'G', fn: 'USS---' },  // Fuel trailer
        16: { bd: 'G', fn: 'USS---' },  // Generator trailer
        17: { bd: 'G', fn: 'USS---' },  // Water trailer
        18: { bd: 'G', fn: 'UCE---' },  // Engineer equipment
        19: { bd: 'G', fn: 'UST---' },  // Heavy equipment transport
        20: { bd: 'G', fn: 'USXH--' },  // Maintenance trailer
        21: { bd: 'G', fn: 'USS---' },  // Limber
        22: { bd: 'G', fn: 'UUAD--' },  // Chemical decon trailer
        23: { bd: 'G', fn: 'UUS---' },  // Warning system
        24: { bd: 'G', fn: 'USTR--' },  // Train engine
        25: { bd: 'G', fn: 'USTR--' },  // Train car
        26: { bd: 'G', fn: 'USTR--' },  // Train caboose
        // 27 = Civilian vehicle → no military symbol, falls through to null
        28: { bd: 'G', fn: 'UCD---' },  // Air defense / missile defense
        29: { bd: 'G', fn: 'UH1---' },  // C3I system
        30: { bd: 'G', fn: 'UH1---' },  // Operations facility
        31: { bd: 'G', fn: 'UUM---' },  // Intelligence facility
        32: { bd: 'G', fn: 'UUMRS-' },  // Surveillance facility
        33: { bd: 'G', fn: 'UUS---' },  // Communications facility
        34: { bd: 'G', fn: 'UH1---' },  // Command facility
        35: { bd: 'G', fn: 'UH1---' },  // C4I facility
        36: { bd: 'G', fn: 'UH1---' },  // Control facility
        37: { bd: 'G', fn: 'UCFT--' },  // Fire control facility
        38: { bd: 'G', fn: 'UCDO--' },  // Missile defense facility
        39: { bd: 'G', fn: 'UH1---' },  // Field command post
        40: { bd: 'G', fn: 'UCR---' },  // Observation post
      },
      2: { // Air → A
        _: { bd: 'A', fn: '------' },
         0: { bd: 'A', fn: '------' },
         1: { bd: 'A', fn: 'MFF---' },  // Fighter
         2: { bd: 'A', fn: 'MFA---' },  // Attack / strike
         3: { bd: 'A', fn: 'MFB---' },  // Bomber
         4: { bd: 'A', fn: 'MFC---' },  // Cargo / tanker
         5: { bd: 'A', fn: 'MFS---' },  // ASW / maritime patrol
         6: { bd: 'A', fn: 'MFJ---' },  // Electronic warfare
         7: { bd: 'A', fn: 'MFR---' },  // Reconnaissance
         8: { bd: 'A', fn: 'MFRW--' },  // Surveillance / AEW / C2
        20: { bd: 'A', fn: 'MHA---' },  // Attack helicopter
        21: { bd: 'A', fn: 'MHU---' },  // Utility helicopter
        22: { bd: 'A', fn: 'MHS---' },  // ASW / patrol helicopter
        23: { bd: 'A', fn: 'MHC---' },  // Cargo helicopter
        24: { bd: 'A', fn: 'MHR---' },  // Observation helicopter
        25: { bd: 'A', fn: 'MHM---' },  // SOF helicopter
        40: { bd: 'A', fn: 'MFT---' },  // Trainer
        50: { bd: 'A', fn: 'MFQ---' },  // UAV / unmanned
      },
      3: { // Surface → S
        _: { bd: 'S', fn: '------' },
         0: { bd: 'S', fn: '------' },
         1: { bd: 'S', fn: 'CLCV--' },  // Carrier (CV/CVN)
         2: { bd: 'S', fn: 'CLCC--' },  // Command ship / cruiser
         3: { bd: 'S', fn: 'CLCC--' },  // Guided missile cruiser (CG)
         4: { bd: 'S', fn: 'CLDD--' },  // Guided missile destroyer (DDG)
         5: { bd: 'S', fn: 'CLDD--' },  // Destroyer (DD)
         6: { bd: 'S', fn: 'CLFF--' },  // Guided missile frigate (FFG)
         7: { bd: 'S', fn: 'CPSB--' },  // Light / patrol craft
         8: { bd: 'S', fn: 'CMMS--' },  // Mine countermeasure
         9: { bd: 'S', fn: 'CA----' },  // Dock landing ship (LSD/LPD)
        10: { bd: 'S', fn: 'CALS--' },  // Tank landing ship (LST)
        11: { bd: 'S', fn: 'CALC--' },  // Landing craft (LCU/LCAC)
        14: { bd: 'S', fn: 'CPSB--' },  // Hydrofoil
        16: { bd: 'S', fn: 'NR----' },  // Auxiliary
        17: { bd: 'S', fn: 'NR----' },  // Auxiliary, merchant marine
        50: { bd: 'S', fn: 'CLFF--' },  // Frigate (FF, legacy)
        51: { bd: 'S', fn: 'CL----' },  // Battleship (BB)
        52: { bd: 'S', fn: 'CLCC--' },  // Heavy cruiser (CA)
        53: { bd: 'S', fn: 'NTS---' },  // Destroyer tender (AD)
        54: { bd: 'S', fn: 'CALA--' },  // Amphibious assault ship (LHA/LHD)
        55: { bd: 'S', fn: 'CA----' },  // Amphibious cargo ship (LKA)
        56: { bd: 'S', fn: 'CA----' },  // Amphibious transport dock (LPD)
        57: { bd: 'S', fn: 'NRA---' },  // Ammunition ship (AE)
        58: { bd: 'S', fn: 'NRO---' },  // Combat stores ship (AFS)
        59: { bd: 'S', fn: 'CP----' },  // SURTASS surveillance
        60: { bd: 'S', fn: 'NRO---' },  // Fast combat support (AOE)
        61: { bd: 'S', fn: 'NR----' },  // Non-combatant ship
        62: { bd: 'S', fn: 'CPSB--' },  // Coast Guard cutters
        63: { bd: 'S', fn: 'CPSB--' },  // Coast Guard boats
      },
      4: { // Subsurface → U
        _: { bd: 'U', fn: '------' },
         0: { bd: 'U', fn: '------' },
         1: { bd: 'U', fn: 'SNB---' },  // SSBN (Ohio)
         2: { bd: 'U', fn: 'SNG---' },  // SSGN (converted Ohio)
         3: { bd: 'U', fn: 'SNA---' },  // SSN (Virginia/Seawolf/LA)
         4: { bd: 'U', fn: 'SCG---' },  // SSG conventional guided missile
         5: { bd: 'U', fn: 'SCA---' },  // SS conventional attack
         6: { bd: 'U', fn: 'SNA---' },  // SSAN nuclear auxiliary
         7: { bd: 'U', fn: 'SCA---' },  // SSA conventional auxiliary
      },
      5: { // Space → P
        _: { bd: 'P', fn: '------' },
         0: { bd: 'P', fn: '------' },
         1: { bd: 'P', fn: 'V-----' },  // Manned space vehicle
         2: { bd: 'P', fn: 'S-----' },  // Unmanned / satellite
         3: { bd: 'P', fn: 'L-----' },  // Booster / launch vehicle
      },
    },
    2: { // Munition
      _: { bd: 'A', fn: 'MFQ---' },
      1: { _: { bd: 'G', fn: '------' } },  // Land munition
      2: { _: { bd: 'A', fn: 'MFQ---' } },  // Air munition
      3: { _: { bd: 'S', fn: '------' } },  // Surface munition
      4: { _: { bd: 'U', fn: '------' } },  // Subsurface munition
      5: { _: { bd: 'P', fn: '------' } },  // Space munition
    },
    3: { // Life Form
      _: { bd: 'G', fn: 'UCI---' },
      1: { // Land
        _: { bd: 'G', fn: 'UCI---' },
         0: { bd: 'G', fn: '------' },
         1: { bd: 'G', fn: 'UCI---' },  // Dismounted infantry (visible)
         2: { bd: 'G', fn: 'UCI---' },  // Dismounted infantry (non-visible)
      },
      2: { // Air
        _: { bd: 'A', fn: 'MHA---' },
         1: { bd: 'A', fn: 'MHA---' },  // Parachutist
      },
      3: { _: { bd: 'S', fn: '------' } },  // Surface life form
    },
    4: { _: { bd: 'Z', fn: '------' } },  // Environmental
    8: { _: { bd: 'A', fn: 'MFQ---' } },  // Expendable (decoys/sonobuoys)
    9: { _: { bd: 'G', fn: '------' } },  // Sensor / emitter
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
    const AFF = ['U', 'F', 'H', 'N'];
    const aff = AFF[entity.forceId] ?? 'U';
    const parts = (entity.type || '0.0.0.0.0.0.0').split(/[.\-]/);
    const kind     = +parts[0] || 0;
    const domain   = +parts[1] || 0;
    // parts[2] = country, intentionally skipped
    const category = +parts[3] || 0;
    const entry = lookupSidc(kind, domain, category);
    if (!entry) return null;
    return `S${aff}${entry.bd}P${entry.fn}----*`;
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
      if (best && onEntityClick) onEntityClick(best.key);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const nz = Math.min(80, Math.max(0.02, zoom * factor));
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
      if (best && onEntityClick) onEntityClick(best.key);
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
        const nz = Math.min(80, Math.max(0.02, zoom * factor));
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

    for (const e of lastEntities) {
      if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
      const p = project(e.lat, e.lon);
      if (p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) continue;
      const col = forceColors[e.forceId] || '#c9a227';
      const hdg = (e.heading || 0) * Math.PI / 180;

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

      if (e.key === selectedKey) {
        const t = performance.now();
        const pulse = Math.sin(t / 300) * 0.5 + 0.5;
        const pr = 14 + pulse * 6;
        ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(255,255,255,${0.45 + pulse * 0.45})`;
        ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y, pr + 5, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(47,129,247,${0.25 + pulse * 0.35})`;
        ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.fillStyle = '#c7d0da'; ctx.font = '10px system-ui';
      ctx.fillText(e.marking || '', p.x + 8, p.y + 3);
    }

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
  }

  function setSelected(key) {
    selectedKey = key;
    if (key) {
      const e = lastEntities.find(x => x.key === key);
      if (e && isFinite(e.lat) && isFinite(e.lon)) {
        if (useTiles && leaflet) {
          leaflet.panTo([e.lat, e.lon]);
        } else if (canvas) {
          const b = bounds(lastEntities) || WORLD;
          const w = canvas.width, h = canvas.height;
          const { mapW: sMapW, mapH: sMapH, ox: sOx, oy: sOy } = projGeo(b, w, h);
          const relX = ((e.lon - b.minLon) / (b.maxLon - b.minLon) * sMapW + sOx) * zoom;
          const relY = ((1 - (e.lat - b.minLat) / (b.maxLat - b.minLat)) * sMapH + sOy) * zoom;
          panX = w / 2 - relX;
          panY = h / 2 - relY;
        }
      }
    }
    if (useTiles) {
      updateLeaflet();
    } else {
      if (key && !animFrame) startSelectionAnim();
      else if (!key && animFrame) { cancelAnimationFrame(animFrame); animFrame = null; draw(); }
      else draw();
    }
  }

  function startSelectionAnim() {
    function tick() {
      if (!selectedKey || useTiles) { animFrame = null; return; }
      draw();
      animFrame = requestAnimationFrame(tick);
    }
    animFrame = requestAnimationFrame(tick);
  }

  function update(entities) {
    lastEntities = entities || [];
    if (useTiles && leaflet) updateLeaflet();
    else draw();
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

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateLeaflet(entities) {
    if (!leaflet) return;
    const list = entities || lastEntities || [];
    const seen = new Set();
    for (const e of list) {
      if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
      seen.add(e.key);
      const col = forceColors[e.forceId] || '#c9a227';
      let m = markers.get(e.key);
      const label = escapeHtml(e.marking || e.key);
      const isSelected = e.key === selectedKey;
      const milIcon = makeMilIcon(e);

      if (!m) {
        if (milIcon) {
          m = window.L.marker([e.lat, e.lon], { icon: milIcon });
        } else {
          m = window.L.circleMarker([e.lat, e.lon], { radius: isSelected ? 10 : 6, color: isSelected ? '#ffffff' : col, fillColor: col, fillOpacity: 0.8, weight: isSelected ? 3 : 1 });
        }
        m.addTo(leaflet); markers.set(e.key, m);
        m.bindTooltip(label, { permanent: false, sticky: true });
        m.on('click', () => { if (onEntityClick) onEntityClick(e.key); });
      } else {
        // If milsymbol just became available, switch marker type
        const isMilMarker = !m.setStyle;
        if (milIcon && !isMilMarker) {
          leaflet.removeLayer(m);
          m = window.L.marker([e.lat, e.lon], { icon: milIcon });
          m.addTo(leaflet); markers.set(e.key, m);
          m.bindTooltip(label, { permanent: false, sticky: true });
          m.on('click', () => { if (onEntityClick) onEntityClick(e.key); });
        } else {
          m.setLatLng([e.lat, e.lon]);
          if (milIcon) {
            m.setIcon(milIcon);
          } else if (m.setStyle) {
            m.setStyle({ color: isSelected ? '#ffffff' : col, fillColor: col, weight: isSelected ? 3 : 1 });
            m.setRadius(isSelected ? 10 : 6);
          }
          if (m.getTooltip()?.getContent() !== label) m.setTooltipContent(label);
        }
      }
    }
    for (const [k, m] of markers) {
      if (!seen.has(k)) { leaflet.removeLayer(m); markers.delete(k); }
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
          window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18, attribution: '© OpenStreetMap',
          }).addTo(leaflet);
        }
        setTimeout(() => leaflet.invalidateSize(), 100);
        const b = bounds(lastEntities);
        if (b) leaflet.fitBounds([[b.minLat, b.minLon], [b.maxLat, b.maxLon]]);
        updateLeaflet();
        if (infoEl) infoEl.textContent = 'online tiles';
      } catch (err) {
        console.error('Leaflet tile error:', err);
        useTiles = false;
        if (infoEl) infoEl.textContent = 'tiles unavailable — offline view';
        canvas.classList.remove('hidden'); leafletEl.classList.add('hidden');
        draw();
      }
    } else {
      leafletEl.classList.add('hidden');
      canvas.classList.remove('hidden');
      if (infoEl) infoEl.textContent = 'offline canvas';
      draw();
    }
  }

  function triggerResize() {
    resize();
    if (useTiles && leaflet) leaflet.invalidateSize();
    else draw();
  }

  return { init, update, setTiles, resetView, setSelected, setSymbolSize, entityToSidc, resize: triggerResize };
})();

window.MapView = MapView;
