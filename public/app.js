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
let selectedType = null;      // 'entity' | 'emitter'
let lastStats = null;
let lastDetailsSerial = null; // skip detail re-render when data is unchanged
const sidcSvgCache = new Map(); // SIDC string → SVG string (keyed by full 20-char SIDC)
let entityTimeoutMs = 10000;  // from config.entityTimeoutSecs; amber at ½, red at full
let siteNames = {};  // { "100": "Site A" }
const dataRateHistory = [];
const pduRateHistory = [];
const RATE_HISTORY_MAX = 240;
let appNames = {};   // { "1": "Blue Force" }

function $(id) { return document.getElementById(id); }

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => {
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
      if (m.networkAdapters) populateAdapters(m.networkAdapters, m.config?.capture?.bindAddress);
      applyConfig(m.config); $('recDir').value = m.recordDir || ''; $('browseDir').value = m.browseDir || '';
      if (m.config?.entityTimeoutSecs) {
        entityTimeoutMs = m.config.entityTimeoutSecs * 1000;
        if ($('entityTimeoutSecs')) $('entityTimeoutSecs').value = m.config.entityTimeoutSecs;
      }
      if (m.config?.siteNames) { siteNames = m.config.siteNames; }
      if (m.config?.appNames)  { appNames  = m.config.appNames;  }
      if (typeof renderSiteAppNamesTable === 'function') renderSiteAppNamesTable();
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

  const eb = $('entityTable').querySelector('tbody');
  const nowMs = Date.now();
  eb.innerHTML = s.entities.map((e) => {
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

  const mb = $('emitterTable').querySelector('tbody');
  mb.innerHTML = s.emitters.map((r) => `
    <tr data-key="${escapeHtml(r._key || r.entity + '|' + (r.emitter || ''))}">
      <td>${escapeHtml(r.entity)}</td><td>${escapeHtml(String(r.emitterName ?? r.emitter ?? ''))}</td>
      <td>${escapeHtml(r.beamFunction || r['function'] || '')}</td>
      <td>${escapeHtml(r.band || '')}</td><td>${r.freqMHz}</td><td>${r.prf}</td><td>${r.erp}</td>
    </tr>`).join('');

  const txb = $('txTableBody');
  if (txb) {
    txb.innerHTML = (s.transmitters || []).map(t => `
      <tr data-key="${escapeHtml(t._key)}"${t.txState === 2 ? ' class="tx-active"' : ''}>
        <td>${escapeHtml(t.entityKey)}</td><td>${t.radioId}</td>
        <td>${escapeHtml(t.txStateName)}</td><td>${t.freqMHz}</td>
        <td>${escapeHtml(t.band || '—')}</td><td>${t.power}</td>
      </tr>`).join('');
  }
  const sigb = $('sigTableBody');
  if (sigb) {
    sigb.innerHTML = (s.signals || []).map(sg => `
      <tr data-key="${escapeHtml(sg._key)}">
        <td>${escapeHtml(sg.entityIdKey)}</td><td>${sg.radioId}</td>
        <td>${escapeHtml(sg.encodingClassName || '—')}</td>
        <td>${escapeHtml(sg.tdlTypeName || '—')}</td>
        <td>${sg.sampleRate || 0}</td><td>${sg.dataLengthBits || 0}</td>
      </tr>`).join('');
  }

  const fb = $('firesTableBody');
  if (fb) {
    fb.innerHTML = (s.fires || []).map((f, i) => `
      <tr data-key="${i}">
        <td>${ts2(f.ts)}</td><td>${escapeHtml(f.firingKey)}</td>
        <td>${escapeHtml(f.targetKey || '—')}</td>
        <td>${escapeHtml(f.munitionType || '—')}</td>
        <td>${f.range != null ? fnum(f.range, 0) + ' m' : '—'}</td>
      </tr>`).join('');
  }
  const db = $('detsTableBody');
  if (db) {
    db.innerHTML = (s.detonations || []).map((d, i) => `
      <tr data-key="${i}">
        <td>${ts2(d.ts)}</td><td>${escapeHtml(d.firingKey)}</td>
        <td>${escapeHtml(d.targetKey || '—')}</td>
        <td>${escapeHtml(d.munitionType || '—')}</td>
        <td>${escapeHtml(d.result || '—')}</td>
      </tr>`).join('');
  }

  // Persist selection highlight across re-renders; refresh details if data changed
  lastStats = s;
  if (selectedKey) {
    const ent  = selectedType === 'entity'      ? s.entities?.find(x => x.key === selectedKey)     : null;
    const emit = selectedType === 'emitter'     ? s.emitters?.find(x => x._key === selectedKey)    : null;
    const tx   = selectedType === 'transmitter' ? s.transmitters?.find(x => x._key === selectedKey): null;
    const sig  = selectedType === 'signal'      ? s.signals?.find(x => x._key === selectedKey)     : null;
    const fresh = ent || emit || tx || sig;
    if (fresh) renderDetails(fresh);
    else if (!selectedType?.startsWith('fire') && !selectedType?.startsWith('det')) {
      selectedKey = null; selectedType = null; renderDetails(null);
    }
  }
  applyTableSelection();

  window.MapView.update(s.entities);
}
function fnum(v, d) { return (v === undefined || v === null || !isFinite(v)) ? '' : Number(v).toFixed(d); }

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
  tbl('sigTable', 'signal');
  // fires/detonations use index as key
  document.querySelectorAll('#firesTable tbody tr').forEach(r =>
    r.classList.toggle('selected', selectedType === 'fire' && selectedKey === `fire_${r.dataset.key}`));
  document.querySelectorAll('#detsTable tbody tr').forEach(r =>
    r.classList.toggle('selected', selectedType === 'detonation' && selectedKey === `det_${r.dataset.key}`));
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
        ${typeLabel ? `<dt>Inferred Type</dt><dd class="detail-wide-value">${escapeHtml(typeLabel)}</dd>` : ''}
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
    el.innerHTML = `<dl class="detail-list">
      <dt class="detail-section">Transmitter</dt>
      <dt>Entity</dt><dd>${escapeHtml(t.entityKey||'—')}</dd>
      <dt>Radio ID</dt><dd>${t.radioId}</dd>
      <dt>Tx State</dt><dd>${escapeHtml(t.txStateName||'—')}</dd>
      <dt>Frequency</dt><dd>${t.freqMHz} MHz</dd>
      <dt>Band</dt><dd>${escapeHtml(t.band||'—')}</dd>
      <dt>Power</dt><dd>${t.power} dBm</dd>
      ${t.geo ? `
      <dt>Lat</dt><dd>${fnum(t.geo.lat,6)}</dd>
      <dt>Lon</dt><dd>${fnum(t.geo.lon,6)}</dd>
      <dt>Alt</dt><dd>${fnum(t.geo.alt,0)} m</dd>` : ''}
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

// ---- wiring ----------------------------------------------------------------
function init() {
  window.MapView.init({
    onEntityClick: (key) => {
      if (!key) {
        selectedKey = null; selectedType = null;
        applyTableSelection();
        window.MapView.setSelected(null);
        return;
      }
      const entity = lastStats?.entities?.find(x => x.key === key);
      if (entity) {
        selectItem(key, 'entity', entity);
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

  // Log directory controls.
  const doSetRecDir = () => {
    const v = ($('recDir').value || '').trim();
    if (v) send({ cmd: 'setRecordDir', dir: v });
    else send({ cmd: 'browseRecordFolder' });
  };
  const doOpenDir = () => {
    const v = ($('browseDir').value || '').trim();
    if (v) send({ cmd: 'setBrowseDir', dir: v });
    else send({ cmd: 'browseFolder' });
  };
  $('btnSetRecDir').onclick = doSetRecDir;
  $('recDir').onkeydown = (e) => { if (e.key === 'Enter') doSetRecDir(); };
  $('btnOpenDir').onclick = doOpenDir;
  $('browseDir').onkeydown = (e) => { if (e.key === 'Enter') doOpenDir(); };

  function renderSiteAppNamesTable() {
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
  });
  $('mapTiles').onchange = () => window.MapView.setTiles($('mapTiles').checked, $('mapInfo'));
  $('mapFollow').onchange = () => window.MapView.setFollow($('mapFollow').checked);
  $('mapDirections').onchange = () => window.MapView.setShowDirections($('mapDirections').checked);
  $('mapDR').onchange = () => {
    const on = $('mapDR').checked;
    $('mapBoth').disabled = !on;
    if (!on) $('mapBoth').checked = false;
    window.MapView.setShowDR(on, $('mapBoth').checked);
  };
  $('mapBoth').onchange = () => window.MapView.setShowDR($('mapDR').checked, $('mapBoth').checked);
  $('mapBoth').disabled = true;
  $('symScale').addEventListener('input', () => window.MapView.setSymbolSize(+$('symScale').value));
  $('mapHistory').onchange = () => {
    const on = $('mapHistory').checked;
    $('historyLengthRow').style.display = on ? '' : 'none';
    $('historyColorRow').style.display = on ? '' : 'none';
    window.MapView.setHistory(on, +$('historyLength').value, $('historyColor').value);
  };
  $('historyLength').addEventListener('input', () =>
    window.MapView.setHistory($('mapHistory').checked, +$('historyLength').value, $('historyColor').value));
  $('historyColor').addEventListener('input', () =>
    window.MapView.setHistory($('mapHistory').checked, +$('historyLength').value, $('historyColor').value));
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
    if (entity) selectItem(key, 'entity', entity);
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
    const f = lastStats?.fires?.[idx];
    if (f != null) { selectedKey = `fire_${idx}`; selectedType = 'fire'; renderDetails(f); applyTableSelection(); }
  });
  $('detsTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const idx = +tr.dataset.key;
    const d = lastStats?.detonations?.[idx];
    if (d != null) { selectedKey = `det_${idx}`; selectedType = 'detonation'; renderDetails(d); applyTableSelection(); }
  });
  $('txTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const t = lastStats?.transmitters?.find(x => x._key === tr.dataset.key);
    if (t) selectItem(tr.dataset.key, 'transmitter', t);
  });
  $('sigTable')?.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    const sg = lastStats?.signals?.find(x => x._key === tr.dataset.key);
    if (sg) selectItem(tr.dataset.key, 'signal', sg);
  });
  // PDU Monitor tabs
  document.querySelectorAll('.ptab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.ptab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const tab = t.dataset.ptab;
    document.querySelectorAll('.ptabbody').forEach(b => b.classList.toggle('hidden', b.id !== `ptab-${tab}`));
  }));

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

  connect();
}
document.addEventListener('DOMContentLoaded', init);
