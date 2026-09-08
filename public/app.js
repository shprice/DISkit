// Web UI controller: WebSocket link to the server, control commands, and live
// rendering of stats, entity table, emitter table, PDU-type chart and feed.

const DIS_VERSIONS = {
  4: 'IEEE 1278-1993',
  5: 'IEEE 1278.1-1995',
  6: 'IEEE 1278.1a-1998',
  7: 'IEEE 1278.1-2012',
};

const DR_ALGORITHM = {
  0:'Other', 1:'Static', 2:'Fixed Rate (world)', 3:'Fixed Rate+Vel (world)',
  4:'Vel+Acc (world)', 5:'Fixed Pos (body)', 6:'Fixed Rate (body)',
  7:'Fixed Rate+Vel (body)', 8:'Vel+Acc (body)', 9:'Quaternion',
};
const MARKING_CHARSET = { 0:'Unused', 1:'ASCII', 2:'Army Marking', 3:'Digit Chevron' };

const PDU_TYPES = {
  1: 'EntityState', 2: 'Fire', 3: 'Detonation', 4: 'Collision',
  11: 'CreateEntity', 12: 'RemoveEntity', 13: 'StartResume', 14: 'StopFreeze',
  15: 'Acknowledge', 16: 'ActionRequest', 17: 'ActionResponse', 18: 'DataQuery',
  19: 'SetData', 20: 'Data', 21: 'EventReport', 22: 'Comment',
  23: 'ElectromagneticEmission', 24: 'Designator', 25: 'Transmitter',
  26: 'Signal', 27: 'Receiver', 28: 'IFF', 41: 'EnvironmentalProcess',
};
const FORCE = { 0: 'Other', 1: 'Friendly', 2: 'Opposing', 3: 'Neutral' };
const PIE_COLORS = ['#2f81f7', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39c5cf',
  '#db61a2', '#e3b341', '#6e7681', '#ff7b72', '#56d364', '#79c0ff'];

const pieHitData = {};

// SISO-STD-010 enumeration lookups, lazily loaded from dis-enums.json
let disEnums = null;
fetch('dis-enums.json')
  .then(r => r.ok ? r.json() : {})
  .then(d => { disEnums = d; })
  .catch(() => {});

function lookupEntityType(typeStr) {
  if (!disEnums || !typeStr) return null;
  const parts = typeStr.split(/[.\-]/);
  if (parts.length < 3) return null;
  const [k, d, c, cat, sub, spec] = parts.map(p => parseInt(p) || 0);
  const labels = [];
  if (disEnums.kinds?.[k]) labels.push(disEnums.kinds[k]);
  if (disEnums.domains?.[`${k}.${d}`]) labels.push(disEnums.domains[`${k}.${d}`]);
  if (disEnums.countries?.[c]) labels.push(disEnums.countries[c]);
  const ET = disEnums.et;
  if (cat && ET?.[`${k}.${d}.${c}.${cat}`]) labels.push(ET[`${k}.${d}.${c}.${cat}`]);
  if (sub && ET?.[`${k}.${d}.${c}.${cat}.${sub}`]) labels.push(ET[`${k}.${d}.${c}.${cat}.${sub}`]);
  if (spec && ET?.[`${k}.${d}.${c}.${cat}.${sub}.${spec}`]) labels.push(ET[`${k}.${d}.${c}.${cat}.${sub}.${spec}`]);
  return labels.length ? labels.join(' / ') : null;
}

let ws;
let logs = [];
let appMode = 'idle';
let pendingSeek = null;       // offsetMicros to seek to once replay starts
let playerState = 'idle';     // last reported replay state (playing|paused|stopped)
let replayBookmarks = [];     // bookmarks of the loaded/selected replay log
let replayDurationMs = 0;     // duration of the selected replay log
let selectedKey = null;
let selectedType = null;      // 'entity' | 'emitter' | 'fire' | 'detonation' | ...
let isLocalHost = false;
let lastStats = null;
let lastDetailsSerial = null; // skip detail re-render when data is unchanged
let firesRowData = new Map();  // _origIdx -> fire object snapshotted at render time
let detsRowData = new Map();   // _origIdx -> detonation object snapshotted at render time
const sidcSvgCache = new Map(); // SIDC string → SVG string (keyed by full 20-char SIDC)
let entityTimeoutMs = 10000;  // from config.entityTimeoutSecs; amber at ½, red at full
let siteNames = {};  // { "100": "Site A" }
let appNames = {};   // { "1": "Blue Force" }
let renderSiteAppNamesTable = null; // assigned in init(); called from handle() on hello
const dataRateHistory = [];
const pduRateHistory = [];
const activeAudioKeys = new Map(); // key → timeout id
let seenDetTs = null;  // null = not yet initialised (first renderStats call seeds it without animating)
const tableState = {}; // tableId -> { sortCol: null|number, sortDir: 1|-1, filter: string }
const RATE_HISTORY_MAX = 240;

const MAP_SETTINGS_KEY = 'diskit-map-settings';
function saveMapSettings() {
  const s = {
    tiles: $('mapTiles')?.checked ?? false,
    satellite: $('mapSatellite')?.checked ?? false,
    follow: $('mapFollow')?.checked ?? false,
    directions: $('mapDirections')?.checked ?? false,
    dr: $('mapDR')?.checked ?? false,
    both: $('mapBoth')?.checked ?? false,
    history: $('mapHistory')?.checked ?? false,
    historyLength: +($('historyLength')?.value ?? 100),
    historyColor: $('historyColor')?.value ?? '#f0c674',
    symScale: +($('symScale')?.value ?? 28),
    munitions: $('mapShowMunitions')?.checked ?? true,
    designations: $('mapShowDesignations')?.checked ?? true,
    detonations: $('mapShowDetonations')?.checked ?? true,
    forceFilter: Array.from(document.querySelectorAll('.force-btn.active')).map(b => +b.dataset.force),
  };
  try { localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(s)); } catch {}
}
function loadMapSettings() {
  try { return JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY) || 'null'); } catch { return null; }
}

function $(id) { return document.getElementById(id); }

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const f = parseAudioFrame(ev.data);
      if (f) {
        if (!window._audioDiagDone) {
          window._audioDiagDone = true;
          const s = Array.from(f.pcm.slice(0, 8)).join(', ');
          console.log(`[audio] key=${f.key} sampleRate=${f.sampleRate} samples=${f.pcm.length} first8=[${s}]`);
        }
        window.AudioMgr?.ingestFrame(f.key, f.sampleRate, f.pcm);
        markAudioActive(f.key);
      }
      return;
    }
    try { handle(JSON.parse(ev.data)); } catch (err) { console.error('WS error:', err); }
  };
}
function setConn(on) {
  const b = $('conn');
  b.textContent = on ? 'connected' : 'disconnected';
  b.className = 'badge ' + (on ? 'on' : 'off');
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---- multi-select dropdowns ------------------------------------------------
function buildMultiselect(el, items, summary, labelFn) {
  el.className = 'multiselect';
  el.innerHTML = '';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'ms-btn';
  const panel = document.createElement('div');
  panel.className = 'ms-panel';
  const allLbl = document.createElement('label');
  allLbl.className = 'ms-all';
  allLbl.innerHTML = '<input type="checkbox" class="ms-master" checked> All';
  panel.appendChild(allLbl);
  const sep = document.createElement('hr'); sep.className = 'ms-sep';
  panel.appendChild(sep);
  for (const [val, name] of Object.entries(items)) {
    const lbl = document.createElement('label');
    const text = labelFn ? labelFn(val, name) : `${val} — ${name}`;
    lbl.innerHTML = `<input type="checkbox" value="${val}" checked> ${text}`;
    panel.appendChild(lbl);
  }
  el.appendChild(btn); el.appendChild(panel);
  const master = panel.querySelector('.ms-master');
  function syncSummary() {
    const boxes = [...panel.querySelectorAll('input[value]')];
    const n = boxes.filter(b => b.checked).length;
    master.checked = n === boxes.length; master.indeterminate = n > 0 && n < boxes.length;
    btn.textContent = (n === boxes.length ? summary : `${n}/${boxes.length}`) + ' ▾';
  }
  master.addEventListener('change', () => { panel.querySelectorAll('input[value]').forEach(c => c.checked = master.checked); syncSummary(); });
  panel.addEventListener('change', (e) => { if (e.target !== master) syncSummary(); });
  btn.addEventListener('click', (e) => { e.stopPropagation(); document.querySelectorAll('.multiselect.open').forEach(o => { if (o !== el) o.classList.remove('open'); }); el.classList.toggle('open'); });
  syncSummary();
}

// Ticked types are the ones to log/send. If every box is ticked we send [] so
// the server treats it as "no restriction" (also covers PDU types not listed).
function filterPayload(el) {
  const boxes = [...el.querySelectorAll('input[value]')];
  const checked = boxes.filter((b) => b.checked).map((b) => Number(b.value));
  return checked.length === boxes.length ? [] : checked;
}

function parseIdList(str) {
  return (str || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

// ---- network adapter dropdown ----------------------------------------------
function populateAdapters(adapters, selected) {
  const sel = $('capBind');
  sel.innerHTML = '';
  for (const { label, address } of adapters) {
    const opt = document.createElement('option');
    opt.value = address;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  sel.value = selected || '0.0.0.0';
  if (!sel.value) sel.value = '0.0.0.0';
}

// ---- incoming messages -----------------------------------------------------
function handle(m) {
  switch (m.kind) {
    case 'hello':
      if (m.version) { const vEl = $('appVersion'); if (vEl) { vEl.textContent = m.version; vEl.classList.remove('hidden'); } }
      if (m.networkAdapters) populateAdapters(m.networkAdapters, m.config?.capture?.bindAddress);
      applyConfig(m.config); $('recDir').value = m.recordDir || ''; $('browseDir').value = m.browseDir || '';
      if (m.config?.entityTimeoutSecs) {
        entityTimeoutMs = m.config.entityTimeoutSecs * 1000;
        if ($('entityTimeoutSecs')) $('entityTimeoutSecs').value = m.config.entityTimeoutSecs;
      }
      if (m.config?.siteNames) { siteNames = m.config.siteNames; }
      if (m.config?.appNames)  { appNames  = m.config.appNames;  }
      if (typeof renderSiteAppNamesTable === 'function') renderSiteAppNamesTable();
      if (typeof m.isLocal === 'boolean') { isLocalHost = m.isLocal; applyHostVisibility(); }
      logs = m.logs || []; renderLogs(); setMode(m.mode); setRecording(m.recording, m.recordStartMs); break;
    case 'config':
      if (m.entityTimeoutSecs) {
        entityTimeoutMs = m.entityTimeoutSecs * 1000;
        if ($('entityTimeoutSecs')) $('entityTimeoutSecs').value = m.entityTimeoutSecs;
      }
      if (m.siteNames !== undefined) { siteNames = m.siteNames; if (typeof renderSiteAppNamesTable === 'function') renderSiteAppNamesTable(); }
      if (m.appNames  !== undefined) { appNames  = m.appNames;  if (typeof renderSiteAppNamesTable === 'function') renderSiteAppNamesTable(); }
      break;
    case 'stats':
      setMode(m.mode); setRecording(m.recording, m.recordStartMs, m.recordBytes);
      renderRecTimeline(m.recording, m.recordStartMs, m.bookmarks, m.recordBytes);
      renderStats(m.stats); renderFeed(m.samples); break;
    case 'status':
      setMode(m.mode);
      if (m.mode === 'replaying' && m.meta) { replayBookmarks = m.meta.bookmarks || []; replayDurationMs = m.meta.durationMs || 0; renderReplayMarks(); }
      if (m.mode === 'replaying' && pendingSeek != null) { send({ cmd: 'seek', offsetMicros: pendingSeek }); pendingSeek = null; }
      if (m.message) toast(m.message); break;
    case 'progress': renderProgress(m.progress); break;
    case 'bookmarkAdded':
      toast(`Bookmarked: ${m.bookmark?.label || ''}`);
      $('bmLabel').value = '';
      if ($('repBmLabel')) $('repBmLabel').value = '';
      if (m.bookmarks) {
        replayBookmarks = m.bookmarks;
        renderReplayMarks();
      }
      break;
    case 'dirs':
      if (m.recordDir) $('recDir').value = m.recordDir;
      if (m.browseDir) $('browseDir').value = m.browseDir;
      if (m.message) toast(m.message); break;
    case 'logs':
      logs = m.logs || []; if (m.browseDir) $('browseDir').value = m.browseDir; renderLogs(); break;
    case 'recordingStopped':
      toast(`Saved ${m.result?.records || 0} records`); send({ cmd: 'listLogs' }); break;
    case 'replayEnded':
      setMode('idle');
      toast(`Replay finished (${m.sentCount} PDUs, ${m.loops} loops)`);
      break;
    case 'pcapExported': toast(`Exported ${m.file} (${m.packets} packets)`); break;
    case 'versionWarning': {
      const badge = $('verWarnBadge');
      badge.classList.remove('hidden');
      toast(`⚠ PDU type ${m.pduType} (${m.pduTypeName}) not defined until DIS v${m.minVersion} — replayed as v${m.targetVersion} anyway`);
      break;
    }
    case 'error': toast('⚠ ' + m.message); break;
  }
}

function applyConfig(c) {
  if (!c) return;
  if (c.entityTimeoutSecs) entityTimeoutMs = c.entityTimeoutSecs * 1000;
  $('capPort').value = c.capture.port;
  $('capGroup').value = c.capture.multicastGroup;
  const sel = $('capBind');
  const addr = c.capture.bindAddress || '0.0.0.0';
  if (![...sel.options].some(o => o.value === addr)) {
    const opt = document.createElement('option');
    opt.value = addr; opt.textContent = addr;
    sel.appendChild(opt);
  }
  sel.value = addr;
  $('repDest').value = c.replay.destAddress;
  $('repPort').value = c.replay.destPort || 3000;
}

function setMode(mode) {
  const prevMode = appMode;
  appMode = mode;
  const badge = $('modeBadge');
  const wasReplayingBadge = badge.classList.contains('replaying');
  badge.className = 'badge ' + mode;
  if (mode === 'replaying') {
    if (!wasReplayingBadge) badge.innerHTML = '<span class="spinner"></span>replaying';
  } else {
    badge.textContent = mode;
  }
  if (mode !== 'replaying') {
    playerState = 'idle';
    $('btnPause').textContent = '⏸ Pause';
    if ($('progBar')) $('progBar').style.width = '0%';
    if ($('progText')) $('progText').textContent = '';
  }
  if (prevMode === 'replaying' && mode === 'idle') {
    window.MapView?.update([]);
    selectedKey = null; selectedType = null;
    window.MapView?.setSelected(null);
    const dc = $('detailsContent');
    if (dc) dc.innerHTML = '<span class="hint">Select an entity or emitter</span>';
    if ($('progBar')) $('progBar').style.width = '0%';
    if ($('progText')) $('progText').textContent = '';
  }
  const listening = mode === 'capturing';
  $('btnListen').textContent = listening ? '◉ Listening…' : 'Start Listening';
  $('btnListen').className   = listening ? 'active' : 'primary';
  const btnPlay = $('btnPlay');
  const wasReplaying = btnPlay.classList.contains('active');
  if (mode === 'replaying') {
    btnPlay.className = 'active';
    if (!wasReplaying) btnPlay.innerHTML = '<span class="spinner"></span>Playing…';
  } else {
    btnPlay.textContent = '▶ Play';
    btnPlay.className = 'primary';
  }
}

function setRecording(on, startMs, bytes) {
  const badge = $('recBadge');
  badge.classList.toggle('hidden', !on);
  if (on) $('recText').textContent = `REC ${hms(Date.now() - (startMs || Date.now()))} · ${fmtBytes(bytes)}`;
  const btn = $('btnRecord');
  const wasRec = btn.classList.contains('is-recording');
  btn.disabled = !!on;
  btn.classList.toggle('is-recording', !!on);
  if (on && !wasRec) {
    btn.innerHTML = '<span class="rec-dot"></span>Recording…';
  } else if (!on) {
    btn.textContent = '● Record';
  }
  $('btnStopRecord').disabled = !on;
  $('btnBookmark').disabled = !on;
  $('bmLabel').disabled = !on;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function parseAudioFrame(ab) {
  if (!(ab instanceof ArrayBuffer) || ab.byteLength < 10) return null;
  const v = new DataView(ab);
  if (v.getUint8(0) !== 0x02) return null;
  const seq = v.getUint32(1, false);
  const sampleRate = v.getUint16(5, false);
  const keyLen = v.getUint16(7, false);
  if (ab.byteLength < 9 + keyLen + 2) return null;
  const key = new TextDecoder().decode(new Uint8Array(ab, 9, keyLen));
  const pcmOffset = 9 + keyLen;
  const pcm = new Int16Array(ab.slice(pcmOffset));
  return { seq, sampleRate, key, pcm };
}

function fmtBytes(b) {
  if (!b) return '0 KB';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Render bookmark ticks into a marks layer. onSeek (if given) makes them clickable.
function renderMarks(containerId, bookmarks, totalMs, onSeek) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (!bookmarks || !bookmarks.length || !totalMs) return;
  bookmarks.forEach((b) => {
    const offMs = b.offsetMicros / 1000;
    const pct = Math.max(0, Math.min(100, (offMs / totalMs) * 100));
    const mark = document.createElement('div');
    mark.className = 'tl-mark';
    mark.style.left = pct + '%';
    mark.innerHTML = `<span class="tl-tip">${escapeHtml(b.label)} · ${(offMs / 1000).toFixed(1)}s</span>`;
    if (onSeek) mark.onclick = (e) => { e.stopPropagation(); onSeek(b.offsetMicros); };
    el.appendChild(mark);
  });
}

// Live recording timeline: full bar = recorded so far, marks at bookmark times.
function renderRecTimeline(recording, startMs, bookmarks, bytes) {
  if (!recording) {
    $('recTlFill').style.width = '0%';
    renderMarks('recTlMarks', [], 0);
    $('recTlTime').textContent = '00:00:00';
    return;
  }
  const elapsed = Date.now() - (startMs || Date.now());
  $('recTlFill').style.width = '100%';
  const n = bookmarks ? bookmarks.length : 0;
  $('recTlTime').textContent =
    `${hms(elapsed)} · ${fmtBytes(bytes)}${n ? ` · ${n} bookmark${n > 1 ? 's' : ''}` : ''}`;
  renderMarks('recTlMarks', bookmarks, elapsed);
}

function renderReplayMarks() {
  renderMarks('repTlMarks', replayBookmarks, replayDurationMs, seekToOffset);
}

// Jump playback to an offset; if not currently replaying, start it then seek.
function seekToOffset(offsetMicros) {
  if (appMode === 'replaying') {
    send({ cmd: 'seek', offsetMicros });
  } else {
    pendingSeek = offsetMicros;
    doPlay();
  }
}

function hms(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ---- rendering -------------------------------------------------------------
function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function unCamel(s) { return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'); }

function getTableState(id) {
  if (!tableState[id]) tableState[id] = { sortCol: null, sortDir: 1, filter: '' };
  return tableState[id];
}

function applyTableState(data, cols, id) {
  const st = getTableState(id);
  let rows = data;
  if (st.filter) {
    const f = st.filter.toLowerCase();
    rows = rows.filter(r => cols.some(a => String(a(r) ?? '').toLowerCase().includes(f)));
  }
  if (st.sortCol !== null && cols[st.sortCol]) {
    const acc = cols[st.sortCol];
    rows = [...rows].sort((a, b) => {
      const va = acc(a), vb = acc(b);
      if (va == null && vb == null) return 0;
      if (va == null) return st.sortDir;
      if (vb == null) return -st.sortDir;
      if (typeof va === 'string') return va.localeCompare(vb) * st.sortDir;
      return (va < vb ? -1 : va > vb ? 1 : 0) * st.sortDir;
    });
  }
  return rows;
}

function updateSortIndicators(tableId) {
  const st = getTableState(tableId);
  const table = $(tableId);
  if (!table) return;
  table.querySelectorAll('th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (+th.dataset.col === st.sortCol) th.classList.add(st.sortDir === 1 ? 'sort-asc' : 'sort-desc');
  });
}

function renderStats(s) {
  if (!s) return;
  $('mPdus').textContent = fmt(s.totalPdus);
  $('mRate').textContent = s.pduRate;
  $('mEntities').textContent = s.entityCount;
  $('mBytes').textContent = fmtBytes(s.totalBytes);

  pduRateHistory.push(s.pduRate || 0);
  if (pduRateHistory.length > RATE_HISTORY_MAX) pduRateHistory.shift();
  drawSparkline('pduRateGraph', pduRateHistory);

  const bitsPerSec = (s.byteRate || 0) * 8;
  dataRateHistory.push(bitsPerSec);
  if (dataRateHistory.length > RATE_HISTORY_MAX) dataRateHistory.shift();
  const maxBits = Math.max(...dataRateHistory, 0);
  const useMb = maxBits >= 1e6;
  $('mDataRate').textContent = useMb ? (bitsPerSec / 1e6).toFixed(3) : (bitsPerSec / 1e3).toFixed(1);
  $('mDataRateUnit').textContent = useMb ? 'Mb/s' : 'kb/s';
  drawSparkline('dataRateGraph', dataRateHistory);

  drawPie('pieChart', (s.types || []).map(t => ({ count: t.count, label: unCamel(t.name) })), 'PDUs');
  drawPie('sitePie', (s.sites || []).map(x => ({ count: x.count, label: `Site ${x.id}` })), 'Sites', (s.sites||[]).length);
  drawPie('appPie',  (s.apps  || []).map(x => ({ count: x.count, label: `App ${x.id}` })), 'Apps', (s.apps||[]).length);

  const entityCols = [
    e => e.marking || e.key || '',
    e => e.force || '',
    e => e.kind || '',
    e => siteNames[String(e.siteId)] || String(e.siteId ?? ''),
    e => appNames[String(e.appId)] || String(e.appId ?? ''),
    e => e.alt ?? 0,
    e => e.heading ?? 0,
    e => e.speed ?? 0,
  ];
  const sortedEntities = applyTableState(s.entities || [], entityCols, 'entityTable');
  const eb = $('entityTable').querySelector('tbody');
  const nowMs = Date.now();
  eb.innerHTML = sortedEntities.map((e) => {
    let iconHtml;
    if (window.ms && window.MapView?.entityToSidc) {
      try {
        const sidc = window.MapView.entityToSidc(e);
        if (sidc) {
          if (!sidcSvgCache.has(sidc)) sidcSvgCache.set(sidc, new window.ms.Symbol(sidc, { size: 20 }).asSVG());
          iconHtml = `<span class="entity-list-icon">${sidcSvgCache.get(sidc)}</span>`;
        }
      } catch {}
    }
    iconHtml ??= `<span class="dot f${e.forceId}"></span>`;
    const ageMs = nowMs - (e.lastSeen || 0);
    const staleClass = ageMs >= entityTimeoutMs     ? ' stale-red'
                     : ageMs >= entityTimeoutMs / 2 ? ' stale-amber'
                     : '';
    return `
    <tr data-key="${escapeHtml(e.key)}"${staleClass ? ` class="${staleClass.trim()}"` : ''}>
      <td>${iconHtml}${escapeHtml(e.marking) || ''}</td>
      <td>${escapeHtml(e.force) || ''}</td><td>${escapeHtml(e.kind) || ''}</td>
      <td>${siteNames[String(e.siteId)] ? `<span title="Site ${e.siteId}">${escapeHtml(siteNames[String(e.siteId)])}</span>` : (e.siteId ?? '')}</td><td>${appNames[String(e.appId)] ? `<span title="App ${e.appId}">${escapeHtml(appNames[String(e.appId)])}</span>` : (e.appId ?? '')}</td>
      <td>${fnum(e.alt, 0)}</td><td>${fnum(e.heading, 0)}</td><td>${fnum(e.speed, 0)}</td>
    </tr>`;
  }).join('');

  const emitterCols = [
    r => r.entity || '',
    r => String(r.emitterName ?? r.emitter ?? ''),
    r => r.beamFunction || r['function'] || '',
    r => r.band || '',
    r => r.freqMHz ?? 0,
    r => r.prf ?? 0,
    r => r.erp ?? 0,
  ];
  const sortedEmitters = applyTableState(s.emitters || [], emitterCols, 'emitterTable');
  const mb = $('emitterTable').querySelector('tbody');
  mb.innerHTML = sortedEmitters.map((r) => `
    <tr data-key="${escapeHtml(r._key || r.entity + '|' + (r.emitter || ''))}">
      <td>${escapeHtml(r.entity)}</td><td>${escapeHtml(String(r.emitterName ?? r.emitter ?? ''))}</td>
      <td>${escapeHtml(r.beamFunction || r['function'] || '')}</td>
      <td>${escapeHtml(r.band || '')}</td><td>${ffreq(r.freqMHz)}</td><td>${frate(r.prf)}</td><td>${r.erp != null ? r.erp + ' dBm' : '—'}</td>
    </tr>`).join('');

  const txb = $('txTableBody');
  const txCols = [
    t => t.entityKey || '',
    t => t.radioId ?? 0,
    t => t.txStateName || '',
    t => t.freqMHz ?? 0,
    t => t.band || '',
    t => t.power ?? 0,
  ];
  if (txb) {
    txb.innerHTML = applyTableState(s.transmitters || [], txCols, 'txTable').map(t => `
      <tr data-key="${escapeHtml(t._key)}"${t.txState === 2 ? ' class="tx-active"' : ''}>
        <td>${escapeHtml(t.entityKey)}</td><td>${t.radioId}</td>
        <td>${escapeHtml(t.txStateName)}</td><td>${ffreq(t.freqMHz)}</td>
        <td>${escapeHtml(t.band || '—')}</td><td>${t.power != null ? t.power + ' dBm' : '—'}</td>
      </tr>`).join('');
  }
  const rxCols = [
    r => r.entityIdKey || '',
    r => r.radioId ?? 0,
    r => r.receiverStateName || '',
    r => r.receivedPower ?? 0,
    r => r.transmitterEntityKey || '',
    r => r.transmitterRadioId ?? 0,
  ];
  const rxb = $('rxTableBody');
  if (rxb) {
    rxb.innerHTML = applyTableState(s.receivers || [], rxCols, 'rxTable').map(r => `
      <tr data-key="${escapeHtml(r._key)}"${r.receiverState === 2 ? ' class="rx-active"' : ''}>
        <td>${escapeHtml(r.entityIdKey)}</td><td>${r.radioId}</td>
        <td>${escapeHtml(r.receiverStateName)}</td>
        <td>${r.receivedPower != null ? r.receivedPower + ' dBm' : '—'}</td>
        <td>${escapeHtml(r.transmitterEntityKey || '—')}</td><td>${r.transmitterRadioId ?? '—'}</td>
      </tr>`).join('');
  }

  const sigCols = [
    sg => sg.entityIdKey || '',
    sg => sg.radioId ?? 0,
    sg => sg.encodingClassName || '',
    sg => sg.tdlTypeName || '',
    sg => sg.sampleRate ?? 0,
    sg => sg.dataLengthBits ?? 0,
  ];
  const sigb = $('sigTableBody');
  if (sigb) {
    sigb.innerHTML = applyTableState(s.signals || [], sigCols, 'sigTable').map(sg => {
      const isAudio = sg.encodingClass === 0;
      const active = activeAudioKeys.has(sg._key) || (sg.lastSeen && Date.now() - sg.lastSeen < 2500);
      const gearCell = isAudio
        ? `<td><button class="audio-gear-btn mini" data-key="${escapeHtml(sg._key)}" title="Audio settings">⚙</button></td>`
        : '<td></td>';
      return `<tr data-key="${escapeHtml(sg._key)}"${active ? ' class="sig-active"' : ''}>
        <td>${escapeHtml(sg.entityIdKey)}</td><td>${sg.radioId}</td>
        <td>${escapeHtml(sg.encodingClassName || '—')}</td>
        <td>${escapeHtml(sg.tdlTypeName || '—')}</td>
        <td>${frate(sg.sampleRate)}</td><td>${sg.dataLengthBits || 0} bits</td>${gearCell}
      </tr>`;
    }).join('');
  }

  const icCtrlCols = [
    ic => ic.sourceEntityKey || '',
    ic => ic.sourceDeviceId ?? 0,
    ic => ic.sourceLineId ?? 0,
    ic => ic.transmitLineState ?? 0,
    ic => ic.controlTypeName || '',
    ic => ic.commandName || '',
    ic => ic.transmitPriority ?? 0,
  ];
  const icctrlb = $('icCtrlTableBody');
  if (icctrlb) {
    icctrlb.innerHTML = applyTableState(s.intercomControls || [], icCtrlCols, 'icCtrlTable').map(ic => `
      <tr data-key="${escapeHtml(ic._key)}"${ic.transmitLineState === 1 ? ' class="ic-ctrl-active"' : ''}>
        <td>${escapeHtml(ic.sourceEntityKey)}</td><td>${ic.sourceDeviceId}</td>
        <td>${ic.sourceLineId}</td>
        <td>${ic.transmitLineState === 1 ? 'Transmitting' : 'Idle'}</td>
        <td>${escapeHtml(ic.controlTypeName)}</td><td>${escapeHtml(ic.commandName)}</td>
        <td>${ic.transmitPriority}</td>
      </tr>`).join('');
  }
  const icSigCols = [
    ic => ic.entityIdKey || '',
    ic => ic.deviceId ?? 0,
    ic => ic.encodingClassName || '',
    ic => ic.tdlTypeName || '',
    ic => ic.sampleRate ?? 0,
    ic => ic.dataLengthBits ?? 0,
  ];
  const icsigb = $('icSigTableBody');
  if (icsigb) {
    icsigb.innerHTML = applyTableState(s.intercomSignals || [], icSigCols, 'icSigTable').map(ic => {
      const isAudio = ic.encodingClass === 0;
      const active  = activeAudioKeys.has(ic._key) || (ic.lastSeen && Date.now() - ic.lastSeen < 2500);
      const gearCell = isAudio
        ? `<td><button class="audio-gear-btn mini" data-key="${escapeHtml(ic._key)}" title="Audio settings">⚙</button></td>`
        : '<td></td>';
      return `<tr data-key="${escapeHtml(ic._key)}"${active ? ' class="ic-sig-active"' : ''}>
        <td>${escapeHtml(ic.entityIdKey)}</td><td>${ic.deviceId}</td>
        <td>${escapeHtml(ic.encodingClassName || '—')}</td>
        <td>${escapeHtml(ic.tdlTypeName || '—')}</td>
        <td>${frate(ic.sampleRate)}</td><td>${ic.dataLengthBits || 0} bits</td>${gearCell}
      </tr>`;
    }).join('');
  }

  const setDataCols = [
    sd => sd.originatingEntityKey || '',
    sd => sd.receivingEntityKey || '',
    sd => sd.requestId ?? 0,
    sd => sd.numFixedDatums ?? 0,
    sd => sd.numVariableDatums ?? 0,
  ];
  const sdtb = $('setDataTableBody');
  if (sdtb) {
    sdtb.innerHTML = applyTableState(s.setData || [], setDataCols, 'setDataTable').map(sd => `
      <tr data-key="${escapeHtml(sd._key)}">
        <td>${escapeHtml(sd.originatingEntityKey)}</td>
        <td>${escapeHtml(sd.receivingEntityKey)}</td>
        <td>${sd.requestId}</td>
        <td>${sd.numFixedDatums}</td>
        <td>${sd.numVariableDatums}</td>
      </tr>`).join('');
  }

  const desigCols = [
    d => d.designatingKey || '',
    d => d.designatedKey || '',
    d => d.code ?? 0,
    d => d.power ?? 0,
    d => d.wavelengthNm ?? 0,
  ];
  const desigb = $('desigTableBody');
  if (desigb) {
    desigb.innerHTML = applyTableState(s.designators || [], desigCols, 'desigTable').map(d => `
      <tr data-key="${escapeHtml(d._key)}">
        <td>${escapeHtml(d.designatingKey)}</td>
        <td>${escapeHtml(d.designatedKey || '—')}</td>
        <td>${d.code ?? '—'}</td>
        <td>${d.power != null ? d.power : '—'}</td>
        <td>${d.wavelengthNm != null ? d.wavelengthNm + ' nm' : '—'}</td>
      </tr>`).join('');
  }

  const firesCols = [
    f => f.ts ?? 0,
    f => f.firingKey || '',
    f => f.targetKey || '',
    f => f.munitionType || '',
    f => f.range ?? 0,
  ];
  const fb = $('firesTableBody');
  if (fb) {
    const indexedFires = (s.fires || []).map((f, i) => ({ ...f, _origIdx: i }));
    firesRowData = new Map(indexedFires.map(f => [f._origIdx, f]));
    const sortedFires = applyTableState(indexedFires, firesCols, 'firesTable');
    fb.innerHTML = sortedFires.map((f) => `
      <tr data-key="${f._origIdx}">
        <td>${ts2(f.ts)}</td><td>${escapeHtml(f.firingKey)}</td>
        <td>${escapeHtml(f.targetKey || '—')}</td>
        <td>${escapeHtml(f.munitionType || '—')}</td>
        <td>${f.range != null ? fnum(f.range, 0) + ' m' : '—'}</td>
      </tr>`).join('');
  }
  const detsCols = [
    d => d.ts ?? 0,
    d => d.firingKey || '',
    d => d.targetKey || '',
    d => d.munitionType || '',
    d => d.result || '',
  ];
  const db = $('detsTableBody');
  if (db) {
    const indexedDets = (s.detonations || []).map((d, i) => ({ ...d, _origIdx: i }));
    detsRowData = new Map(indexedDets.map(d => [d._origIdx, d]));
    const sortedDets = applyTableState(indexedDets, detsCols, 'detsTable');
    db.innerHTML = sortedDets.map((d) => `
      <tr data-key="${d._origIdx}">
        <td>${ts2(d.ts)}</td><td>${escapeHtml(d.firingKey)}</td>
        <td>${escapeHtml(d.targetKey || '—')}</td>
        <td>${escapeHtml(d.munitionType || '—')}</td>
        <td>${escapeHtml(d.result || '—')}</td>
      </tr>`).join('');
  }

  // Animate new detonations; seed set on first call so existing dets don't fire
  const dets = s.detonations || [];
  if (seenDetTs === null) {
    seenDetTs = new Set(dets.map(d => d.ts));
  } else {
    for (const d of dets) {
      if (!seenDetTs.has(d.ts)) {
        seenDetTs.add(d.ts);
        if (d.geo && window.MapView?.addDetonation) window.MapView.addDetonation(d.geo);
      }
    }
    // trim to avoid unbounded growth (keep last 500 timestamps)
    if (seenDetTs.size > 500) {
      const arr = Array.from(seenDetTs);
      seenDetTs = new Set(arr.slice(arr.length - 500));
    }
  }

  // Persist selection highlight across re-renders; refresh details if data changed
  lastStats = s;
  if (selectedKey) {
    const ent    = selectedType === 'entity'      ? s.entities?.find(x => x.key === selectedKey)           : null;
    const emit   = selectedType === 'emitter'     ? s.emitters?.find(x => x._key === selectedKey)          : null;
    const tx     = selectedType === 'transmitter' ? s.transmitters?.find(x => x._key === selectedKey)      : null;
    const rx     = selectedType === 'receiver'    ? s.receivers?.find(x => x._key === selectedKey)         : null;
    const sig    = selectedType === 'signal'      ? s.signals?.find(x => x._key === selectedKey)           : null;
    const icCtrl  = selectedType === 'ic-control'  ? s.intercomControls?.find(x => x._key === selectedKey)  : null;
    const icSig   = selectedType === 'ic-signal'   ? s.intercomSignals?.find(x => x._key === selectedKey)   : null;
    const setDatum  = selectedType === 'set-data'   ? s.setData?.find(x => x._key === selectedKey)            : null;
    const desig     = selectedType === 'designator' ? s.designators?.find(x => x._key === selectedKey)        : null;
    const fresh = ent || emit || tx || rx || sig || icCtrl || icSig || setDatum || desig;
    if (fresh) {
      renderDetails(fresh);
      if (selectedType === 'entity') window.MapView.showCallout(buildMapCallout(ent));
    } else if (!selectedType?.startsWith('fire') && !selectedType?.startsWith('det')) {
      selectedKey = null; selectedType = null; renderDetails(null);
    }
  }
  applyTableSelection();

  window.MapView.update(s.entities);
  window.MapView.setDesignators(s.designators || [], s.entities || []);
}
function fnum(v, d) { return (v === undefined || v === null || !isFinite(v)) ? '' : Number(v).toFixed(d); }

function ffreq(mhz) {
  if (!mhz) return '—';
  const hz = mhz * 1e6;
  if (hz >= 1e9) return (hz / 1e9).toFixed(4).replace(/\.?0+$/, '') + ' GHz';
  if (hz >= 1e6) return mhz.toFixed(3).replace(/\.?0+$/, '') + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(1).replace(/\.?0+$/, '') + ' kHz';
  return Math.round(hz) + ' Hz';
}

function frate(hz) {
  if (!hz) return '—';
  if (hz >= 1e6) return (hz / 1e6).toFixed(3).replace(/\.?0+$/, '') + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(1).replace(/\.?0+$/, '') + ' kHz';
  return hz + ' Hz';
}

function buildMapCallout(e) {
  const mpsToKts = v => isFinite(v) ? (v * 1.94384).toFixed(0) : '—';
  const mToFt   = m => isFinite(m) ? Math.round(m * 3.28084) : null;
  function ddToDdm(deg, isLat) {
    const abs = Math.abs(deg), d = Math.floor(abs);
    const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    return `${d}° ${((abs - d) * 60).toFixed(3)}' ${dir}`;
  }
  function ddToDms(deg, isLat) {
    const abs = Math.abs(deg), d = Math.floor(abs);
    const mAll = (abs - d) * 60, m = Math.floor(mAll);
    const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    return `${d}° ${m}' ${((mAll - m) * 60).toFixed(1)}" ${dir}`;
  }
  function latLonCell(deg, isLat) {
    if (!isFinite(deg)) return '—';
    return `${fnum(deg, 5)}°<span class="mco-sub">${ddToDdm(deg, isLat)}</span><span class="mco-sub">${ddToDms(deg, isLat)}</span>`;
  }
  const [kSite, kApp, kEnt] = (e.key || '').split(':');
  const typeLabel = lookupEntityType(e.type);
  const damageLabel = e.appearance != null
    ? (['None', 'Slight', 'Moderate', 'Destroyed'][(e.appearance >>> 5) & 3] || null)
    : null;
  const ft = mToFt(e.alt);
  const rows = [
    ['ID', `${kSite ?? '—'} · ${kApp ?? '—'} · ${kEnt ?? '—'}`],
    ['Marking', escapeHtml(e.marking || '—')],
    ['Lat', latLonCell(e.lat, true)],
    ['Lon', latLonCell(e.lon, false)],
    ['Alt', isFinite(e.alt) ? `${fnum(e.alt, 0)} m / ${ft} ft` : '—'],
    ['Hdg / Spd', `${isFinite(e.heading) ? fnum(e.heading, 0) + '°' : '—'} / ${mpsToKts(e.speed)} kts`],
    typeLabel ? ['Type', escapeHtml(typeLabel)] : null,
    damageLabel && damageLabel !== 'None' ? ['Damage', escapeHtml(damageLabel)] : null,
  ].filter(Boolean);
  return `<div class="mco-head"><span class="mco-force f${e.forceId ?? 0}"></span><span class="mco-title">${escapeHtml(e.marking || e.key)}</span></div>` +
    `<dl class="mco-list">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function selectItem(key, type, data) {
  selectedKey = key;
  selectedType = type;
  lastDetailsSerial = null; // force full re-render on new selection
  renderDetails(data);
  applyTableSelection();
  window.MapView.setSelected(type === 'entity' ? key : null);
}

function applyTableSelection() {
  const tbl = (id, type) => document.querySelectorAll(`#${id} tbody tr`).forEach(r =>
    r.classList.toggle('selected', selectedType === type && r.dataset.key === selectedKey));
  tbl('entityTable', 'entity');
  tbl('emitterTable', 'emitter');
  tbl('txTable', 'transmitter');
  tbl('rxTable', 'receiver');
  tbl('sigTable', 'signal');
  tbl('icCtrlTable', 'ic-control');
  tbl('icSigTable', 'ic-signal');
  tbl('setDataTable', 'set-data');
  tbl('desigTable', 'designator');
  // fires/detonations use index as key
  document.querySelectorAll('#firesTable tbody tr').forEach(r =>
    r.classList.toggle('selected', selectedType === 'fire' && selectedKey === `fire_${r.dataset.key}`));
  document.querySelectorAll('#detsTable tbody tr').forEach(r =>
    r.classList.toggle('selected', selectedType === 'detonation' && selectedKey === `det_${r.dataset.key}`));

  // Auto-scroll entity table to selected row when Entities tab is active
  if (selectedType === 'entity' && selectedKey) {
    const activeTab = document.querySelector('.ptab.active')?.dataset?.ptab;
    if (activeTab === 'entities') {
      const row = document.querySelector(`#entityTable tr[data-key="${CSS.escape(selectedKey)}"]`);
      row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

function decodeAppearance(app, kind, domain) {
  const b = (lo, len) => (app >>> lo) & ((1 << len) - 1);
  if (kind === 1) {
    const rows = [
      ['Paintscheme', b(0,1) ? 'Camouflage' : 'Uniform'],
      ['Propulsion', b(1,2) ? 'Kill' : 'OK'],
      ['Firepower', b(3,2) ? 'Kill' : 'OK'],
      ['Damage', ['None','Slight','Moderate','Destroyed'][b(5,2)]],
    ];
    const smoke = ['None','Engine exhaust','Emanating','Engine+Emanating'][b(7,2)];
    if (smoke !== 'None') rows.push(['Smoke', smoke]);
    if (b(9,1)) rows.push(['Flaming', 'Yes']);
    rows.push(['Power plant', b(16,1) ? 'On' : 'Off']);
    rows.push(['State', b(17,1) ? 'Deactivated' : 'Active']);
    if (b(15,1)) rows.push(['Frozen', 'Yes']);
    if (b(14,1)) rows.push(['Concealed', 'Yes']);
    if (domain === 1) {
      rows.push(['Camo type', ['Desert','Winter','Forest','Other'][b(12,2)]]);
      if (b(18,1)) rows.push(['Tent', 'Raised']);
      if (b(19,1)) rows.push(['Ramp', 'Up']);
    } else if (domain === 2) {
      if (b(9,1)) rows.push(['Afterburner', 'On']);
      if (b(14,1)) rows.push(['Canopy', 'Open']);
    }
    return rows;
  }
  return [['Raw', `0x${(app>>>0).toString(16).toUpperCase().padStart(8,'0')}`]];
}

function decodeCapabilities(caps) {
  const flags = [];
  if (caps & 1) flags.push('Ammunition supply');
  if (caps & 2) flags.push('Fuel supply');
  if (caps & 4) flags.push('Recovery');
  if (caps & 8) flags.push('Repair');
  return flags.length ? flags : ['None'];
}

function drawSparkline(canvasId, history) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const w = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 120;
  canvas.width = w;
  canvas.height = 28;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, 28);
  if (history.length < 2) return;
  const max = Math.max(...history, 0.001);
  ctx.beginPath();
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4af';
  ctx.lineWidth = 1.5;
  const step = w / (RATE_HISTORY_MAX - 1);
  const startIdx = Math.max(0, history.length - RATE_HISTORY_MAX);
  history.forEach((v, i) => {
    const x = (i - startIdx) * step;
    const y = 28 - (v / max) * 26;
    i === startIdx ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

let _audioPopupKey = null;

function markAudioActive(key) {
  if (activeAudioKeys.has(key)) clearTimeout(activeAudioKeys.get(key));
  const isIcSig = key.startsWith('ic-sig|');
  const tbodyId = isIcSig ? 'icSigTableBody' : 'sigTableBody';
  const cls     = isIcSig ? 'ic-sig-active'  : 'sig-active';
  const tid = setTimeout(() => {
    activeAudioKeys.delete(key);
    document.querySelectorAll(`#${tbodyId} tr[data-key="${CSS.escape(key)}"]`)
      .forEach(r => r.classList.remove(cls));
  }, 2500);
  activeAudioKeys.set(key, tid);
  document.querySelectorAll(`#${tbodyId} tr[data-key="${CSS.escape(key)}"]`)
    .forEach(r => r.classList.add(cls));
}

function showAudioPopup(key, anchorEl) {
  _audioPopupKey = key;
  const popup = $('audioPopup');
  const ch = window.AudioMgr?.getChannels().find(c => c.key === key);
  $('audioPopupTitle').textContent = key;
  $('audioPanSlider').value = Math.round((ch?.pan || 0) * 100);
  $('audioVolSlider').value = Math.round((ch?.gain ?? 1) * 100);
  const muted = !!ch?.muted;
  $('audioMuteBtn').textContent = muted ? 'Unmute' : 'Mute';
  $('audioMuteBtn').classList.toggle('muted', muted);
  const rect = anchorEl.getBoundingClientRect();
  popup.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  const left = Math.min(rect.left, window.innerWidth - 220);
  popup.style.left = Math.max(4, left) + 'px';
  popup.classList.remove('hidden');
  // Populate audio device list (requires prior audio activity for labels to appear)
  window.AudioMgr?.enumerateOutputDevices().then(devs => {
    const sel = $('audioDevice');
    const row = sel?.closest('.audio-dev-row');
    if (!sel || !row) return;
    if (devs.length === 0) {
      if (!window.isSecureContext) {
        sel.replaceWith(Object.assign(document.createElement('span'), {
          className: 'hint', textContent: 'Device selection requires HTTPS'
        }));
        row.classList.remove('hidden');
      } else {
        row.classList.add('hidden');
      }
      return;
    }
    const cur = sel.value;
    sel.innerHTML = devs.map(d => `<option value="${escapeHtml(d.deviceId)}"${d.deviceId === cur ? ' selected' : ''}>${escapeHtml(d.label || 'Device ' + d.deviceId.slice(0,8))}</option>`).join('');
    row.classList.remove('hidden');
  });
}

// ── TDL signal data display ──────────────────────────────────────────────────

function hexBytes(arr) {
  if (!arr || !arr.length) return '';
  const bytes = Array.isArray(arr) ? arr : Array.from(Object.values(arr));
  return bytes.map(b => (b & 0xFF).toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function hexLine(arr, rowBytes = 16) {
  const bytes = Array.isArray(arr) ? arr : Array.from(Object.values(arr || {}));
  if (!bytes.length) return '<em>(empty)</em>';
  const rows = [];
  for (let i = 0; i < bytes.length; i += rowBytes) {
    const chunk = bytes.slice(i, i + rowBytes);
    const hex  = chunk.map(b => (b & 0xFF).toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const asc  = chunk.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
    rows.push(`<span class="hex-off">${i.toString(16).padStart(4,'0')} </span><span class="hex-data">${hex.padEnd(rowBytes*3-1,' ')}</span>  <span class="hex-asc">${escapeHtml(asc)}</span>`);
  }
  return rows.join('\n');
}

function renderTdlDetails(tdlType, tdlData, signalBytes) {
  const parts = [];

  if (tdlData) {
    if (tdlType === 8 || tdlType === 100) {
      // Link-16 (JTIDS/MIDS/TADIL-J) — type 8 standard, type 100 sim alias
      parts.push(`<div class="tdl-section">
        <strong>Link-16 Header</strong>
        <dl class="detail-list">
          ${tdlData.epochNumber      != null ? `<dt>Epoch number</dt><dd>${tdlData.epochNumber}</dd>` : ''}
          ${tdlData.timeSlotNumber   != null ? `<dt>Time slot number</dt><dd>${tdlData.timeSlotNumber}</dd>` : ''}
          ${tdlData.netNumber        != null ? `<dt>Net number</dt><dd>${tdlData.netNumber}</dd>` : ''}
          ${tdlData.npgNumber        != null ? `<dt>NPG number</dt><dd>${tdlData.npgNumber}</dd>` : ''}
          ${tdlData.ntpTimestamp               ? `<dt>NTP timestamp</dt><dd>${escapeHtml(tdlData.ntpTimestamp)}</dd>` : ''}
          ${tdlData.ntpSeconds       != null ? `<dt>NTP seconds</dt><dd>${tdlData.ntpSeconds}</dd>` : ''}
          ${tdlData.messageSecurityId != null ? `<dt>Message security ID</dt><dd>${tdlData.messageSecurityId}</dd>` : ''}
          ${tdlData.transSecurityId  != null ? `<dt>Trans security ID</dt><dd>${tdlData.transSecurityId}</dd>` : ''}
          ${tdlData.numJWords        != null ? `<dt>Number of J-words</dt><dd>${tdlData.numJWords}</dd>` : ''}
          ${tdlData.messageTypeName            ? `<dt>Message type</dt><dd>${escapeHtml(tdlData.messageTypeName)}${tdlData.jSeriesName ? ` — ${escapeHtml(tdlData.jSeriesName)}` : ''}</dd>` : ''}
        </dl>
      </div>`);
      if (tdlData.jWords && tdlData.jWords.length) {
        const wordRows = tdlData.jWords.map((w, i) =>
          `<div class="datum-row"><span class="datum-id">J-word ${i}</span><code class="datum-hex">${hexBytes(w)}</code></div>`
        ).join('');
        parts.push(`<div class="datum-section"><strong>J-Words (${tdlData.jWords.length})</strong>${wordRows}</div>`);
      }
    } else if (tdlType === 5 || tdlType === 7) {
      // Link-11A / Link-11B
      parts.push(`<div class="tdl-section">
        <strong>Link-11 Header</strong>
        <dl class="detail-list">
          ${tdlData.networkUnitId    != null ? `<dt>Network unit ID</dt><dd>${tdlData.networkUnitId}</dd>` : ''}
          ${tdlData.messageIndicator != null ? `<dt>Message indicator</dt><dd>${tdlData.messageIndicator}</dd>` : ''}
          ${tdlData.frameCount       != null ? `<dt>Frame count</dt><dd>${tdlData.frameCount}</dd>` : ''}
          ${tdlData.frameWordCount   != null ? `<dt>Frame words</dt><dd>${tdlData.frameWordCount}</dd>` : ''}
        </dl>
      </div>`);
      if (tdlData.frameWords && tdlData.frameWords.length) {
        const wRows = tdlData.frameWords.map((w, i) =>
          `<div class="datum-row"><span class="datum-id">Word ${i}</span><code class="datum-hex">${hexBytes(w)}</code></div>`
        ).join('');
        parts.push(`<div class="datum-section"><strong>Frame Words</strong>${wRows}</div>`);
      }
    } else if (tdlType === 6) {
      // SADL
      parts.push(`<div class="tdl-section">
        <strong>SADL Header</strong>
        <dl class="detail-list">
          ${tdlData.frameNumber   != null ? `<dt>Frame number</dt><dd>${tdlData.frameNumber}</dd>` : ''}
          ${tdlData.messageTypeName         ? `<dt>Message type</dt><dd>${escapeHtml(tdlData.messageTypeName)}</dd>` : ''}
          ${tdlData.netNumber     != null ? `<dt>Net number</dt><dd>${tdlData.netNumber}</dd>` : ''}
          ${tdlData.wordCount     != null ? `<dt>Word count</dt><dd>${tdlData.wordCount}</dd>` : ''}
        </dl>
      </div>`);
    } else if (tdlData.byteCount != null) {
      parts.push(`<div class="tdl-section"><strong>TDL Data</strong><dl class="detail-list"><dt>Byte count</dt><dd>${tdlData.byteCount}</dd></dl></div>`);
    }
  }

  if (signalBytes && signalBytes.length) {
    const truncated = signalBytes.length >= 512 ? ' (first 512 B)' : '';
    parts.push(`<div class="datum-section"><strong>Signal Data${escapeHtml(truncated)}</strong><pre class="hex-dump">${hexLine(signalBytes)}</pre></div>`);
  }

  return parts.join('');
}

function renderDetails(data) {
  const el = $('detailsContent');
  if (!data) {
    lastDetailsSerial = null;
    el.innerHTML = '<span class="hint">Select an entity or emitter</span>';
    return;
  }
  // Don't interrupt an active text selection
  if (document.getSelection().type === 'Range') return;
  // Skip if content hasn't changed. Excludes lastSeen so a heartbeat-only update doesn't
  // rebuild the pane and cause the "Xs ago" field to flash.
  const serial = `${selectedKey}|${selectedType}|${data.lat||''}|${data.lon||''}|${data.alt||''}|${data.heading||''}|${data.speed||''}|${data.orientation?.psi?.toFixed(3)||''}|${data.velocity?.x?.toFixed(2)||''}|${data.drAlgorithm??''}`;
  if (serial === lastDetailsSerial) return;
  lastDetailsSerial = serial;

  if (selectedType === 'entity') {
    const e = data;
    const typeLabel = lookupEntityType(e.type);
    const sidc = window.MapView?.entityToSidc?.(e);
    const sidcLabel = window.MapView?.entityToSidcLabel?.(e);
    let iconHtml = '';
    if (sidc && window.ms) {
      try { iconHtml = `<div class="detail-symbol">${new window.ms.Symbol(sidc, { size: 48 }).asSVG()}</div>`; } catch {}
    }
    const parts = (e.type || '0.0.0.0.0.0.0').split(/[.\-]/);
    const kind = +parts[0]||0, domain = +parts[1]||0;
    const r2d = r => isFinite(r) ? (r * 180 / Math.PI).toFixed(2) : '—';
    const mToFt = m => isFinite(m) ? (m * 3.28084).toFixed(0) : '—';
    const mpsToKts = v => isFinite(v) ? (v * 1.94384).toFixed(1) : '—';
    const mpsToMph = v => isFinite(v) ? (v * 2.23694).toFixed(1) : '—';
    const appRows = e.appearance != null ? decodeAppearance(e.appearance, kind, domain) : [];
    const capFlags = e.capabilities != null ? decodeCapabilities(e.capabilities) : [];
    const hasVel = e.velocity && (e.velocity.x || e.velocity.y || e.velocity.z);
    const hasOri = e.orientation;
    const hasDR  = e.drAlgorithm != null;
    const ls = e.lastSeen ? new Date(e.lastSeen).toTimeString().slice(0,8) : '—';
    const lsTs = e.lastSeen || 0;
    const lsAgeMs = lsTs ? Date.now() - lsTs : 0;
    const lsAgoSecs = lsTs ? Math.round(lsAgeMs / 1000) : 0;
    const lsAgoClass = lsAgeMs >= entityTimeoutMs ? ' stale-red' : lsAgeMs >= entityTimeoutMs / 2 ? ' stale-amber' : '';
    let climbRate = null;
    if (hasVel && isFinite(e.lat) && isFinite(e.lon)) {
      const lat = e.lat * Math.PI / 180, lon = e.lon * Math.PI / 180;
      climbRate = e.velocity.x * Math.cos(lat)*Math.cos(lon) +
                  e.velocity.y * Math.cos(lat)*Math.sin(lon) +
                  e.velocity.z * Math.sin(lat);
    }
    el.innerHTML = `
      ${iconHtml}
      <dl class="detail-list">
        <dt>Entity ID</dt><dd>${escapeHtml(e.key||'—')}</dd>
        <dt class="detail-section">Identity</dt>
        <dt>Marking</dt><dd>${escapeHtml(e.marking||'—')}</dd>
        <dt>Charset</dt><dd>${escapeHtml(MARKING_CHARSET[e.markingCharset] || (e.markingCharset != null ? String(e.markingCharset) : '—'))}</dd>
        <dt>Force</dt><dd>${escapeHtml(e.force||'—')}</dd>
        <dt>SIDC</dt><dd>${sidc||'—'}</dd>
        ${sidcLabel ? `<dt>Symbol</dt><dd>${escapeHtml(sidcLabel)}</dd>` : ''}
        <dt>Last seen</dt><dd>${ls}${lsTs ? ` <span id="details-ago" data-ts="${lsTs}" class="ago-timer${lsAgoClass}">· ${lsAgoSecs}s ago</span>` : ''}</dd>

        <dt class="detail-section">Type</dt>
        <dt>Type code</dt><dd>${escapeHtml(e.type||'—')}</dd>
        ${typeLabel ? `<dt class="detail-wide-label">Inferred Type</dt><dd class="detail-wide-value">${escapeHtml(typeLabel)}</dd>` : ''}
        <dt>Kind</dt><dd>${escapeHtml(e.kind||'—')}</dd>
        <dt>Domain</dt><dd>${escapeHtml(e.domain||'—')}</dd>

        <dt class="detail-section">Position</dt>
        <dt>Latitude</dt><dd>${fnum(e.lat,6)||'—'}</dd>
        <dt>Longitude</dt><dd>${fnum(e.lon,6)||'—'}</dd>
        <dt>Altitude</dt><dd>${fnum(e.alt,0)||'—'} m / ${mToFt(e.alt)} ft</dd>
        <dt class="detail-subsection">ECEF</dt>
        <dt>X</dt><dd>${e.location ? fnum(e.location.x,0)+' m' : '—'}</dd>
        <dt>Y</dt><dd>${e.location ? fnum(e.location.y,0)+' m' : '—'}</dd>
        <dt>Z</dt><dd>${e.location ? fnum(e.location.z,0)+' m' : '—'}</dd>

        <dt class="detail-section">Motion</dt>
        <dt>Heading (ψ)</dt><dd>${(fnum(e.heading,1)||'—')+'°'}</dd>
        <dt>Speed</dt><dd>${fnum(e.speed,2)||'—'} m/s · ${mpsToKts(e.speed)} kts · ${mpsToMph(e.speed)} mph</dd>
        <dt>Climb rate</dt><dd>${climbRate != null ? climbRate.toFixed(2)+' m/s' : '—'}</dd>
        <dt class="detail-subsection">ECEF Velocity</dt>
        <dt>X</dt><dd>${e.velocity ? fnum(e.velocity.x,3)+' m/s' : '—'}</dd>
        <dt>Y</dt><dd>${e.velocity ? fnum(e.velocity.y,3)+' m/s' : '—'}</dd>
        <dt>Z</dt><dd>${e.velocity ? fnum(e.velocity.z,3)+' m/s' : '—'}</dd>

        <dt class="detail-section">Orientation</dt>
        <dt title="(Yaw / Heading) Rotation about the world Z-axis (which points out of the North Pole in the DIS geocentric system). It dictates the horizontal heading of the entity.">Psi (ψ)</dt><dd>${e.orientation ? (((e.orientation.psi*180/Math.PI)+360)%360).toFixed(2)+'°' : '—'}</dd>
        <dt title="(Pitch) Rotation about the entity&#39;s Y-axis. Represents the nose-up or nose-down attitude of the entity.">Theta (θ)</dt><dd>${e.orientation ? r2d(e.orientation.theta)+'°' : '—'}</dd>
        <dt title="(Roll) Rotation about the entity&#39;s X-axis. Represents the bank angle / tilt around the longitudinal axis.">Phi (φ)</dt><dd>${e.orientation ? r2d(e.orientation.phi)+'°' : '—'}</dd>

        <dt class="detail-section">Dead Reckoning</dt>
        <dt>Algorithm</dt><dd>${e.drAlgorithm != null ? escapeHtml(DR_ALGORITHM[e.drAlgorithm]||String(e.drAlgorithm)) : '—'}</dd>
        <dt class="detail-subsection">Linear Acceleration</dt>
        <dt>X</dt><dd>${e.drLinearAcceleration ? fnum(e.drLinearAcceleration.x,4)+' m/s²' : '—'}</dd>
        <dt>Y</dt><dd>${e.drLinearAcceleration ? fnum(e.drLinearAcceleration.y,4)+' m/s²' : '—'}</dd>
        <dt>Z</dt><dd>${e.drLinearAcceleration ? fnum(e.drLinearAcceleration.z,4)+' m/s²' : '—'}</dd>
        <dt class="detail-subsection">Angular Velocity</dt>
        <dt>X</dt><dd>${e.drAngularVelocity ? fnum(e.drAngularVelocity.x,5)+' rad/s' : '—'}</dd>
        <dt>Y</dt><dd>${e.drAngularVelocity ? fnum(e.drAngularVelocity.y,5)+' rad/s' : '—'}</dd>
        <dt>Z</dt><dd>${e.drAngularVelocity ? fnum(e.drAngularVelocity.z,5)+' rad/s' : '—'}</dd>

        ${appRows.length ? `
        <dt class="detail-section">Appearance</dt>
        ${appRows.map(([k,v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}
        <dt>Raw</dt><dd>0x${(e.appearance>>>0).toString(16).toUpperCase().padStart(8,'0')}</dd>` : ''}

        ${capFlags && capFlags.length ? `
        <dt class="detail-section">Capabilities</dt>
        <dt>Flags</dt><dd>${capFlags.map(f => escapeHtml(f)).join(', ')}</dd>
        <dt>Raw</dt><dd>0x${((e.capabilities||0)>>>0).toString(16).toUpperCase().padStart(8,'0')}</dd>` : ''}

        ${e.articulationParams?.length ? `
        <dt class="detail-section">Articulation (${e.articulationParams.length})</dt>
        ${e.articulationParams.map((a,i) => {
          const isArticulated = a.typeDesignator === 0;
          const typeClass = (a.parameterType >>> 5);
          const metric = a.parameterType & 0x1f;
          const METRIC = ['Other','Position','Position Rate','Extension','Extension Rate',
            'X','X Rate','Y','Y Rate','Z','Z Rate',
            'Azimuth','Azimuth Rate','Elevation','Elevation Rate','Rotation','Rotation Rate'];
          const metricLabel = METRIC[metric] || `${metric}`;
          return `
          <dt class="detail-subsection">Param #${i+1}</dt>
          <dt>Designator</dt><dd>${isArticulated ? 'Articulated' : 'Attached'}</dd>
          <dt>Change</dt><dd>${a.changeIndicator ?? '—'}</dd>
          <dt>Attachment ID</dt><dd>${a.attachmentId ?? '—'}</dd>
          ${isArticulated ? `
          <dt>Type class</dt><dd>${typeClass}</dd>
          <dt>Metric</dt><dd>${metricLabel}</dd>` : `
          <dt>Param type</dt><dd>0x${(a.parameterType>>>0).toString(16).toUpperCase().padStart(8,'0')}</dd>`}
          <dt>Value</dt><dd>${isFinite(a.parameterValue) ? a.parameterValue.toFixed(4) : '—'}</dd>`;
        }).join('')}` : ''}

      </dl>`;

  } else if (selectedType === 'emitter') {
    const r = data;
    const ls = r.lastSeen ? new Date(r.lastSeen).toTimeString().slice(0,8) : '—';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Emitter System</dt>
      <dt>Entity</dt><dd>${escapeHtml(r.entity||'—')}</dd>
      <dt>Emitter name</dt><dd>${escapeHtml(String(r.emitterName ?? r.emitter ?? '—'))}</dd>
      <dt>Emitter #</dt><dd>${r.emitterNumber ?? '—'}</dd>
      <dt>Function</dt><dd>${escapeHtml(r.beamFunction||r['function']||'—')}</dd>
      <dt>State indicator</dt><dd>${r.stateUpdateIndicator === 0 ? 'Heartbeat' : r.stateUpdateIndicator === 1 ? 'Changed data' : '—'}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
      ${r.systemLocation ? `
      <dt>Sys loc X</dt><dd>${isFinite(r.systemLocation.x) ? r.systemLocation.x.toFixed(2) : '—'} m</dd>
      <dt>Sys loc Y</dt><dd>${isFinite(r.systemLocation.y) ? r.systemLocation.y.toFixed(2) : '—'} m</dd>
      <dt>Sys loc Z</dt><dd>${isFinite(r.systemLocation.z) ? r.systemLocation.z.toFixed(2) : '—'} m</dd>` : ''}
      <dt class="detail-section">Beam ${r.beamNumber ?? ''}</dt>
      <dt>Band</dt><dd>${escapeHtml(r.band||'—')}</dd>
      <dt>Frequency</dt><dd>${r.freqMHz||'—'} MHz</dd>
      <dt>PRF</dt><dd>${r.prf||'—'} Hz</dd>
      <dt>ERP</dt><dd>${r.erp||'—'} dBm</dd>
      <dt>Pulse width</dt><dd>${r.pulseWidth||'—'} µs</dd>
      <dt>Az centre</dt><dd>${r.azimuthCenter ?? '—'} rad</dd>
      <dt>Az sweep</dt><dd>${r.azimuthSweep ?? '—'} rad</dd>
      <dt>El centre</dt><dd>${r.elevationCenter ?? '—'} rad</dd>
      <dt>El sweep</dt><dd>${r.elevationSweep ?? '—'} rad</dd>
      ${(r.beamFunction||'').toLowerCase().includes('acqui') || r.numTargets > 0 ? `<dt>Targets</dt><dd>${r.numTargets ?? '—'}</dd>` : ''}
    </dl>`;

  } else if (selectedType === 'fire') {
    const f = data;
    const ls = f.ts ? new Date(f.ts).toTimeString().slice(0,8) : '—';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Fire Event</dt>
      <dt>Time</dt><dd>${ls}</dd>
      <dt>Firing entity</dt><dd>${escapeHtml(f.firingKey||'—')}</dd>
      <dt>Target entity</dt><dd>${escapeHtml(f.targetKey||'—')}</dd>
      <dt>Munition type</dt><dd>${escapeHtml(f.munitionType||'—')}</dd>
      <dt>Range</dt><dd>${f.range != null ? fnum(f.range,0)+' m' : '—'}</dd>
      ${f.geo ? `
      <dt>Lat</dt><dd>${fnum(f.geo.lat,6)}</dd>
      <dt>Lon</dt><dd>${fnum(f.geo.lon,6)}</dd>
      <dt>Alt</dt><dd>${fnum(f.geo.alt,0)} m</dd>` : ''}
    </dl>`;

  } else if (selectedType === 'detonation') {
    const d = data;
    const ls = d.ts ? new Date(d.ts).toTimeString().slice(0,8) : '—';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Detonation Event</dt>
      <dt>Time</dt><dd>${ls}</dd>
      <dt>Firing entity</dt><dd>${escapeHtml(d.firingKey||'—')}</dd>
      <dt>Target entity</dt><dd>${escapeHtml(d.targetKey||'—')}</dd>
      <dt>Munition type</dt><dd>${escapeHtml(d.munitionType||'—')}</dd>
      <dt>Result</dt><dd>${escapeHtml(d.result||'—')}</dd>
      ${d.geo ? `
      <dt>Lat</dt><dd>${fnum(d.geo.lat,6)}</dd>
      <dt>Lon</dt><dd>${fnum(d.geo.lon,6)}</dd>
      <dt>Alt</dt><dd>${fnum(d.geo.alt,0)} m</dd>` : ''}
    </dl>`;

  } else if (selectedType === 'transmitter') {
    const t = data;
    const ls = t.lastSeen ? new Date(t.lastSeen).toTimeString().slice(0,8) : '—';
    const bi = t.bandInfo || {};
    const powerW = (t.power != null && isFinite(t.power)) ? Math.pow(10, (t.power - 30) / 10) : null;
    const powerWStr = powerW != null ? (powerW >= 1 ? powerW.toFixed(3) + ' W' : (powerW * 1000).toFixed(3) + ' mW') : '—';
    const modSection = (t.majorModulationName || t.radioSystemName) ? `
      <dt class="detail-subsection">Modulation</dt>
      ${t.radioSystemName ? `<dt>Radio system</dt><dd>${escapeHtml(t.radioSystemName)}</dd>` : ''}
      ${t.majorModulationName ? `<dt>Major modulation</dt><dd>${escapeHtml(t.majorModulationName)}</dd>` : ''}
      ${t.spreadSpectrum ? `<dt>Spread spectrum</dt><dd>${t.spreadSpectrum}</dd>` : ''}
      ${t.cryptoSystem ? `<dt>Crypto system</dt><dd>${escapeHtml(t.cryptoSystemName || String(t.cryptoSystem))}</dd>` : ''}
      ${t.cryptoKeyId ? `<dt>Crypto key ID</dt><dd>${t.cryptoKeyId}</dd>` : ''}
      ${t.modParamLength ? `<dt>Mod param length</dt><dd>${t.modParamLength} bytes</dd>` : ''}
    ` : '';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Transmitter</dt>
      <dt>Host entity</dt><dd>${escapeHtml(t.entityKey||'—')}</dd>
      <dt>Radio ID</dt><dd>${t.radioId}</dd>
      <dt>Tx state</dt><dd>${escapeHtml(t.txStateName||'—')}</dd>
      <dt>Frequency</dt><dd>${t.freqMHz} MHz</dd>
      <dt class="detail-subsection">Band</dt>
      <dt>ITU designation</dt><dd>${escapeHtml(bi.ituName||'—')} (band ${bi.ituBand ?? '—'})</dd>
      <dt>IEEE/Radar band</dt><dd>${escapeHtml(bi.ieeeBand||'—')}</dd>
      <dt>NATO band</dt><dd>${escapeHtml(bi.natoBand||'—')}</dd>
      <dt class="detail-subsection">Power</dt>
      <dt>Power (dBm)</dt><dd>${t.power} dBm</dd>
      <dt>Power (linear)</dt><dd>${powerWStr}</dd>
      ${modSection}
      ${t.geo ? `
      <dt class="detail-subsection">Location</dt>
      <dt>Lat</dt><dd>${fnum(t.geo.lat,6)}</dd>
      <dt>Lon</dt><dd>${fnum(t.geo.lon,6)}</dd>
      <dt>Alt</dt><dd>${fnum(t.geo.alt,0)} m</dd>` : ''}
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>`;

  } else if (selectedType === 'receiver') {
    const r = data;
    const ls = r.lastSeen ? new Date(r.lastSeen).toTimeString().slice(0,8) : '—';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Receiver</dt>
      <dt>Entity</dt><dd>${escapeHtml(r.entityIdKey||'—')}</dd>
      <dt>Radio ID</dt><dd>${r.radioId ?? '—'}</dd>
      <dt>Receiver state</dt><dd>${escapeHtml(r.receiverStateName||'—')}</dd>
      <dt>Received power</dt><dd>${r.receivedPower != null ? r.receivedPower + ' dBm' : '—'}</dd>
      <dt class="detail-subsection">Transmitter</dt>
      <dt>Entity</dt><dd>${escapeHtml(r.transmitterEntityKey||'—')}</dd>
      <dt>Radio ID</dt><dd>${r.transmitterRadioId ?? '—'}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>`;

  } else if (selectedType === 'signal') {
    const sg = data;
    const ls = sg.lastSeen ? new Date(sg.lastSeen).toTimeString().slice(0,8) : '—';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Signal</dt>
      <dt>Entity</dt><dd>${escapeHtml(sg.entityIdKey||'—')}</dd>
      <dt>Radio ID</dt><dd>${sg.radioId}</dd>
      <dt>Encoding class</dt><dd>${escapeHtml(sg.encodingClassName||'—')}</dd>
      <dt>Encoding type</dt><dd>${sg.encodingType}</dd>
      <dt>TDL type</dt><dd>${escapeHtml(sg.tdlTypeName||'—')}</dd>
      <dt>Sample rate</dt><dd>${sg.sampleRate||0} Hz</dd>
      <dt>Data length</dt><dd>${sg.dataLengthBits||0} bits</dd>
      <dt>Samples</dt><dd>${sg.numSamples||0}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>
    ${renderTdlDetails(sg.tdlType, sg.tdlData, sg.signalBytes)}`;

  } else if (selectedType === 'ic-control') {
    const ic = data;
    const ls = ic.lastSeen ? new Date(ic.lastSeen).toTimeString().slice(0,8) : '—';
    const txStateStr = ic.transmitLineState === 1 ? '1 — Transmitting' : ic.transmitLineState === 0 ? '0 — Not transmitting' : `${ic.transmitLineState ?? '—'}`;
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Intercom Control</dt>
      <dt>Control type</dt><dd>${escapeHtml(ic.controlTypeName||'—')}</dd>
      <dt>Channel type</dt><dd>${escapeHtml(ic.channelTypeName||'—')}</dd>
      <dt class="detail-subsection">Source Entity ID</dt>
      <dt>Site</dt><dd>${ic.sourceEntityId?.site ?? '—'}</dd>
      <dt>Application</dt><dd>${ic.sourceEntityId?.application ?? '—'}</dd>
      <dt>Entity</dt><dd>${ic.sourceEntityId?.entity ?? '—'}</dd>
      <dt>Source device ID</dt><dd>${ic.sourceDeviceId ?? '—'}</dd>
      <dt>Source line ID</dt><dd>${ic.sourceLineId ?? '—'}</dd>
      <dt>Transmit priority</dt><dd>${ic.transmitPriority ?? '—'}</dd>
      <dt>Transmit line state</dt><dd>${txStateStr}</dd>
      <dt>Command</dt><dd>${escapeHtml(ic.commandName||'—')}</dd>
      <dt class="detail-subsection">Master Entity ID</dt>
      <dt>Site</dt><dd>${ic.masterEntityId?.site ?? '—'}</dd>
      <dt>Application</dt><dd>${ic.masterEntityId?.application ?? '—'}</dd>
      <dt>Entity</dt><dd>${ic.masterEntityId?.entity ?? '—'}</dd>
      <dt>Master device ID</dt><dd>${ic.masterDeviceId ?? '—'}</dd>
      <dt>Master channel ID</dt><dd>${ic.masterChannelId ?? '—'}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>`;

  } else if (selectedType === 'ic-signal') {
    const ic = data;
    const ls = ic.lastSeen ? new Date(ic.lastSeen).toTimeString().slice(0,8) : '—';
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Intercom Signal</dt>
      <dt>Entity</dt><dd>${escapeHtml(ic.entityIdKey||'—')}</dd>
      <dt>Device ID</dt><dd>${ic.deviceId ?? '—'}</dd>
      <dt>Encoding class</dt><dd>${escapeHtml(ic.encodingClassName||'—')}</dd>
      <dt>Encoding type</dt><dd>${ic.encodingType ?? '—'}</dd>
      <dt>TDL type</dt><dd>${escapeHtml(ic.tdlTypeName||'—')}</dd>
      <dt>Sample rate</dt><dd>${ic.sampleRate||0} Hz</dd>
      <dt>Data length</dt><dd>${ic.dataLengthBits||0} bits</dd>
      <dt>Samples</dt><dd>${ic.numSamples||0}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>`;

  } else if (selectedType === 'set-data') {
    const sd = data;
    const ls = sd.lastSeen ? new Date(sd.lastSeen).toTimeString().slice(0,8) : '—';
    const toHex = (val) => {
      const bytes = Array.isArray(val) ? val : (val?.data ? val.data : Object.values(val || {}));
      if (!bytes || !bytes.length) return '(empty)';
      return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    };
    const fixedRows = (sd.fixedDatums || []).map(d =>
      `<div class="datum-row"><span class="datum-id">ID 0x${d.datumId.toString(16).toUpperCase().padStart(8,'0')}</span><code class="datum-hex">${toHex(d.value)}</code></div>`
    ).join('');
    const varRows = (sd.variableDatums || []).map(d =>
      `<div class="datum-row"><span class="datum-id">ID 0x${d.datumId.toString(16).toUpperCase().padStart(8,'0')} (${d.lengthBits} bits)</span><code class="datum-hex">${toHex(d.value)}</code></div>`
    ).join('');
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Set Data</dt>
      <dt>Originating entity</dt><dd>${escapeHtml(sd.originatingEntityKey||'—')}</dd>
      <dt>Receiving entity</dt><dd>${escapeHtml(sd.receivingEntityKey||'—')}</dd>
      <dt>Request ID</dt><dd>${sd.requestId ?? '—'}</dd>
      <dt>Fixed datums</dt><dd>${sd.numFixedDatums}</dd>
      <dt>Variable datums</dt><dd>${sd.numVariableDatums}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>
    ${sd.numFixedDatums > 0 ? `<div class="datum-section"><strong>Fixed Datums</strong>${fixedRows}</div>` : ''}
    ${sd.numVariableDatums > 0 ? `<div class="datum-section"><strong>Variable Datums</strong>${varRows}</div>` : ''}`;

  } else if (selectedType === 'designator') {
    const d = data;
    const ls = d.lastSeen ? new Date(d.lastSeen).toTimeString().slice(0,8) : '—';
    const hasSpot = d.spotGeo && isFinite(d.spotGeo.lat);
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Designator</dt>
      <dt>Designating entity</dt><dd>${escapeHtml(d.designatingKey||'—')}</dd>
      <dt>Designated entity</dt><dd>${escapeHtml(d.designatedKey||'—')}</dd>
      <dt>Code name</dt><dd>${escapeHtml(d.codeNameStr||'—')} (${d.codeName ?? '—'})</dd>
      <dt>Designator code</dt><dd>${d.code ?? '—'}</dd>
      <dt>Power</dt><dd>${d.power != null ? d.power + ' W' : '—'}</dd>
      <dt>Wavelength</dt><dd>${d.wavelengthMicrons != null ? d.wavelengthMicrons + ' μm (' + d.wavelengthNm + ' nm)' : '—'}</dd>
      <dt class="detail-subsection">Spot (relative to designated entity)</dt>
      <dt>X</dt><dd>${d.spotRelative?.x != null ? d.spotRelative.x + ' m' : '—'}</dd>
      <dt>Y</dt><dd>${d.spotRelative?.y != null ? d.spotRelative.y + ' m' : '—'}</dd>
      <dt>Z</dt><dd>${d.spotRelative?.z != null ? d.spotRelative.z + ' m' : '—'}</dd>
      ${d.spotRelIsNonZero ? '<dt class="detail-subsection">Map source</dt><dd>Relative spot (priority)</dd>' : ''}
      <dt class="detail-subsection">Spot location (absolute)</dt>
      <dt>Latitude</dt><dd>${hasSpot ? d.spotGeo.lat.toFixed(6) + '°' : '—'}</dd>
      <dt>Longitude</dt><dd>${hasSpot ? d.spotGeo.lon.toFixed(6) + '°' : '—'}</dd>
      <dt>Altitude</dt><dd>${hasSpot && d.spotGeo.alt != null ? fnum(d.spotGeo.alt, 1) + ' m' : '—'}</dd>
      <dt class="detail-subsection">Dead Reckoning</dt>
      <dt>DR algorithm</dt><dd>${d.drAlgorithm ?? '—'}</dd>
      <dt>Velocity (m/s)</dt><dd>X ${d.velocity?.x ?? '—'} Y ${d.velocity?.y ?? '—'} Z ${d.velocity?.z ?? '—'}</dd>
      <dt>Acceleration (m/s²)</dt><dd>X ${d.acceleration?.x ?? '—'} Y ${d.acceleration?.y ?? '—'} Z ${d.acceleration?.z ?? '—'}</dd>
      <dt>Last seen</dt><dd>${ls}</dd>
    </dl>`;
  }
}

// Donut/pie chart. data items: { count, label }. Stores segments for hover hit-testing.
function drawPie(canvasId, data, centerLabel, centerCount) {
  const c = $(canvasId);
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 2;
  ctx.clearRect(0, 0, w, h);
  const total = (data || []).reduce((s, d) => s + d.count, 0);
  if (!total) {
    pieHitData[canvasId] = null;
    ctx.fillStyle = '#5c6b7a'; ctx.font = '9px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('no data', cx, cy);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; return;
  }
  const ir = r * 0.54;
  let a = -Math.PI / 2;
  const segments = [];
  data.forEach((d, i) => {
    const a2 = a + (d.count / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a2); ctx.closePath();
    ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length]; ctx.fill();
    segments.push({ startAngle: a, endAngle: a2, count: d.count, label: d.label || '' });
    a = a2;
  });
  pieHitData[canvasId] = { segments, cx, cy, r, ir };
  ctx.beginPath(); ctx.arc(cx, cy, ir, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22'; ctx.fill();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#d7dde5'; ctx.font = `bold ${ir > 20 ? 12 : 10}px system-ui`;
  const displayTotal = centerCount !== undefined ? centerCount : total;
  ctx.fillText(fmt(displayTotal), cx, centerLabel ? cy - 4 : cy);
  if (centerLabel) { ctx.fillStyle = '#8b97a7'; ctx.font = '9px system-ui'; ctx.fillText(centerLabel, cx, cy + 8); }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

let _pieTooltipEl = null;
function showPieTooltip(x, y, label, count) {
  if (!_pieTooltipEl) {
    _pieTooltipEl = document.createElement('div');
    Object.assign(_pieTooltipEl.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '9000',
      background: '#1c2430', border: '1px solid #2b3441',
      padding: '5px 10px', borderRadius: '6px',
      fontSize: '11px', color: '#d7dde5', whiteSpace: 'nowrap',
    });
    document.body.appendChild(_pieTooltipEl);
  }
  _pieTooltipEl.textContent = `${label} — ${fmt(count)}`;
  _pieTooltipEl.style.display = 'block';
  _pieTooltipEl.style.left = (x + 12) + 'px';
  _pieTooltipEl.style.top = (y - 8) + 'px';
  const r = _pieTooltipEl.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) _pieTooltipEl.style.left = (x - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight - 4) _pieTooltipEl.style.top = (y - r.height - 4) + 'px';
}
function hidePieTooltip() { if (_pieTooltipEl) _pieTooltipEl.style.display = 'none'; }

function setupPieTooltips() {
  ['pieChart', 'sitePie', 'appPie'].forEach(id => {
    const c = $(id);
    if (!c) return;
    c.addEventListener('mousemove', (e) => {
      const data = pieHitData[id];
      if (!data || !data.segments.length) { hidePieTooltip(); return; }
      const rect = c.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (c.width / rect.width);
      const my = (e.clientY - rect.top) * (c.height / rect.height);
      const dx = mx - data.cx, dy = my - data.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > data.r || dist < data.ir) { hidePieTooltip(); return; }
      let angle = Math.atan2(dy, dx);
      if (angle < -Math.PI / 2) angle += 2 * Math.PI;
      const seg = data.segments.find(s => angle >= s.startAngle && angle < s.endAngle);
      if (seg) showPieTooltip(e.clientX, e.clientY, seg.label, seg.count);
      else hidePieTooltip();
    });
    c.addEventListener('mouseleave', hidePieTooltip);
  });
}

let feedLines = [];
let _feedScheduled = false;

function renderFeed(samples) {
  if (!samples || !samples.length) return;
  for (const s of samples) {
    feedLines.push(`<div class="t${s.type}">${ts()} ${escapeHtml(s.name)}${s.key ? ' ' + escapeHtml(s.key) : ''}</div>`);
    if (s.type === 2) flashEvent('FIRE', 'fire');
    else if (s.type === 3) flashEvent('DETONATION', 'detonation');
  }
  if (feedLines.length > 200) feedLines = feedLines.slice(-200);

  if (!_feedScheduled) {
    _feedScheduled = true;
    requestAnimationFrame(() => {
      _feedScheduled = false;
      const el = $('feed');
      if (!el) return;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      el.innerHTML = feedLines.join('');
      if (atBottom) el.scrollTop = el.scrollHeight;
    });
  }
}
function ts() { const d = new Date(); return d.toTimeString().slice(0, 8); }
function ts2(ms) { if (!ms) return ''; const d = new Date(ms); return d.toTimeString().slice(0, 8); }

const _flashTimers = {};
function flashEvent(text, cls) {
  const container = $('evtFlashContainer');
  if (!container) return;
  const existing = container.querySelector(`.evt-flash.${cls}`);
  if (existing) { existing.remove(); clearTimeout(_flashTimers[cls]); }
  const el = document.createElement('span');
  el.className = `evt-flash ${cls}`;
  el.textContent = text;
  container.appendChild(el);
  _flashTimers[cls] = setTimeout(() => el.remove(), 2600);
}

function renderLogs() {
  const sel = $('logSelect');
  const prev = sel.value;
  sel.innerHTML = logs.map((l) => `<option value="${escapeHtml(l.file)}">${escapeHtml(l.file)}</option>`).join('');
  if (prev && logs.some((l) => l.file === prev)) sel.value = prev;
  showLogInfo();
}
function showLogInfo() {
  const l = logs.find((x) => x.file === $('logSelect').value);
  if (!l) { $('logInfo').textContent = ''; replayBookmarks = []; replayDurationMs = 0; renderReplayMarks(); return; }
  const dur = (l.durationMs / 1000).toFixed(1);
  const nb = (l.bookmarks || []).length;
  $('logInfo').textContent = `${l.records} records · ${dur}s · ${(l.sizeBytes / 1024).toFixed(0)} KB${nb ? ` · ${nb} bookmark${nb > 1 ? 's' : ''}` : ''}`;
  // Show this log's bookmarks on the timeline before playback starts.
  replayBookmarks = l.bookmarks || [];
  replayDurationMs = l.durationMs || 0;
  renderReplayMarks();
}

function renderProgress(p) {
  if (!p) return;
  playerState = p.state;
  $('btnPause').textContent = p.state === 'paused' ? '▶ Resume' : '⏸ Pause';
  const pct = p.durationMs ? Math.min(100, p.positionMs / p.durationMs * 100) : 0;
  $('progBar').style.width = pct + '%';
  if (p.durationMs && p.durationMs !== replayDurationMs) { replayDurationMs = p.durationMs; renderReplayMarks(); }
  const verLabel = p.replayAsVersion ? ` · as v${p.replayAsVersion}` : '';
  const warnLabel = p.versionWarnings ? ` · ⚠ ${p.versionWarnings} ver warn` : '';
  $('progText').textContent =
    `${p.state} · ${(p.positionMs / 1000).toFixed(1)}/${(p.durationMs / 1000).toFixed(1)}s · ${p.speed}x · sent ${p.sentCount}${p.loop ? ' · loop' : ''}${p.loops ? ' · pass ' + p.loops : ''}${verLabel}${warnLabel}`;
}

let toastTimer;
function toast(msg) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el);
    Object.assign(el.style, { position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
      background: '#1c2430', border: '1px solid #2b3441', padding: '8px 14px', borderRadius: '8px', zIndex: 9999 }); }
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
}

function sendFiltersIfReplaying() {
  if (appMode !== 'replaying') return;
  const asVer = $('repAsVersion').value;
  send({
    cmd: 'setFilters',
    filterTypes:     filterPayload($('repFilter')),
    versionFilter:   filterPayload($('repVersionFilter')),
    siteFilter:      parseIdList($('repSiteIds').value),
    appFilter:       parseIdList($('repAppIds').value),
    replayAsVersion: asVer ? +asVer : null,
  });
}

function doPlay() {
  $('verWarnBadge').classList.add('hidden');
  const asVer = $('repAsVersion').value;
  send({
    cmd: 'startReplay', file: $('logSelect').value,
    destAddress: $('repMulti').checked ? $('repGroup').value : $('repDest').value,
    destPort: +$('repPort').value, multicast: $('repMulti').checked,
    speed: +$('repSpeed').value, loop: $('repLoop').checked,
    filterTypes:    filterPayload($('repFilter')),
    versionFilter:  filterPayload($('repVersionFilter')),
    replayAsVersion: asVer ? +asVer : null,
    siteFilter: parseIdList($('repSiteIds').value),
    appFilter:  parseIdList($('repAppIds').value),
  });
}

function applyHostVisibility() {
  document.querySelectorAll('.host-only').forEach(el => el.classList.toggle('hidden', !isLocalHost));
  document.querySelectorAll('.client-only').forEach(el => el.classList.toggle('hidden', isLocalHost));
}

// ---- wiring ----------------------------------------------------------------
function init() {
  applyHostVisibility(); // apply before WebSocket connects (default: non-host)
  window.MapView.init({
    onEntityClick: (key) => {
      if (!key) {
        selectedKey = null; selectedType = null;
        applyTableSelection();
        window.MapView.setSelected(null);
        window.MapView.showCallout(null);
        return;
      }
      const entity = lastStats?.entities?.find(x => x.key === key);
      if (entity) {
        selectItem(key, 'entity', entity);
        window.MapView.showCallout(buildMapCallout(entity));
        document.querySelectorAll('.ptab').forEach(t => t.classList.toggle('active', t.dataset.ptab === 'entities'));
        document.querySelectorAll('.ptabbody').forEach(b => b.classList.toggle('hidden', b.id !== 'ptab-entities'));
      }
    }
  });
  buildMultiselect($('recFilter'),        PDU_TYPES,    'All PDU types');
  buildMultiselect($('repFilter'),        PDU_TYPES,    'All PDU types');
  buildMultiselect($('recVersionFilter'), DIS_VERSIONS, 'All versions', (v, n) => `v${v} — ${n}`);
  buildMultiselect($('repVersionFilter'), DIS_VERSIONS, 'All versions', (v, n) => `v${v} — ${n}`);
  document.addEventListener('click', () => document.querySelectorAll('.multiselect.open').forEach(el => el.classList.remove('open')));
  $('recFilter').addEventListener('change', updateFilterIndicators);
  $('recVersionFilter').addEventListener('change', updateFilterIndicators);
  $('recSiteIds').addEventListener('input', updateFilterIndicators);
  $('recAppIds').addEventListener('input', updateFilterIndicators);
  $('repFilter').addEventListener('change', updateFilterIndicators);
  $('repVersionFilter').addEventListener('change', updateFilterIndicators);
  $('repSiteIds').addEventListener('input', updateFilterIndicators);
  $('repAppIds').addEventListener('input', updateFilterIndicators);

  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('tab-view').classList.toggle('hidden', t.dataset.tab !== 'view');
    $('tab-capture').classList.toggle('hidden', t.dataset.tab !== 'capture');
    $('tab-replay').classList.toggle('hidden', t.dataset.tab !== 'replay');
  });

  $('btnListen').onclick = () => send({
    cmd: 'startCapture', port: +$('capPort').value, multicast: $('capMulti').checked,
    multicastGroup: $('capGroup').value, bindAddress: $('capBind').value,
  });
  $('btnStop').onclick = () => send({ cmd: 'stop' });
  $('btnRecord').onclick = () => send({
    cmd: 'startRecording', port: +$('capPort').value, multicast: $('capMulti').checked,
    multicastGroup: $('capGroup').value, bindAddress: $('capBind').value,
    filename: $('recName').value || undefined,
    filterTypes:   filterPayload($('recFilter')),
    versionFilter: filterPayload($('recVersionFilter')),
    siteFilter: parseIdList($('recSiteIds').value),
    appFilter:  parseIdList($('recAppIds').value),
  });
  $('btnStopRecord').onclick = () => send({ cmd: 'stopRecording' });

  $('btnRefreshLogs').onclick = () => send({ cmd: 'listLogs' });
  $('logSelect').onchange = showLogInfo;
  $('btnPlay').onclick = () => doPlay();
  $('btnBookmark').onclick = () => send({ cmd: 'addBookmark', label: $('bmLabel').value });
  const addRepBm = () => {
    const label = $('repBmLabel')?.value || '';
    const selectedFile = $('logSelect')?.value;
    send({ cmd: 'addBookmark', label, file: selectedFile });
  };
  if ($('btnRepBookmark')) $('btnRepBookmark').onclick = addRepBm;
  if ($('repBmLabel')) $('repBmLabel').onkeydown = (e) => { if (e.key === 'Enter') addRepBm(); };
  // Click anywhere on the replay timeline to seek; marks handle their own clicks.
  $('repTimeline').onclick = (e) => {
    if (!replayDurationMs) return;
    const track = $('repTimeline').querySelector('.tl-track');
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekToOffset(frac * replayDurationMs * 1000);
  };
  $('btnPause').onclick = () => send({ cmd: playerState === 'paused' ? 'resumeReplay' : 'pauseReplay' });
  $('btnStopReplay').onclick = () => send({ cmd: 'stop' });
  $('repSpeed').onchange = () => send({ cmd: 'setSpeed', speed: +$('repSpeed').value });
  $('repLoop').onchange = () => send({ cmd: 'setLoop', loop: $('repLoop').checked });
  $('repAsVersion').onchange = () => sendFiltersIfReplaying();
  $('repFilter').addEventListener('change', () => sendFiltersIfReplaying());
  $('repVersionFilter').addEventListener('change', () => sendFiltersIfReplaying());
  $('repSiteIds').addEventListener('input', () => sendFiltersIfReplaying());
  $('repAppIds').addEventListener('input', () => sendFiltersIfReplaying());
  $('btnExportPcap').onclick = () => {
    const file = $('logSelect').value;
    if (!file) return;
    const dstIp = $('repMulti').checked ? $('repGroup').value : $('repDest').value;
    const port  = $('repPort').value || 3000;
    const a = document.createElement('a');
    a.href = `/export-pcap?file=${encodeURIComponent(file)}&dstIp=${encodeURIComponent(dstIp)}&port=${encodeURIComponent(port)}`;
    a.download = file.replace(/\.dislog$/, '.pcap');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // Multicast group inputs are only relevant when the multicast box is ticked.
  const bindMulti = (chk, grp) => {
    const sync = () => { $(grp).disabled = !$(chk).checked; };
    $(chk).onchange = sync; sync();
  };
  bindMulti('capMulti', 'capGroup');
  bindMulti('repMulti', 'repGroup');

  // Log directory controls — browse button always opens the native OS folder dialog.
  $('btnBrowseRecDir')?.addEventListener('click', () => { toast('Opening folder dialog on host…'); send({ cmd: 'browseRecordFolder' }); });

  // "..." always opens the native OS folder dialog on the host.
  $('btnOpenDir').onclick = () => { toast('Opening folder dialog on host…'); send({ cmd: 'browseFolder' }); };
  // Typing + Enter in the browse field sets the path without a dialog.
  $('browseDir').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const v = ($('browseDir').value || '').trim();
      if (v) send({ cmd: 'setBrowseDir', dir: v });
    }
  };

  $('btnUploadLog')?.addEventListener('click', () => $('uploadLogInput')?.click());
  $('uploadLogInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const res = await fetch(`/upload-log?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const json = await res.json();
      if (json.ok) { toast(`Uploaded ${json.name}`); send({ cmd: 'listLogs' }); }
      else toast('⚠ Upload failed');
    } catch { toast('⚠ Upload failed'); }
  });

  renderSiteAppNamesTable = function() {
    const tbody = $('siteAppNamesTable').querySelector('tbody');
    const rows = [
      ...Object.entries(siteNames).map(([id, name]) => ({ type: 'site', id, name })),
      ...Object.entries(appNames).map(([id, name]) => ({ type: 'app', id, name })),
    ];
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.type}</td><td>${escapeHtml(String(r.id))}</td><td>${escapeHtml(r.name)}</td>
        <td><button class="mini" data-del-type="${r.type}" data-del-id="${r.id}">✕</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('[data-del-type]').forEach(btn => {
      btn.onclick = () => {
        if (btn.dataset.delType === 'site') delete siteNames[btn.dataset.delId];
        else delete appNames[btn.dataset.delId];
        renderSiteAppNamesTable();
        send({ cmd: 'setSiteAppNames', siteNames, appNames });
      };
    });
  }
  $('btnAddName').onclick = () => {
    const type = $('nameType').value;
    const id = String(parseInt($('nameId').value, 10));
    const name = ($('nameLabel').value || '').trim();
    if (!id || id === 'NaN' || !name) return;
    if (type === 'site') siteNames[id] = name; else appNames[id] = name;
    $('nameId').value = ''; $('nameLabel').value = '';
    renderSiteAppNamesTable();
    send({ cmd: 'setSiteAppNames', siteNames, appNames });
  };

  function updateFilterIndicators() {
    function isActive(filterEl, versionEl, siteEl, appEl) {
      const t = filterPayload(filterEl); const v = filterPayload(versionEl);
      const s = parseIdList((siteEl?.value || '')); const a = parseIdList((appEl?.value || ''));
      return t.length > 0 || v.length > 0 || s.length > 0 || a.length > 0;
    }
    const capActive = isActive($('recFilter'), $('recVersionFilter'), $('recSiteIds'), $('recAppIds'));
    const repActive = isActive($('repFilter'), $('repVersionFilter'), $('repSiteIds'), $('repAppIds'));
    $('viewFilterIcon').classList.toggle('hidden', !capActive);
    $('viewFilterPill').classList.toggle('hidden', !capActive);
    $('replayFilterIcon').classList.toggle('hidden', !repActive);
    $('replayFilterPill').classList.toggle('hidden', !repActive);
  }

  $('mapSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    $('mapSettingsPopup').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('mapSettingsPopup')?.classList.add('hidden'));

  $('monitorSettings').addEventListener('click', (e) => {
    e.stopPropagation();
    $('monitorSettingsPopup').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('monitorSettingsPopup')?.classList.add('hidden'));
  $('mapSettingsPopup')?.addEventListener('click', (e) => e.stopPropagation());
  $('monitorSettingsPopup')?.addEventListener('click', (e) => e.stopPropagation());
  $('entityTimeoutSecs').onchange = () => {
    const v = Math.max(1, +$('entityTimeoutSecs').value || 10);
    entityTimeoutMs = v * 1000;
    $('entityTimeoutSecs').value = v;
    send({ cmd: 'setEntityTimeout', secs: v });
  };

  $('mapInfo').addEventListener('click', () => {
    const next = !$('mapTiles').checked;
    $('mapTiles').checked = next;
    window.MapView.setTiles(next, $('mapInfo'));
    saveMapSettings();
  });
  $('mapTiles').onchange = () => { window.MapView.setTiles($('mapTiles').checked, $('mapInfo')); saveMapSettings(); };
  $('mapFollow').onchange = () => { window.MapView.setFollow($('mapFollow').checked); saveMapSettings(); };
  $('mapDirections').onchange = () => { window.MapView.setShowDirections($('mapDirections').checked); saveMapSettings(); };
  $('mapDR').onchange = () => {
    const on = $('mapDR').checked;
    $('mapBoth').disabled = !on;
    if (!on) $('mapBoth').checked = false;
    window.MapView.setShowDR(on, $('mapBoth').checked);
    saveMapSettings();
  };
  $('mapBoth').onchange = () => { window.MapView.setShowDR($('mapDR').checked, $('mapBoth').checked); saveMapSettings(); };
  $('mapBoth').disabled = true;
  $('symScale').addEventListener('input', () => { window.MapView.setSymbolSize(+$('symScale').value); saveMapSettings(); });
  $('mapHistory').onchange = () => {
    const on = $('mapHistory').checked;
    $('historyLengthRow').style.display = on ? '' : 'none';
    $('historyColorRow').style.display = on ? '' : 'none';
    window.MapView.setHistory(on, +$('historyLength').value, $('historyColor').value);
    saveMapSettings();
  };
  $('historyLength').addEventListener('input', () => {
    window.MapView.setHistory($('mapHistory').checked, +$('historyLength').value, $('historyColor').value);
    saveMapSettings();
  });
  $('historyColor').addEventListener('input', () => {
    window.MapView.setHistory($('mapHistory').checked, +$('historyLength').value, $('historyColor').value);
    saveMapSettings();
  });
  $('mapShowMunitions').onchange = () => { window.MapView.setShowMunitions($('mapShowMunitions').checked); saveMapSettings(); };
  $('mapShowDesignations').onchange = () => { window.MapView.setShowDesignations($('mapShowDesignations').checked); saveMapSettings(); };
  $('mapShowDetonations').onchange = () => { window.MapView.setShowDetonations($('mapShowDetonations').checked); saveMapSettings(); };
  $('mapSatellite').onchange = () => { window.MapView.setSatellite($('mapSatellite').checked); saveMapSettings(); };
  // Force filter buttons
  document.querySelectorAll('.force-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const active = Array.from(document.querySelectorAll('.force-btn.active')).map(b => +b.dataset.force);
      window.MapView.setForceFilter(active.length < 4 ? new Set(active) : null);
      saveMapSettings();
    });
  });
  // Restore persisted map settings
  const ms = loadMapSettings();
  if (ms) {
    if (ms.follow !== undefined)      { $('mapFollow').checked = ms.follow; window.MapView.setFollow(ms.follow); }
    if (ms.directions !== undefined)  { $('mapDirections').checked = ms.directions; window.MapView.setShowDirections(ms.directions); }
    if (ms.symScale !== undefined)    { $('symScale').value = ms.symScale; window.MapView.setSymbolSize(ms.symScale); }
    if (ms.munitions !== undefined)   { $('mapShowMunitions').checked = ms.munitions; window.MapView.setShowMunitions(ms.munitions); }
    if (ms.designations !== undefined){ $('mapShowDesignations').checked = ms.designations; window.MapView.setShowDesignations(ms.designations); }
    if (ms.detonations !== undefined) { $('mapShowDetonations').checked = ms.detonations; window.MapView.setShowDetonations(ms.detonations); }
    if (ms.historyColor !== undefined){ $('historyColor').value = ms.historyColor; }
    if (ms.historyLength !== undefined){ $('historyLength').value = ms.historyLength; }
    if (ms.history !== undefined && ms.history) {
      $('mapHistory').checked = true;
      $('historyLengthRow').style.display = '';
      $('historyColorRow').style.display = '';
      window.MapView.setHistory(true, ms.historyLength ?? 100, ms.historyColor ?? '#f0c674');
    }
    if (ms.dr !== undefined && ms.dr) {
      $('mapDR').checked = true;
      $('mapBoth').disabled = false;
      if (ms.both) { $('mapBoth').checked = true; }
      window.MapView.setShowDR(ms.dr, ms.both ?? false);
    }
    if (ms.forceFilter !== undefined && ms.forceFilter.length < 4) {
      document.querySelectorAll('.force-btn').forEach(b => {
        const active = ms.forceFilter.includes(+b.dataset.force);
        b.classList.toggle('active', active);
      });
      window.MapView.setForceFilter(new Set(ms.forceFilter));
    }
    if (ms.satellite !== undefined && ms.satellite) {
      $('mapSatellite').checked = true;
      window.MapView.setSatellite(true);
    }
    // Tiles last (async, triggers map init)
    if (ms.tiles !== undefined && ms.tiles) {
      $('mapTiles').checked = true;
      window.MapView.setTiles(true, $('mapInfo'));
    }
  }

  $('mapReset').onclick = () => window.MapView.resetView();
  $('mapExpand').onclick = () => {
    const main = document.querySelector('main');
    const expanded = main.classList.toggle('map-expanded');
    $('mapExpand').textContent = expanded ? '⊡' : '⛶';
    $('mapExpand').title = expanded ? 'Restore map' : 'Fullscreen';
    setTimeout(() => window.MapView.resize(), 50);
  };
  window.MapView.setTiles(false, $('mapInfo'));
  setRecording(false);

  setupPieTooltips();

  $('consoleTab').addEventListener('click', () => {
    const open = $('consoleDrawer').classList.toggle('open');
    $('consoleChevron').textContent = open ? '▼' : '▲';
  });

  $('entityTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const key = tr.dataset.key;
    const entity = lastStats?.entities?.find(x => x.key === key);
    if (entity) { selectItem(key, 'entity', entity); window.MapView.showCallout(buildMapCallout(entity)); }
  });
  $('emitterTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const key = tr.dataset.key;
    const emitter = lastStats?.emitters?.find(x => x._key === key);
    if (emitter) selectItem(key, 'emitter', emitter);
  });
  $('firesTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const idx = +tr.dataset.key;
    const f = firesRowData.get(idx);
    if (f == null) return;
    lastDetailsSerial = null;
    selectedKey = `fire_${idx}`; selectedType = 'fire';
    renderDetails(f); applyTableSelection();
  });
  $('detsTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const idx = +tr.dataset.key;
    const d = detsRowData.get(idx);
    if (d == null) return;
    lastDetailsSerial = null;
    selectedKey = `det_${idx}`; selectedType = 'detonation';
    renderDetails(d); applyTableSelection();
  });
  $('txTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const t = lastStats?.transmitters?.find(x => x._key === tr.dataset.key);
    if (t) selectItem(tr.dataset.key, 'transmitter', t);
  });
  $('rxTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const r = lastStats?.receivers?.find(x => x._key === tr.dataset.key);
    if (r) selectItem(tr.dataset.key, 'receiver', r);
  });
  $('sigTable')?.addEventListener('click', e => {
    if (e.target.closest('.audio-gear-btn')) return;
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const sg = lastStats?.signals?.find(x => x._key === tr.dataset.key);
    if (sg) selectItem(tr.dataset.key, 'signal', sg);
  });
  $('icCtrlTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const ic = lastStats?.intercomControls?.find(x => x._key === tr.dataset.key);
    if (ic) selectItem(tr.dataset.key, 'ic-control', ic);
  });
  $('icSigTable')?.addEventListener('click', e => {
    if (e.target.closest('.audio-gear-btn')) return;
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const ic = lastStats?.intercomSignals?.find(x => x._key === tr.dataset.key);
    if (ic) selectItem(tr.dataset.key, 'ic-signal', ic);
  });
  $('icSigTable')?.addEventListener('click', e => {
    const btn = e.target.closest('.audio-gear-btn');
    if (btn) { e.stopPropagation(); showAudioPopup(btn.dataset.key, btn); }
  });
  $('setDataTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const sd = lastStats?.setData?.find(x => x._key === tr.dataset.key);
    if (sd) selectItem(tr.dataset.key, 'set-data', sd);
  });
  $('desigTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const d = lastStats?.designators?.find(x => x._key === tr.dataset.key);
    if (d) selectItem(tr.dataset.key, 'designator', d);
  });
  // Setup sortable columns and filter inputs for all monitor tables
  document.querySelectorAll('table[id] thead th[data-col]').forEach(th => {
    const tableId = th.closest('table').id;
    th.addEventListener('click', () => {
      const col = +th.dataset.col;
      const st = getTableState(tableId);
      if (st.sortCol === col) { st.sortDir *= -1; }
      else { st.sortCol = col; st.sortDir = 1; }
      updateSortIndicators(tableId);
      if (lastStats) renderStats(lastStats);
    });
  });
  document.querySelectorAll('table[id]').forEach(table => {
    const wrap = table.closest('.tablewrap');
    if (!wrap) return;
    const tableId = table.id;
    const inp = document.createElement('input');
    inp.type = 'search';
    inp.className = 'table-filter';
    inp.placeholder = 'Filter…';
    inp.addEventListener('input', () => {
      getTableState(tableId).filter = inp.value.trim();
      if (lastStats) renderStats(lastStats);
    });
    wrap.insertBefore(inp, table);
  });

  // PDU Monitor tabs
  document.querySelectorAll('.ptab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    t.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    const tab = t.dataset.ptab;
    document.querySelectorAll('.ptabbody').forEach(b => b.classList.toggle('hidden', b.id !== `ptab-${tab}`));
  }));

  // Ptab scroll buttons
  const ptabsScroll = $('ptabsScroll');
  const ptabScrollL = $('ptabScrollLeft');
  const ptabScrollR = $('ptabScrollRight');
  function updatePtabScrollBtns() {
    if (!ptabsScroll) return;
    const atLeft  = ptabsScroll.scrollLeft <= 0;
    const atRight = ptabsScroll.scrollLeft + ptabsScroll.clientWidth >= ptabsScroll.scrollWidth - 1;
    ptabScrollL?.classList.toggle('invisible', atLeft);
    ptabScrollR?.classList.toggle('invisible', atRight);
  }
  ptabScrollL?.addEventListener('click', () => ptabsScroll?.scrollBy({ left: -140, behavior: 'smooth' }));
  ptabScrollR?.addEventListener('click', () => ptabsScroll?.scrollBy({ left: 140, behavior: 'smooth' }));
  ptabsScroll?.addEventListener('scroll', updatePtabScrollBtns);
  if (ptabsScroll) new ResizeObserver(updatePtabScrollBtns).observe(ptabsScroll);
  updatePtabScrollBtns();

  // Tick the "X s ago" display in the details pane every second
  setInterval(() => {
    const agoEl = document.getElementById('details-ago');
    if (!agoEl) return;
    const ts = parseInt(agoEl.dataset.ts, 10);
    if (!ts) return;
    const ageMs = Date.now() - ts;
    const ageSecs = Math.round(ageMs / 1000);
    agoEl.textContent = `· ${ageSecs}s ago`;
    agoEl.className = 'ago-timer' +
      (ageMs >= entityTimeoutMs     ? ' stale-red'
     : ageMs >= entityTimeoutMs / 2 ? ' stale-amber'
     : '');
  }, 1000);

  // Audio popup — persistent controls, no innerHTML replacement during interaction
  $('audioPanSlider').oninput = () => {
    if (_audioPopupKey) window.AudioMgr?.setPan(_audioPopupKey, +$('audioPanSlider').value / 100);
  };
  $('audioVolSlider').oninput = () => {
    if (_audioPopupKey) window.AudioMgr?.setGain(_audioPopupKey, +$('audioVolSlider').value / 100);
  };
  $('audioMuteBtn').onclick = () => {
    if (!_audioPopupKey) return;
    const ch = window.AudioMgr?.getChannels().find(c => c.key === _audioPopupKey);
    window.AudioMgr?.setMute(_audioPopupKey, !ch?.muted);
    const nowMuted = !ch?.muted;
    $('audioMuteBtn').textContent = nowMuted ? 'Unmute' : 'Mute';
    $('audioMuteBtn').classList.toggle('muted', nowMuted);
  };
  document.addEventListener('click', e => {
    if (!$('audioPopup').classList.contains('hidden') &&
        !$('audioPopup').contains(e.target) &&
        !e.target.closest('.audio-gear-btn')) {
      $('audioPopup').classList.add('hidden');
      _audioPopupKey = null;
    }
  });
  // Gear button clicks in signals table
  $('sigTable')?.addEventListener('click', e => {
    const btn = e.target.closest('.audio-gear-btn');
    if (btn) { e.stopPropagation(); showAudioPopup(btn.dataset.key, btn); }
  });
  // Audio device selector — wire once; populated when popup opens
  const audioSel = $('audioDevice');
  if (audioSel) audioSel.onchange = () => window.AudioMgr?.setOutputDevice(audioSel.value);

  // Column resize handle (desktop)
  const colHandle = document.getElementById('colResizeHandle');
  if (colHandle) {
    const mainEl = document.querySelector('main');
    let dragStartX = 0, dragStartW = 0;
    const savedW = localStorage.getItem('diskit-col1');
    if (savedW) mainEl.style.setProperty('--col1', savedW);
    colHandle.addEventListener('pointerdown', e => {
      dragStartX = e.clientX;
      dragStartW = parseInt(getComputedStyle(mainEl).getPropertyValue('--col1')) || 320;
      colHandle.classList.add('dragging');
      colHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    colHandle.addEventListener('pointermove', e => {
      if (!colHandle.classList.contains('dragging')) return;
      const w = Math.max(180, Math.min(560, dragStartW + (e.clientX - dragStartX)));
      mainEl.style.setProperty('--col1', w + 'px');
    });
    colHandle.addEventListener('pointerup', () => {
      colHandle.classList.remove('dragging');
      localStorage.setItem('diskit-col1', mainEl.style.getPropertyValue('--col1'));
    });
  }

  // Vertical resize handle (right column split: stats/monitor vs map/details)
  const vertHandle = document.getElementById('vertResizeHandle');
  if (vertHandle) {
    const mainEl = document.querySelector('main');
    let vStartX = 0, vStartW = 0;
    const savedCol3 = localStorage.getItem('diskit-col3');
    if (savedCol3) mainEl.style.setProperty('--col3', savedCol3);
    vertHandle.addEventListener('pointerdown', e => {
      vStartX = e.clientX;
      vStartW = document.querySelector('.stats')?.getBoundingClientRect().width ?? 400;
      vertHandle.classList.add('dragging');
      vertHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    vertHandle.addEventListener('pointermove', e => {
      if (!vertHandle.classList.contains('dragging')) return;
      const w = Math.max(150, vStartW + (e.clientX - vStartX));
      mainEl.style.setProperty('--col3', w + 'px');
    });
    vertHandle.addEventListener('pointerup', () => {
      vertHandle.classList.remove('dragging');
      localStorage.setItem('diskit-col3', mainEl.style.getPropertyValue('--col3'));
    });
  }

  // Horizontal resize handle (row split: stats/map vs monitor/details)
  const horizHandle = document.getElementById('horizResizeHandle');
  if (horizHandle) {
    const mainEl = document.querySelector('main');
    let hStartY = 0, hStartH = 0;
    const savedRow1 = localStorage.getItem('diskit-row1');
    if (savedRow1) mainEl.style.setProperty('--row1', savedRow1);
    horizHandle.addEventListener('pointerdown', e => {
      hStartY = e.clientY;
      hStartH = document.querySelector('.stats')?.getBoundingClientRect().height ?? 300;
      horizHandle.classList.add('dragging');
      horizHandle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    horizHandle.addEventListener('pointermove', e => {
      if (!horizHandle.classList.contains('dragging')) return;
      const h = Math.max(80, hStartH + (e.clientY - hStartY));
      mainEl.style.setProperty('--row1', h + 'px');
    });
    horizHandle.addEventListener('pointerup', () => {
      horizHandle.classList.remove('dragging');
      localStorage.setItem('diskit-row1', mainEl.style.getPropertyValue('--row1'));
    });
  }

  // Panel collapse toggles (mobile)
  document.querySelectorAll('.panel-toggle-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const panel = btn.closest('.panel');
      if (!panel) return;
      const collapsed = panel.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
    });
  });

  connect();
}
document.addEventListener('DOMContentLoaded', init);
