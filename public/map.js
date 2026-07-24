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

  // DIS kind.domain → [battleDimension, functionId(6 chars)]
  // Full 2525C SIDC = S + aff(1) + bd(1) + P + fn(6) + ----* = 15 chars
  const SIDC_MAP = {
    '1.1': ['G', 'UCFV--'],  // Platform/Land → armored vehicle
    '1.2': ['A', 'MFFW--'],  // Platform/Air → fixed wing
    '1.3': ['S', 'XM----'],  // Platform/Surface → ship
    '1.4': ['U', 'SS----'],  // Platform/Subsurface → submarine
    '1.5': ['P', 'V-----'],  // Platform/Space
    '2.1': ['G', 'WMS---'],  // Munition/Land
    '2.2': ['A', 'WMA---'],  // Munition/Air
    '3.1': ['G', 'UCI---'],  // LifeForm/Land → infantry
    '3.2': ['A', 'MFH---'],  // LifeForm/Air → helicopter
    '3.3': ['S', 'UCI---'],  // LifeForm/Surface
  };

  function entityToSidc(entity) {
    if (!window.ms) return null;
    const AFF = ['U', 'F', 'H', 'N'];
    const aff = AFF[entity.forceId] ?? 'U';
    const parts = (entity.type || '0.0.0.0.0.0.0').split(/[.\-]/);
    const kind = +parts[0] || 0;
    const domain = +parts[1] || 0;
    const [bd, fn] = SIDC_MAP[`${kind}.${domain}`] || ['Z', '------'];
    return `S${aff}${bd}P${fn}----*`;
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
    window.addEventListener('resize', () => { resize(); draw(); });

    canvas.addEventListener('click', (e) => {
      if (useTiles) return;
      if (Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY) > 5) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const b = bounds(lastEntities) || WORLD;
      const w = canvas.width, h = canvas.height;
      const proj = (lat, lon) => ({
        x: (((lon - b.minLon) / (b.maxLon - b.minLon)) * w) * zoom + panX,
        y: ((1 - (lat - b.minLat) / (b.maxLat - b.minLat)) * h) * zoom + panY,
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
      let nearEntity = false;
      for (const ent of lastEntities) {
        if (!isFinite(ent.lat) || !isFinite(ent.lon)) continue;
        const px = (((ent.lon - b.minLon) / (b.maxLon - b.minLon)) * w) * zoom + panX;
        const py = ((1 - (ent.lat - b.minLat) / (b.maxLat - b.minLat)) * h) * zoom + panY;
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

  function draw() {
    if (useTiles) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const hasEntities = lastEntities.some((e) => isFinite(e.lat) && isFinite(e.lon));
    const b = bounds(lastEntities) || WORLD;

    const project = (lat, lon) => ({
      x: (((lon - b.minLon) / (b.maxLon - b.minLon)) * w) * zoom + panX,
      y: ((1 - (lat - b.minLat) / (b.maxLat - b.minLat)) * h) * zoom + panY,
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
      ctx.fillText('scroll to zoom · drag to pan · dbl-click to reset', 4, h - 18);
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
          const relX = ((e.lon - b.minLon) / (b.maxLon - b.minLon)) * w * zoom;
          const relY = (1 - (e.lat - b.minLat) / (b.maxLat - b.minLat)) * h * zoom;
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

  function updateLeaflet() {
    const seen = new Set();
    for (const e of lastEntities) {
      if (!isFinite(e.lat) || !isFinite(e.lon)) continue;
      seen.add(e.key);
      const col = forceColors[e.forceId] || '#c9a227';
      let m = markers.get(e.key);
      const label = e.marking || e.key;
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
      } catch {
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
