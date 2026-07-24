// Web UI controller: WebSocket link to the server, control commands, and live
// rendering of stats, entity table, emitter table, PDU-type chart and feed.

const DIS_VERSIONS = {
  4: 'IEEE 1278-1993',
  5: 'IEEE 1278.1-1995',
  6: 'IEEE 1278.1a-1998',
  7: 'IEEE 1278.1-2012',
};

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

let ws;
let logs = [];
let appMode = 'idle';
let pendingSeek = null;       // offsetMicros to seek to once replay starts
let playerState = 'idle';     // last reported replay state (playing|paused|stopped)
let replayBookmarks = [];     // bookmarks of the loaded/selected replay log
let replayDurationMs = 0;     // duration of the selected replay log

function $(id) { return document.getElementById(id); }

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
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

// ---- incoming messages -----------------------------------------------------
function handle(m) {
  switch (m.kind) {
    case 'hello':
      applyConfig(m.config); $('recDir').value = m.recordDir || ''; $('browseDir').value = m.browseDir || '';
      logs = m.logs || []; renderLogs(); setMode(m.mode); setRecording(m.recording, m.recordStartMs); break;
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
      toast(`Bookmarked: ${m.bookmark?.label || ''}`); $('bmLabel').value = ''; break;
    case 'dirs':
      if (m.recordDir) $('recDir').value = m.recordDir;
      if (m.browseDir) $('browseDir').value = m.browseDir;
      if (m.message) toast(m.message); break;
    case 'logs':
      logs = m.logs || []; if (m.browseDir) $('browseDir').value = m.browseDir; renderLogs(); break;
    case 'recordingStopped':
      toast(`Saved ${m.result?.records || 0} records`); send({ cmd: 'listLogs' }); break;
    case 'replayEnded': toast(`Replay finished (${m.sentCount} PDUs, ${m.loops} loops)`); break;
    case 'pcapExported': toast(`Exported ${m.file} (${m.packets} packets)`); send({ cmd: 'listLogs' }); break;
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
  $('capPort').value = c.capture.port;
  $('capGroup').value = c.capture.multicastGroup;
  $('capBind').value = c.capture.bindAddress;
  $('repDest').value = c.replay.destAddress;
  $('repPort').value = c.replay.destPort;
}

function setMode(mode) {
  appMode = mode;
  const b = $('modeBadge');
  b.textContent = mode; b.className = 'badge ' + mode;
  if (mode !== 'replaying') { playerState = 'idle'; $('btnPause').textContent = '⏸ Pause'; }
  const listening = mode === 'capturing';
  $('btnListen').textContent = listening ? '◉ Listening…' : 'Start Listening';
  $('btnListen').className   = listening ? 'active' : 'primary';
  $('btnPlay').className     = mode === 'replaying' ? 'active' : 'primary';
}

function setRecording(on, startMs, bytes) {
  const badge = $('recBadge');
  badge.classList.toggle('hidden', !on);
  if (on) badge.textContent = `● REC ${hms(Date.now() - (startMs || Date.now()))} · ${fmtBytes(bytes)}`;
  $('btnRecord').disabled = !!on;
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

function renderStats(s) {
  if (!s) return;
  $('mPdus').textContent = fmt(s.totalPdus);
  $('mRate').textContent = s.pduRate;
  $('mEntities').textContent = s.entityCount;
  $('mEmitters').textContent = s.emitterCount;
  $('mBytes').textContent = Math.round(s.totalBytes / 1024);

  $('typeChart').innerHTML = s.types.map((t, i) => {
    const col = PIE_COLORS[i % PIE_COLORS.length];
    return `<div class="bar">
      <span class="name" title="${t.name}"><span class="swatch" style="background:${col}"></span>${t.type} ${t.name}</span>
      <span class="val">${fmt(t.count)}</span>
    </div>`;
  }).join('');
  drawPie(s.types);
  drawSmallPie('sitePie', s.sites);
  drawSmallPie('appPie',  s.apps);
  const leg = $('siteAppLegend');
  const rows = [
    ...(s.sites || []).slice(0, 4).map((x, i) => `<div class="bar"><span class="name"><span class="swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>Site ${x.id}</span><span class="val">${fmt(x.count)}</span></div>`),
    ...(s.apps  || []).slice(0, 4).map((x, i) => `<div class="bar"><span class="name"><span class="swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>App ${x.id}</span><span class="val">${fmt(x.count)}</span></div>`),
  ];
  if (leg) leg.innerHTML = rows.join('');

  const eb = $('entityTable').querySelector('tbody');
  eb.innerHTML = s.entities.map((e) => `
    <tr>
      <td><span class="dot f${e.forceId}"></span>${e.marking || ''}</td>
      <td>${e.force || ''}</td><td>${e.kind || ''}</td>
      <td>${fnum(e.lat, 4)}</td><td>${fnum(e.lon, 4)}</td>
      <td>${fnum(e.alt, 0)}</td><td>${fnum(e.heading, 0)}</td><td>${fnum(e.speed, 0)}</td>
    </tr>`).join('');

  const mb = $('emitterTable').querySelector('tbody');
  mb.innerHTML = s.emitters.map((r) => `
    <tr><td>${r.entity}</td><td>${r.emitter}</td><td>${r.function}</td>
    <td>${r.band}</td><td>${r.freqMHz}</td><td>${r.prf}</td><td>${r.erp}</td></tr>`).join('');

  window.MapView.update(s.entities);
}
function fnum(v, d) { return (v === undefined || v === null || !isFinite(v)) ? '' : Number(v).toFixed(d); }

// Donut/pie chart of PDU type distribution (same colour order as the bars).
function drawPie(types) {
  const c = $('pieChart');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 3;
  ctx.clearRect(0, 0, w, h);
  const total = (types || []).reduce((s, t) => s + t.count, 0);
  if (!total) {
    ctx.fillStyle = '#5c6b7a'; ctx.font = '11px system-ui';
    ctx.textAlign = 'center'; ctx.fillText('no data', cx, cy); ctx.textAlign = 'start';
    return;
  }
  let a = -Math.PI / 2;
  types.forEach((t, i) => {
    const a2 = a + (t.count / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a2); ctx.closePath();
    ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length]; ctx.fill();
    a = a2;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.56, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22'; ctx.fill();
  ctx.fillStyle = '#d7dde5'; ctx.font = 'bold 16px system-ui';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(fmt(total), cx, cy - 5);
  ctx.fillStyle = '#8b97a7'; ctx.font = '9px system-ui'; ctx.fillText('PDUs', cx, cy + 9);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

function drawSmallPie(canvasId, data) {
  const c = $(canvasId);
  if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 2;
  ctx.clearRect(0, 0, w, h);
  const total = (data || []).reduce((s, d) => s + d.count, 0);
  if (!total) {
    ctx.fillStyle = '#5c6b7a'; ctx.font = '9px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('no data', cx, cy);
    ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; return;
  }
  let a = -Math.PI / 2;
  data.forEach((d, i) => {
    const a2 = a + (d.count / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a, a2); ctx.closePath();
    ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length]; ctx.fill(); a = a2;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.52, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22'; ctx.fill();
}

let feedLines = [];
function renderFeed(samples) {
  if (!samples || !samples.length) return;
  for (const s of samples) feedLines.push(`<div class="t${s.type}">${ts()} ${s.name}${s.key ? ' ' + s.key : ''}</div>`);
  if (feedLines.length > 200) feedLines = feedLines.slice(-200);
  const el = $('feed');
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  el.innerHTML = feedLines.join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}
function ts() { const d = new Date(); return d.toTimeString().slice(0, 8); }

function renderLogs() {
  const sel = $('logSelect');
  const prev = sel.value;
  sel.innerHTML = logs.map((l) => `<option value="${l.file}">${l.file}</option>`).join('');
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
  window.MapView.init();
  buildMultiselect($('recFilter'),        PDU_TYPES,    'All PDU types');
  buildMultiselect($('repFilter'),        PDU_TYPES,    'All PDU types');
  buildMultiselect($('recVersionFilter'), DIS_VERSIONS, 'All versions', (v, n) => `v${v} — ${n}`);
  buildMultiselect($('repVersionFilter'), DIS_VERSIONS, 'All versions', (v, n) => `v${v} — ${n}`);
  document.addEventListener('click', () => document.querySelectorAll('.multiselect.open').forEach(el => el.classList.remove('open')));

  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
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
  $('btnExportPcap').onclick = () => $('logSelect').value && send({ cmd: 'exportPcap', file: $('logSelect').value });
  $('btnDeleteLog').onclick = () => $('logSelect').value &&
    confirm('Delete ' + $('logSelect').value + '?') && send({ cmd: 'deleteLog', file: $('logSelect').value });

  // Multicast group inputs are only relevant when the multicast box is ticked.
  const bindMulti = (chk, grp) => {
    const sync = () => { $(grp).disabled = !$(chk).checked; };
    $(chk).onchange = sync; sync();
  };
  bindMulti('capMulti', 'capGroup');
  bindMulti('repMulti', 'repGroup');

  // Log directory controls.
  $('btnSetRecDir').onclick = () => $('recDir').value && send({ cmd: 'setRecordDir', dir: $('recDir').value });
  $('btnOpenDir').onclick = () => $('browseDir').value && send({ cmd: 'setBrowseDir', dir: $('browseDir').value });

  $('mapTiles').onchange = () => window.MapView.setTiles($('mapTiles').checked, $('mapInfo'));
  $('mapReset').onclick = () => window.MapView.resetView();
  window.MapView.setTiles(false, $('mapInfo'));
  setRecording(false);

  connect();
}
document.addEventListener('DOMContentLoaded', init);
