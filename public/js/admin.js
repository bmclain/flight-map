// Control panel: edits data/config.json through the API. Changes reach every
// open display immediately after saving.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import { compassPoint, compassWord, normalizeDeg } from '/shared/geo.js';
import { distanceUnit, formatDistance, joinUnit, kmToUnit, unitToKm } from '/shared/units.js';
import { TILE_PROVIDERS, tileSpec } from '/shared/tiles.js';
import { SPECIAL_KINDS, SPECIAL_LABELS } from '/shared/special-kinds.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

let saved = null;
let draft = null;
let authRequired = false;

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const k of keys) o = o[k];
  o[last] = value;
}

const units = () => draft.display.units;
const stepDecimals = (step) => (step && step !== 'any' ? (step.split('.')[1] ?? '').length : 5);
/** Number → string with at most `decimals` places and no trailing zeros. */
const fmt = (v, decimals) => (Number.isFinite(v) ? String(Number(v.toFixed(decimals))) : '');

// ---- form binding ------------------------------------------------------------------

function readInput(el) {
  const kind = el.dataset.kind;
  if (kind === 'list') {
    return $$(`[data-path="${el.dataset.path}"][data-kind="list"]`)
      .filter((x) => x.checked)
      .map((x) => x.value);
  }
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'number' || el.type === 'range') {
    if (el.value === '') return undefined;
    const n = Number(el.value);
    return kind === 'distance' ? unitToKm(n, units()) : n;
  }
  return el.value;
}

function writeInput(el) {
  if (el === document.activeElement && el.type !== 'checkbox' && el.type !== 'radio') return;
  const v = getPath(draft, el.dataset.path);
  if (el.dataset.kind === 'list') el.checked = Array.isArray(v) && v.includes(el.value);
  else if (el.type === 'checkbox') el.checked = !!v;
  else if (el.type === 'radio') el.checked = el.value === v;
  else if (el.dataset.kind === 'distance') el.value = fmt(kmToUnit(v, units()), 1);
  else if (el.type === 'number' || el.type === 'range') el.value = fmt(v, stepDecimals(el.step));
  else el.value = v ?? '';
}

function render() {
  renderStyleOptions();
  for (const el of $$('[data-path]')) writeInput(el);
  for (const el of $$('[data-unit="distance"]')) el.textContent = distanceUnit(units());
  for (const el of $$('[data-show]')) {
    const [path, value] = el.dataset.show.split('=');
    el.classList.toggle('shown', value.split('|').includes(String(getPath(draft, path))));
  }
  renderDial();
  renderLocation();
  renderSpecial();
  renderStylePreviews();
  updateSavebar();
}

function onInput(e) {
  const el = e.target.closest('[data-path]');
  if (!el) return;
  if (el.type === 'radio' && !el.checked) return;
  const v = readInput(el);
  if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return;
  setPath(draft, el.dataset.path, v);
  // Style names are per provider: start the new one on its defaults.
  if (el.dataset.path === 'map.tiles') draft.map.dayStyle = draft.map.nightStyle = '';
  el.classList.remove('invalid');
  render();
}
document.addEventListener('input', onInput);
document.addEventListener('change', onInput);

// ---- map styles ----------------------------------------------------------------------

let styleOptionsFor = null;
/** Fill the daytime / night style pickers with the chosen provider's styles. */
function renderStyleOptions() {
  const p = TILE_PROVIDERS[draft.map.tiles];
  if (!p || styleOptionsFor === draft.map.tiles) return;
  styleOptionsFor = draft.map.tiles;
  for (const sel of $$('select[data-styles]')) {
    const def = p.styles[sel.dataset.styles === 'light' ? p.day : p.night].label;
    sel.innerHTML =
      `<option value="">Default: ${esc(def)}</option>` +
      Object.entries(p.styles)
        .map(([id, s]) => `<option value="${esc(id)}">${esc(s.label)}</option>`)
        .join('');
  }
}

const stylePreviews = {};
/** Two small maps around the receiver in the chosen daytime and night styles. */
function renderStylePreviews() {
  for (const [theme, id] of [
    ['light', 'style-day'],
    ['dark', 'style-night'],
  ]) {
    const el = document.getElementById(id);
    if (!el.offsetWidth) continue; // hidden: no provider with styles
    let pv = stylePreviews[id];
    if (!pv) {
      const map = L.map(el, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        keyboard: false,
      });
      pv = stylePreviews[id] = { map, layer: null, key: null };
    }
    pv.map.invalidateSize({ animate: false });
    pv.map.setView([draft.receiver.lat, draft.receiver.lon], 10, { animate: false });
    const spec = tileSpec(draft.map, theme);
    const key = spec ? `${spec.url}|${spec.filter}` : 'none';
    if (key === pv.key) continue;
    pv.key = key;
    if (pv.layer) pv.map.removeLayer(pv.layer);
    pv.layer = spec ? L.tileLayer(spec.url, { subdomains: spec.subdomains, maxZoom: 18 }).addTo(pv.map) : null;
    pv.map.getPane('tilePane').style.filter = spec?.filter ?? '';
  }
  const p = TILE_PROVIDERS[draft.map.tiles];
  $('#style-help').textContent =
    p?.needsKey && !draft.map.tileApiKey.trim() ? 'Enter the map API key to see the previews.' : '';
}

// ---- special aircraft list -----------------------------------------------------------

function renderSpecial() {
  const box = $('#special-rows');
  if (box.contains(document.activeElement) && document.activeElement.type !== 'button') return; // mid-edit
  const list = draft.special.aircraft;
  const kinds = (sel) =>
    SPECIAL_KINDS.map(
      (k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(SPECIAL_LABELS[k])}</option>`,
    ).join('');
  box.innerHTML = list.length
    ? list
        .map(
          (e, i) => `<div class="sp-row" data-i="${i}">
      <input type="text" data-sp="match" value="${esc(e.match)}" placeholder="C-FSPS" maxlength="11" spellcheck="false" aria-label="Registration, callsign or hex" />
      <select data-sp="kind" aria-label="Kind">${kinds(e.kind)}</select>
      <input type="text" data-sp="name" value="${esc(e.name)}" placeholder="Name on screen" maxlength="60" aria-label="Name on screen" />
      <label class="check"><input type="checkbox" data-sp="alert"${e.alert ? ' checked' : ''} /> Alert</label>
      <button type="button" class="btn ghost" data-sp-remove aria-label="Remove">×</button>
    </div>`,
        )
        .join('')
    : '<p class="help">None added yet.</p>';
}

function onSpecialInput(e) {
  const el = e.target.closest('[data-sp]');
  if (!el) return;
  const entry = draft.special.aircraft[Number(el.closest('.sp-row').dataset.i)];
  entry[el.dataset.sp] = el.type === 'checkbox' ? el.checked : el.value;
  updateSavebar();
}
$('#special-rows').addEventListener('input', onSpecialInput);
$('#special-rows').addEventListener('change', onSpecialInput);
$('#special-rows').addEventListener('click', (e) => {
  const row = e.target.closest('[data-sp-remove]')?.closest('.sp-row');
  if (!row) return;
  draft.special.aircraft.splice(Number(row.dataset.i), 1);
  renderSpecial();
  updateSavebar();
});
$('#special-add').addEventListener('click', () => {
  draft.special.aircraft.push({ match: '', kind: 'police', name: '', alert: false });
  renderSpecial();
  updateSavebar();
  $('#special-rows .sp-row:last-child input')?.focus();
});

// ---- save / revert --------------------------------------------------------------------

const isDirty = () => JSON.stringify(saved) !== JSON.stringify(draft);

function updateSavebar(message, cls) {
  const bar = $('#savebar');
  const msg = $('#save-msg');
  const show = !!message || isDirty();
  bar.classList.toggle('visible', show);
  msg.className = cls ?? '';
  msg.textContent = message ?? 'Unsaved changes';
  $('#save').disabled = !isDirty();
  $('#revert').disabled = !isDirty();
}

function authHeaders() {
  let pw = '';
  try {
    pw = localStorage.getItem('lookup.adminPassword') ?? '';
  } catch {
    /* storage unavailable */
  }
  return pw ? { authorization: `Bearer ${pw}` } : {};
}

async function apiFetch(url, opts = {}, retry = true) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...opts.headers },
  });
  if (res.status === 401 && retry) {
    const pw = prompt('Admin password');
    if (pw == null) throw new Error('Password required');
    try {
      localStorage.setItem('lookup.adminPassword', pw);
    } catch {
      /* storage unavailable */
    }
    return apiFetch(url, opts, false);
  }
  return res;
}

// ---- tabs ------------------------------------------------------------------------------

const TABS = $$('.tabs [data-tab]').map((b) => b.dataset.tab);

/** Show one tab's sections; the tab is kept in the address (#display) for reloads and links. */
function showTab(name) {
  if (!TABS.includes(name)) name = TABS[0];
  for (const b of $$('.tabs [data-tab]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const s of $$('main [data-tab]')) s.hidden = s.dataset.tab !== name;
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  // Maps in a tab that was hidden have to measure themselves again.
  window.dispatchEvent(new Event('resize'));
}

$('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});
$('.tabs').addEventListener('keydown', (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  const i = TABS.indexOf(document.activeElement?.dataset.tab);
  const next = TABS[(i + step + TABS.length) % TABS.length];
  showTab(next);
  $(`.tabs [data-tab="${next}"]`).focus();
});
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1));

$('#save').addEventListener('click', async () => {
  $$('.invalid').forEach((el) => el.classList.remove('invalid'));
  try {
    const res = await apiFetch('/api/config', { method: 'PUT', body: JSON.stringify(draft) });
    const body = await res.json();
    if (!res.ok) {
      for (const e of body.errors ?? []) $$(`[data-path="${e.field}"]`).forEach((el) => el.classList.add('invalid'));
      const first = body.errors?.[0];
      // The field to fix may be on another tab.
      const bad = $('.invalid')?.closest('[data-tab]');
      if (bad) showTab(bad.dataset.tab);
      updateSavebar(first ? `${first.field}: ${first.error}` : body.error, 'bad');
      return;
    }
    saved = body.config;
    draft = structuredClone(saved);
    render();
    updateSavebar('Saved ✓', 'ok');
    setTimeout(() => updateSavebar(), 2000);
  } catch (err) {
    updateSavebar(err.message, 'bad');
  }
});

$('#revert').addEventListener('click', () => {
  draft = structuredClone(saved);
  render();
});

window.addEventListener('beforeunload', (e) => {
  if (draft && isDirty()) e.preventDefault();
});

// ---- receiver location -----------------------------------------------------------------

let locMap = null;
let locMarker = null;
let locCircle = null;

function initLocationMap() {
  locMap = L.map('loc-map', { zoomControl: true, attributionControl: true }).setView(
    [draft.receiver.lat, draft.receiver.lon],
    9,
  );
  setLocationTiles();
  locMap.attributionControl.setPrefix(false);
  locMarker = L.circleMarker([draft.receiver.lat, draft.receiver.lon], {
    radius: 7,
    color: '#d24a00',
    weight: 3,
    fillOpacity: 0.9,
  }).addTo(locMap);
  locCircle = L.circle([draft.receiver.lat, draft.receiver.lon], {
    radius: 1000,
    color: '#d24a00',
    weight: 1.5,
    dashArray: '5 6',
    fill: false,
  }).addTo(locMap);
  locMap.on('click', (e) => {
    draft.receiver.lat = Math.round(e.latlng.lat * 1e5) / 1e5;
    draft.receiver.lon = Math.round(e.latlng.lng * 1e5) / 1e5;
    render();
  });
}

let locTiles = null;
let locTilesKey = null;
/** The location picker uses the same (saved) background map as the display. */
function setLocationTiles() {
  const spec = tileSpec(saved.map, 'light') ?? {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    subdomains: 'abc',
    filter: '',
  };
  const key = `${spec.url}|${spec.filter}`;
  if (key === locTilesKey) return;
  locTilesKey = key;
  if (locTiles) locMap.removeLayer(locTiles);
  locMap.getPane('tilePane').style.filter = spec.filter;
  locTiles = L.tileLayer(spec.url, { maxZoom: 18, attribution: spec.attribution, subdomains: spec.subdomains }).addTo(
    locMap,
  );
}

function renderLocation() {
  if (!locMap) return;
  setLocationTiles();
  const ll = [draft.receiver.lat, draft.receiver.lon];
  locMarker.setLatLng(ll);
  locCircle.setLatLng(ll).setRadius(draft.display.cycleRangeKm * 1000);
  if (!locMap.getBounds().contains(ll)) locMap.panTo(ll);
}

$('#use-location').addEventListener('click', () => {
  const note = $('#loc-note');
  if (!navigator.geolocation || !window.isSecureContext) {
    note.className = 'note bad';
    note.textContent =
      'Your browser only shares location with HTTPS pages. Click the map instead, or look up your coordinates on a map site.';
    return;
  }
  note.className = 'note';
  note.textContent = 'Finding your location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      draft.receiver.lat = Math.round(pos.coords.latitude * 1e5) / 1e5;
      draft.receiver.lon = Math.round(pos.coords.longitude * 1e5) / 1e5;
      if (pos.coords.altitude != null) draft.receiver.altitudeM = Math.round(pos.coords.altitude);
      note.className = 'note ok';
      note.textContent = `Located (±${Math.round(pos.coords.accuracy)} m). Remember to save.`;
      locMap?.setView([draft.receiver.lat, draft.receiver.lon], 12);
      render();
    },
    (err) => {
      note.className = 'note bad';
      note.textContent = `Couldn't get your location: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

// ---- data source test --------------------------------------------------------------------

$('#test-source').addEventListener('click', async () => {
  const out = $('#test-result');
  out.className = 'note';
  out.textContent = 'Testing…';
  try {
    const res = await apiFetch('/api/source/test', { method: 'POST', body: JSON.stringify(draft.source) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    if (r.ok) {
      out.className = 'note ok';
      out.textContent =
        draft.source.type === 'simulator'
          ? 'The simulator is always available.'
          : `Connected: ${r.aircraft} aircraft, ${r.withPosition} with a position${r.hasTypes ? ', with type info' : ''}.${
              'online' in r
                ? r.online
                  ? ` The online feed has ${r.online.withPosition} with a position.`
                  : ` The online feed failed: ${r.onlineError ?? 'no answer'}.`
                : ''
            }`;
    } else {
      out.className = 'note bad';
      out.textContent = `Failed: ${r.error}`;
    }
  } catch (err) {
    out.className = 'note bad';
    out.textContent = err.message;
  }
});

// ---- facing dial -----------------------------------------------------------------------

function buildDial() {
  const ticks = [];
  for (let a = 0; a < 360; a += 10) {
    const long = a % 30 === 0;
    const r1 = 100;
    const r2 = long ? 88 : 94;
    const rad = (a * Math.PI) / 180;
    ticks.push(
      `<line x1="${(Math.sin(rad) * r1).toFixed(1)}" y1="${(-Math.cos(rad) * r1).toFixed(1)}" x2="${(Math.sin(rad) * r2).toFixed(1)}" y2="${(-Math.cos(rad) * r2).toFixed(1)}"/>`,
    );
  }
  $('#dial-ticks').innerHTML = ticks.join('');
  $('#facing-presets').innerHTML = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    .map((p, i) => `<button type="button" class="btn" data-facing="${i * 45}">${p}</button>`)
    .join('');
  $('#facing-presets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-facing]');
    if (b) setFacing(Number(b.dataset.facing));
  });

  const dial = $('#dial');
  const fromEvent = (e) => {
    const r = dial.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2);
    const y = e.clientY - (r.top + r.height / 2);
    setFacing(Math.round(normalizeDeg((Math.atan2(x, -y) * 180) / Math.PI)));
  };
  let dragging = false;
  dial.addEventListener('pointerdown', (e) => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    fromEvent(e);
  });
  dial.addEventListener('pointermove', (e) => dragging && fromEvent(e));
  dial.addEventListener('pointerup', () => (dragging = false));
  dial.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setFacing(draft.display.facingDeg + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setFacing(draft.display.facingDeg - step);
    else return;
    e.preventDefault();
  });
}

function setFacing(deg) {
  draft.display.facingDeg = Math.round(normalizeDeg(deg)) % 360;
  render();
}

function renderDial() {
  const f = draft.display.facingDeg;
  $('#dial-needle').style.transform = `rotate(${f}deg)`;
  $('#dial').setAttribute('aria-valuenow', String(f));
  $('#dial-readout').textContent = `Facing ${compassWord(f)} (${Math.round(f)}°)`;
}

// Calibrate from a plane the user can see straight ahead.
async function refreshCalibration() {
  const box = $('#calib');
  try {
    const res = await fetch('/api/aircraft');
    const { aircraft } = await res.json();
    const list = aircraft.filter((a) => !a.onGround && a.distanceKm <= draft.display.cycleRangeKm * 1.5).slice(0, 6);
    if (!list.length) {
      box.innerHTML = '<div class="calib-empty">No aircraft close enough right now.</div>';
      return;
    }
    box.innerHTML = list
      .map((a) => {
        const name = a.typeInfo?.name || a.typeInfo?.code || 'Aircraft';
        const dist = joinUnit(formatDistance(a.distanceKm, units()));
        const brg = Math.round(a.bearingDeg);
        const el = a.elevationDeg != null ? ` · ${Math.round(a.elevationDeg)}° up` : '';
        return `<div class="calib-row"><div><div class="name">${esc(name)}${a.callsign ? ` <span class="muted">${esc(a.callsign)}</span>` : ''}</div>
          <div class="meta">${esc(dist)} away · to the ${esc(compassPoint(brg, 16))} (${brg}°)${el}</div></div>
          <button type="button" class="btn" data-bearing="${brg}">Straight ahead</button></div>`;
      })
      .join('');
  } catch {
    box.innerHTML = '<div class="calib-empty">Couldn’t load aircraft.</div>';
  }
}
$('#calib').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bearing]');
  if (b) setFacing(Number(b.dataset.bearing));
});

// Phone compass: hold the phone flat with its top edge pointing the way you face.
$('#use-compass').addEventListener('click', async () => {
  const note = $('#compass-note');
  note.className = 'note';
  try {
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('This device has no compass sensor.');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== 'granted') throw new Error('Compass permission was denied.');
    }
    note.textContent = 'Hold the phone flat, top edge pointing the way you face when looking at the screen…';
    const readings = [];
    const handler = (e) => {
      let heading = null;
      if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') heading = 360 - e.alpha;
      if (heading != null) readings.push(heading);
    };
    window.addEventListener('deviceorientationabsolute', handler);
    window.addEventListener('deviceorientation', handler);
    await new Promise((r) => setTimeout(r, 2500));
    window.removeEventListener('deviceorientationabsolute', handler);
    window.removeEventListener('deviceorientation', handler);
    if (!readings.length) {
      throw new Error(
        window.isSecureContext
          ? 'No compass readings were received.'
          : 'Browsers only allow compass access on HTTPS pages.',
      );
    }
    // circular mean
    const s = readings.reduce((acc, d) => acc + Math.sin((d * Math.PI) / 180), 0);
    const c = readings.reduce((acc, d) => acc + Math.cos((d * Math.PI) / 180), 0);
    setFacing((Math.atan2(s, c) * 180) / Math.PI);
    note.className = 'note ok';
    note.textContent = `Compass says ${Math.round(draft.display.facingDeg)}°. Remember to save.`;
  } catch (err) {
    note.className = 'note bad';
    note.textContent = err.message;
  }
});

// ---- status -----------------------------------------------------------------------------

const ago = (t) => {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

function tile(label, value, sub, pill) {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${pill ? `<span class="pill ${pill}"></span>` : ''}${esc(value)}</div>${
    sub ? `<div class="s">${esc(sub)}</div>` : ''
  }</div>`;
}

async function refreshStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    const src = s.source ?? {};
    const ok = src.lastOkAt && Date.now() - src.lastOkAt < 15_000;
    const srcName =
      { 'aircraft-json': 'Receiver', 'adsb-api': 'Online feed', simulator: 'Simulator', merged: 'Your antenna' }[
        src.type
      ] ?? src.type;
    // Antenna plus online fill-in: the antenna's own state, and what it covers.
    const antenna = src.type === 'merged' ? src.antenna : src;
    const antennaOk = src.type === 'merged' ? antenna.ok : ok;
    const rate = src.messageRate != null ? ` · ${Math.round(src.messageRate)} msg/s` : '';
    const db = s.enrichment.databases;
    const routes = s.enrichment.routes;
    const photos = s.enrichment.photos;
    $('#status').innerHTML = [
      tile(
        srcName,
        antennaOk
          ? `${antenna.positionCount} aircraft with position`
          : antenna.lastError
            ? 'Not receiving'
            : 'Waiting…',
        antennaOk ? `${antenna.aircraftCount} heard${rate}` : (antenna.lastError ?? antenna.url ?? ''),
        antennaOk ? 'ok' : 'bad',
      ),
      src.type === 'merged' ? coverageTile(s.coverage, src.online) : '',
      tile('Displays connected', String(s.displays), `Tracking ${s.tracker.tracked} aircraft`),
      tile(
        'Aircraft database',
        db.loading ? 'Loading…' : db.aircraft ? `${db.aircraft.toLocaleString()} aircraft` : 'Not loaded',
        `${db.types.toLocaleString()} types · ${db.operators.toLocaleString()} airlines${db.lastError ? ` · ${db.lastError}` : ''}`,
        db.aircraft ? 'ok' : db.loading ? 'warn' : 'bad',
      ),
      tile(
        'Route lookups',
        `${routes.found} found · ${routes.cached} cached`,
        routes.lastError
          ? `Last error ${ago(routes.lastError.at)}: ${routes.lastError.message}`
          : `${routes.pending} pending`,
        routes.lastError && Date.now() - routes.lastError.at < 600_000 ? 'warn' : 'ok',
      ),
      tile(
        'Photos',
        `${photos.typePhotos} type photos · ${photos.airframeCached} airframes`,
        photos.lastError
          ? `Last error ${ago(photos.lastError.at)}: ${photos.lastError.message}`
          : `Your library: ${photos.userTypePhotos} types, ${photos.userAirframePhotos} airframes`,
        photos.lastError && Date.now() - photos.lastError.at < 600_000 ? 'warn' : 'ok',
      ),
      s.atc?.enabled ? atcTile(s.atc) : '',
      s.enrichment.flightaware?.configured ? flightAwareTile(s.enrichment.flightaware) : '',
    ].join('');
    renderFlightAwareState(s.enrichment.flightaware);
    if (s.atc?.enabled) refreshAtcRecent();
  } catch {
    $('#status').innerHTML = tile('Server', 'Unreachable', 'Is Look Up running?', 'bad');
  }
}

/** Antenna plus online fill-in: how much of the sky the antenna catches. */
function coverageTile(c, online) {
  const total = c.antenna + c.online;
  const share = total ? Math.round((100 * c.antenna) / total) : 0;
  return tile(
    'Antenna coverage',
    `${c.antenna} of ${total} planes (${share}%)`,
    `${c.farthestAntennaKm != null ? `Furthest heard: ${Math.round(c.farthestAntennaKm)} km` : 'Nothing heard yet'}${
      online.ok ? '' : ` · online feed not answering${online.lastError ? `: ${online.lastError}` : ''}`
    }`,
    share >= 70 ? 'ok' : 'warn',
  );
}

const usd = (v) => `$${(v ?? 0).toFixed(v >= 1 ? 2 : 3)}`;

function flightAwareTile(fa) {
  const calls = Object.entries(fa.calls ?? {})
    .filter(([k]) => k !== 'usage')
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  const theirs = fa.reported ? ` · FlightAware says ${usd(fa.reported.cost)}` : '';
  const sub = fa.disabledReason
    ? fa.disabledReason
    : !fa.active
      ? 'Off (switched off, or simulated traffic)'
      : fa.lastRefusal && Date.now() - fa.lastRefusal.at < 600_000
        ? `Holding back: ${fa.lastRefusal.reason}`
        : `${usd(fa.leftTodayUsd)} left today${calls ? ` · ${calls}` : ''}`;
  return tile(
    'FlightAware this month',
    `${usd(fa.spentThisMonthUsd)} of ${usd(fa.budgetUsd)}${theirs}`,
    sub,
    fa.disabledReason ? 'bad' : fa.leftThisMonthUsd <= 0 ? 'warn' : 'ok',
  );
}

function renderFlightAwareState(fa) {
  const el = $('#fa-state');
  if (!el) return;
  el.textContent = !fa?.configured
    ? 'No API key: set FLIGHTAWARE_API_KEY in the server environment to use FlightAware.'
    : `This month: ${usd(fa.spentThisMonthUsd)} of ${usd(fa.budgetUsd)} spent, ${usd(fa.spentTodayUsd)} today.`;
}

function atcTile(atc) {
  const src = atc.source ?? {};
  const recentError = [atc.lastError, src.lastError].find((e) => e && Date.now() - e.at < 600_000);
  const listening =
    src.type === 'stream' ? (src.connected ? 'Stream connected' : 'Stream not connected') : 'Watching folder';
  const sum = atc.summaries;
  const summaries = sum.available
    ? `Claude: ${usd(sum.spentThisMonthUsd)} of ${usd(sum.budgetUsd)} this month, ${sum.requests} summaries since restart${
        sum.lastError ? ` · last error: ${sum.lastError.message}` : ''
      }`
    : 'Built-in summaries (no Anthropic API key)';
  return tile(
    'Air traffic control',
    `${atc.transcribed} calls · ${atc.attributed} matched to aircraft`,
    recentError ? `${listening} · ${recentError.message}` : `${listening} · ${summaries}`,
    recentError ? 'warn' : src.type === 'stream' && !src.connected ? 'bad' : 'ok',
  );
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

async function refreshAtcRecent() {
  try {
    const [{ transmissions }, { aircraft }] = await Promise.all([
      (await fetch('/api/atc/recent')).json(),
      (await fetch('/api/aircraft')).json(),
    ]);
    const names = new Map(aircraft.map((a) => [a.hex, a.flight || a.callsign || a.reg || a.hex]));
    const role = { to: 'to', from: 'from' };
    $('#atc-recent').innerHTML = transmissions.length
      ? transmissions
          .slice(0, 12)
          .map(
            (t) =>
              `<li><span class="when">${esc(clock(t.at))}</span> <b>${
                t.hex
                  ? `${esc(role[t.role] ?? '')} ${esc(names.get(t.hex) ?? t.hex)}`
                  : '<span class="muted">unmatched</span>'
              }</b> ${esc(t.text)}${t.url ? ` <a href="${esc(t.url)}" target="_blank" title="Play">▶</a>` : ''}</li>`,
          )
          .join('')
      : '<li class="muted">Nothing yet.</li>';
  } catch {
    // The status tile reports the server being unreachable.
  }
}

// ---- preview -------------------------------------------------------------------------------

function initPreview() {
  const frame = $('#preview');
  const box = frame.parentElement;
  const fit = () => {
    frame.style.transform = `scale(${box.clientWidth / 1280})`;
  };
  new ResizeObserver(fit).observe(box);
  fit();
  frame.src = '/display';
}

// ---- go --------------------------------------------------------------------------------------

async function main() {
  const res = await fetch('/api/config');
  const body = await res.json();
  saved = body.config;
  authRequired = body.authRequired;
  draft = structuredClone(saved);
  buildDial();
  initLocationMap();
  render();
  initPreview();
  refreshStatus();
  refreshCalibration();
  setInterval(refreshStatus, 3000);
  setInterval(refreshCalibration, 3000);
  if (authRequired) document.title += ' (password protected)';
}

main().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<p style="padding:16px;color:#d92d20">Failed to load settings: ${esc(err.message)}</p>`,
  );
});
