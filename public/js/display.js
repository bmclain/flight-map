// The outdoor display: cycles through nearby aircraft, interleaving a map.
//
// URL parameters override the saved settings for this one screen, e.g.
//   /display?facing=135&layout=split&theme=dark&units=metric
import { Cycler, selectPools } from '/shared/cycler.js';
import { compassPoint, relativeBearing } from '/shared/geo.js';
import { elevationText, relativeDirectionText, verticalTrend } from '/shared/directions.js';
import { formatAltitude, formatDistance, formatSpeed, joinUnit } from '/shared/units.js';
import { isDaylight } from '/shared/sun.js';
import { estimateFlightTimes, formatDuration } from '/shared/flighttimes.js';
import { silhouettePaths, silhouetteSvg } from './icons.js';
import { LiveData } from './stream.js';
import { MapView } from './map.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// ---- per-screen overrides ------------------------------------------------------

const params = new URLSearchParams(location.search);
const overrides = {
  facingDeg: params.has('facing') ? Number(params.get('facing')) : null,
  layout: ['card', 'split'].includes(params.get('layout')) ? params.get('layout') : null,
  theme: ['auto', 'dark', 'light'].includes(params.get('theme')) ? params.get('theme') : null,
  units: ['imperial', 'aviation', 'metric'].includes(params.get('units')) ? params.get('units') : null,
};

function effective(config) {
  const display = { ...config.display };
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null && !(typeof v === 'number' && !Number.isFinite(v))) display[k] = v;
  }
  return { receiver: config.receiver, display, map: config.map, enrichment: config.enrichment };
}

// ---- state -------------------------------------------------------------------------

const live = new LiveData();
const cycler = new Cycler();
let eff = null;
let theme = null;
let shownHex = null;
let swapTimer = null;
let lastArrowAngle = 0;
let lastView = null;
const photoCache = new Map();

const mapView = new MapView({
  wrap: $('map-wrap'),
  rotor: $('map-rotor'),
  el: $('map'),
  title: $('map-title'),
  compass: $('map-compass'),
  attribution: $('map-attrib'),
  onSelect: (hex) => act('show', hex),
});

// ---- helpers ----------------------------------------------------------------------

function poolCtx(now = Date.now()) {
  const { pool, spotlight } = selectPools(live.aircraft, eff.display);
  return {
    pool,
    spotlight,
    cycleMs: eff.display.cycleSeconds * 1000,
    mapEvery: eff.display.layout === 'split' ? 0 : eff.map.everyCards,
    mapMs: eff.map.seconds * 1000,
    all: live.aircraft,
    now,
  };
}

const unitsName = () => eff.display.units;
const rangeText = () => joinUnit(formatDistance(eff.display.cycleRangeKm, unitsName()));
const isRegistrationCallsign = (ac) => !!ac.callsign && (ac.callsign === ac.reg || /^N\d/.test(ac.callsign));

function valueHtml({ value, unit }, extra = '') {
  return `${esc(value)}${unit ? `<span class="u">${esc(unit)}</span>` : ''}${extra}`;
}

/** Shrink a single-line element's font until its text fits. */
function fitText(el, minPx = 14) {
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  let guard = 30;
  while (el.scrollWidth > el.clientWidth + 1 && size > minPx && guard--) {
    size *= 0.93;
    el.style.fontSize = `${size}px`;
  }
}

/** Set text and, if it changed, shrink it so no single word overflows. */
function setFitted(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  fitText(el);
}

function preload(url) {
  if (!url || photoCache.has(url)) return;
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  photoCache.set(url, img);
  if (photoCache.size > 80) photoCache.delete(photoCache.keys().next().value);
}

// ---- theme --------------------------------------------------------------------------

function applyTheme() {
  if (!eff) return;
  const { receiver } = eff;
  const want =
    eff.display.theme === 'auto'
      ? isDaylight(new Date(), receiver.lat, receiver.lon)
        ? 'light'
        : 'dark'
      : eff.display.theme;
  if (want === theme) return;
  theme = want;
  document.body.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f7f6f2' : '#08101d';
  configureMap();
}

function configureMap() {
  if (!eff) return;
  mapView.configure({ ...eff, units: unitsName(), theme });
}

// ---- card ----------------------------------------------------------------------------

function renderCard(ac, ctx) {
  const t = ac.typeInfo;
  $('c-maker').textContent = t?.manufacturer || (t ? '' : 'Unidentified aircraft');
  const model = $('c-model');
  const modelText = t?.model || t?.code || ac.callsign || ac.hex.toUpperCase();
  if (model.textContent !== modelText) {
    model.textContent = modelText;
    fitText(model);
  }

  // airline / operator line
  let airline = ac.airline?.name || '';
  if (!airline && ac.military) airline = 'Military';
  $('c-airline').textContent = airline;
  const ident = [ac.route?.flightIata || ac.callsign, ac.reg && ac.reg !== ac.callsign ? ac.reg : null];
  $('c-flight').textContent = ident.filter(Boolean).join(' · ');

  const badges = [];
  if (cycler.pinned === ac.hex) badges.push('<span class="badge hot">Holding</span>');
  else if (ctx.spotlight.some((a) => a.hex === ac.hex)) badges.push('<span class="badge hot">Close by</span>');
  if (ac.emergency || ['7500', '7600', '7700'].includes(ac.squawk))
    badges.push('<span class="badge danger">Emergency</span>');
  if (ac.military) badges.push('<span class="badge">Military</span>');
  $('c-badges').innerHTML = badges.join('');

  renderPhoto(ac);
  renderRoute(ac);
  renderLive(ac);
}

function renderPhoto(ac) {
  const fig = $('c-photo');
  const sil = $('c-silhouette');
  const category = ac.typeInfo?.category ?? 'narrowbody';
  const silKey = `${category}|${ac.typeInfo?.code ?? ''}`;
  if (sil.dataset.key !== silKey) {
    sil.dataset.key = silKey;
    sil.innerHTML = `${silhouetteSvg(category)}${ac.typeInfo?.code ? `<div class="type-code">${esc(ac.typeInfo.code)}</div>` : ''}`;
  }
  const url = ac.photo?.url ?? '';
  const img = $('c-img');
  const bg = $('c-img-bg');
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    fig.classList.remove('has-photo');
    $('c-credit').textContent = ac.photo?.credit ?? '';
    if (url) {
      img.onload = () => {
        if (img.dataset.src === url) fig.classList.add('has-photo');
      };
      img.onerror = () => fig.classList.remove('has-photo');
      img.src = url;
      bg.src = url;
    } else {
      img.removeAttribute('src');
      bg.removeAttribute('src');
    }
  }
}

function airportParts(ap) {
  return {
    city: ap.city || ap.name || ap.iata || ap.icao || '?',
    code: ap.iata || ap.icao || '',
  };
}

function renderRoute(ac) {
  const box = $('c-route');
  const r = ac.route;
  if (r?.origin && r?.destination) {
    box.classList.remove('empty');
    const from = airportParts(r.origin);
    const to = airportParts(r.destination);
    setFitted($('c-from-city'), from.city);
    $('c-from-code').textContent = from.code;
    setFitted($('c-to-city'), to.city);
    $('c-to-code').textContent = to.code;
    const times = estimateFlightTimes(r, ac);
    const clock = (t) =>
      new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !eff.display.clock24h });
    const past = (t) => t <= Date.now();
    $('c-takeoff').textContent = times ? `Took off ≈ ${clock(times.takeoff)}` : '';
    $('c-landing').textContent = times ? `${past(times.landing) ? 'Landing now' : `Lands ≈ ${clock(times.landing)}`}` : '';
    $('c-duration').textContent = times ? `≈ ${formatDuration(times.durationMin)}` : '';
    return;
  }
  box.classList.add('empty');
  let msg = 'Route unknown';
  if (ac.routeStatus === 'pending') msg = 'Looking up route…';
  else if (isRegistrationCallsign(ac)) msg = 'Private flight · no published route';
  else if (ac.military) msg = 'Military flight · no published route';
  else if (!ac.callsign) msg = 'No flight number broadcast';
  $('c-route-none').textContent = msg;
}

/** Values that change every second. */
function renderLive(ac) {
  const units = unitsName();
  const facing = eff.display.facingDeg;

  // where to look
  const rel = relativeBearing(ac.bearingDeg, facing);
  const angle = lastArrowAngle + ((((rel - lastArrowAngle) % 360) + 540) % 360) - 180;
  lastArrowAngle = angle;
  $('c-arrow').style.transform = `rotate(${angle}deg)`;
  const planeRot = (ac.trackDeg ?? ac.bearingDeg) - ac.bearingDeg;
  $('c-pointer-plane').innerHTML =
    `<g transform="translate(0 -38) rotate(${planeRot.toFixed(1)}) translate(-8 -8) scale(0.25)">${silhouettePaths(
      ac.typeInfo?.category ?? 'narrowbody',
    )}</g>`;

  const el = ac.elevationDeg;
  if (ac.onGround) {
    $('c-dir').textContent = relativeDirectionText(rel);
    $('c-elev').textContent = 'On the ground';
  } else if (el != null && el >= 75) {
    $('c-dir').textContent = 'Right overhead';
    $('c-elev').textContent = `Look straight up · ${Math.round(el)}°`;
  } else {
    $('c-dir').textContent = relativeDirectionText(rel);
    $('c-elev').textContent = el == null ? '' : `${elevationText(el)} · ${Math.max(0, Math.round(el))}°`;
  }
  const e = Math.max(0, Math.min(90, el ?? 0)) * (Math.PI / 180);
  const x = 4 + 32 * Math.cos(e);
  const y = 36 - 32 * Math.sin(e);
  $('c-elev-ray').setAttribute('x2', x.toFixed(1));
  $('c-elev-ray').setAttribute('y2', y.toFixed(1));
  $('c-elev-dot').setAttribute('cx', x.toFixed(1));
  $('c-elev-dot').setAttribute('cy', y.toFixed(1));

  // stats
  $('c-dist').innerHTML = valueHtml(formatDistance(ac.distanceKm, units));
  if (ac.onGround) {
    $('c-alt').innerHTML = 'Ground';
  } else {
    const trend = verticalTrend(ac.vertRateFpm);
    const glyph =
      trend === 'climbing'
        ? '<span class="trend" title="climbing">▲</span>'
        : trend === 'descending'
          ? '<span class="trend" title="descending">▼</span>'
          : '';
    $('c-alt').innerHTML = valueHtml(formatAltitude(ac.altFt ?? ac.altGeomFt, units), glyph);
  }
  $('c-speed').innerHTML = valueHtml(formatSpeed(ac.gsKt, units));
  $('c-heading').innerHTML =
    ac.trackDeg == null
      ? '—'
      : `${esc(compassPoint(ac.trackDeg, 8))}<span class="u">${String(Math.round(ac.trackDeg) % 360).padStart(3, '0')}°</span>`;
  const seats = ac.typeInfo?.seats;
  $('c-seats-label').textContent = ac.cargo ? 'Carries' : 'Seats';
  $('c-seats').innerHTML = ac.cargo ? 'Cargo' : seats ? (seats >= 20 ? `~${seats}` : String(seats)) : '—';
}

function showCard(hex, ctx) {
  const ac = live.byHex.get(hex);
  if (!ac) return;
  if (hex === shownHex) {
    renderCard(ac, ctx);
    return;
  }
  const card = $('card');
  const first = shownHex == null || lastView !== 'card';
  shownHex = hex;
  clearTimeout(swapTimer);
  if (first) {
    lastArrowAngle = relativeBearing(ac.bearingDeg, eff.display.facingDeg);
    renderCard(ac, ctx);
    return;
  }
  card.classList.add('swapping');
  swapTimer = setTimeout(() => {
    const now = live.byHex.get(shownHex);
    if (now) {
      // Jump the arrow instead of spinning it from the previous aircraft.
      const arrow = $('c-arrow');
      arrow.style.transition = 'none';
      lastArrowAngle = relativeBearing(now.bearingDeg, eff.display.facingDeg);
      renderCard(now, poolCtx());
      arrow.getBoundingClientRect();
      arrow.style.transition = '';
    }
    card.classList.remove('swapping');
  }, 300);
}

// ---- idle & map titles -------------------------------------------------------------

function renderIdle() {
  const now = new Date();
  $('idle-time').textContent = now.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: !eff.display.clock24h,
  });
  $('idle-date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const nearest = live.aircraft.find((a) => !a.onGround);
  let html = `No aircraft within ${esc(rangeText())} right now`;
  if (nearest) {
    const name = nearest.typeInfo?.name || nearest.callsign || 'An aircraft';
    const dist = joinUnit(formatDistance(nearest.distanceKm, unitsName()));
    html += `<span class="sub">Nearest: ${esc(name)}, ${esc(dist)} away</span>`;
  }
  $('idle-msg').innerHTML = html;
}

function updateMapTitle(ctx, kind) {
  const n = ctx.pool.length;
  const total = live.aircraft.length;
  let html;
  if (n) html = `<strong>${n} aircraft</strong> within ${esc(rangeText())}`;
  else html = `<strong>Quiet skies</strong> nothing within ${esc(rangeText())}`;
  if (total > n) html += ` · ${total} on the map`;
  if (kind === 'idle-map' && !total) html = '<strong>Quiet skies</strong> no aircraft on the map';
  mapView.setTitle(html);
}

// ---- main loop -----------------------------------------------------------------------

function setView(kind) {
  if (document.body.dataset.view !== kind) document.body.dataset.view = kind;
}

function tick() {
  if (!live.ready || !eff) {
    setView('loading');
    return;
  }
  const now = Date.now();
  const ctx = poolCtx(now);
  const view = cycler.update(now, ctx);

  let kind = view.kind;
  if (kind === 'idle') {
    const split = eff.display.layout === 'split';
    kind = !split && eff.map.idle === 'map' && live.aircraft.length ? 'idle-map' : 'idle';
  }
  setView(kind);

  // With nothing close by, zoom the map out far enough to show the nearest traffic.
  if (view.kind === 'idle' && live.aircraft.length) {
    const nearest = live.aircraft[0].distanceKm;
    mapView.setFitRange(Math.min(eff.map.rangeKm, Math.max(nearest * 1.4, eff.display.cycleRangeKm * 1.5)));
  } else {
    mapView.setFitRange(null);
  }

  if (kind === 'card') showCard(view.hex, ctx);
  if (kind === 'idle') renderIdle();
  if (kind === 'map' || kind === 'idle-map' || eff.display.layout === 'split') updateMapTitle(ctx, kind);
  if (kind !== 'card' && lastView === 'card') shownHex = null;
  lastView = kind;

  // footer
  const progress = $('f-progress');
  if (Number.isFinite(view.end) && view.end > view.start) {
    progress.style.width = `${Math.min(100, ((now - view.start) / (view.end - view.start)) * 100)}%`;
  } else {
    progress.style.width = view.kind === 'card' ? '100%' : '0';
  }
  const count = ctx.spotlight.length
    ? `${ctx.spotlight.length} close by`
    : `${ctx.pool.length} aircraft within ${rangeText()}`;
  $('f-counter').textContent = count;
  $('pin-btn').classList.toggle('active', !!cycler.pinned);
  updateStatus();
}

function updateStatus() {
  const status = live.status;
  const ok = live.live && status?.sourceOk !== false;
  const el = $('f-status');
  el.classList.toggle('bad', !ok);
  let text = eff?.receiver?.name ?? '';
  if (!live.live) text = 'Reconnecting to server…';
  else if (status && !status.sourceOk)
    text = `No data from receiver${status.sourceError ? ` · ${status.sourceError}` : ''}`;
  else if (status?.sourceType === 'simulator') text = `${text} · simulated traffic`;
  $('f-status-text').textContent = text;
}

function onAircraft() {
  if (!eff) return;
  const ctx = poolCtx();
  for (const ac of ctx.pool) preload(ac.photo?.url);
  const view = cycler.view;
  if (view?.kind === 'card' && view.hex === shownHex && !$('card').classList.contains('swapping')) {
    const ac = live.byHex.get(shownHex);
    if (ac) renderCard(ac, ctx);
  }
  mapView.update(live.aircraft, {
    currentHex: view?.kind === 'card' ? view.hex : null,
    cycleHexes: new Set(ctx.pool.map((a) => a.hex)),
    trails: live.trails,
  });
}

function onConfig() {
  eff = effective(live.config);
  document.body.dataset.layout = eff.display.layout;
  theme = null;
  applyTheme();
  configureMap();
  if (shownHex) {
    const ac = live.byHex.get(shownHex);
    if (ac) renderCard(ac, poolCtx());
  }
  tick();
}

// ---- interaction -----------------------------------------------------------------------

let controlsTimer = null;
function flashControls() {
  document.body.classList.add('show-controls');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => document.body.classList.remove('show-controls'), 5000);
}

function act(action, hex) {
  if (!eff) return;
  const now = Date.now();
  const ctx = poolCtx(now);
  switch (action) {
    case 'next':
      cycler.next(now, ctx);
      break;
    case 'prev':
      cycler.prev(now, ctx);
      break;
    case 'pin':
      if (cycler.pinned) cycler.unpin(now, ctx.cycleMs);
      else if (cycler.view?.kind === 'card') cycler.pin(cycler.view.hex, now);
      break;
    case 'show':
      if (live.byHex.has(hex)) {
        cycler.show(hex, now, ctx);
        // Far-away aircraft aren't looked up by default; ask for its route and photo.
        fetch(`/api/aircraft/${hex}/lookup`, { method: 'POST' }).catch(() => {});
      }
      break;
    case 'map':
      cycler.pinned = null;
      cycler.view = { kind: 'map', start: now, end: now + ctx.mapMs };
      cycler.cardsSinceMap = 0;
      break;
    case 'fullscreen': {
      const el = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
      } else {
        (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
      }
      break;
    }
  }
  tick();
  onAircraft();
}

$('controls').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  e.stopPropagation();
  act(btn.dataset.action);
  flashControls();
});

let down = null;
$('stage').addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, t: Date.now() };
});
$('stage').addEventListener('pointerup', (e) => {
  if (!down) return;
  // Taps on a plane in the map are handled by the map (shows that plane). In the
  // split layout taps elsewhere on the map do nothing, so they can't skip cards.
  const onMap = e.target.closest?.('#map-wrap');
  if (onMap && (e.target.closest('.ac-marker') || eff?.display.layout === 'split')) {
    down = null;
    flashControls();
    return;
  }
  const dx = e.clientX - down.x;
  const dy = e.clientY - down.y;
  down = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
    act(dx < 0 ? 'next' : 'prev'); // swipe
  } else if (Math.abs(dx) < 15 && Math.abs(dy) < 15) {
    const x = e.clientX / window.innerWidth;
    if (x > 0.72) act('next');
    else if (x < 0.28) act('prev');
  }
  flashControls();
});

window.addEventListener('keydown', (e) => {
  const map = {
    ArrowRight: 'next',
    ArrowLeft: 'prev',
    ' ': 'pin',
    m: 'map',
    M: 'map',
    f: 'fullscreen',
    F: 'fullscreen',
  };
  if (map[e.key]) {
    e.preventDefault();
    act(map[e.key]);
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    mapView.resize();
    for (const id of ['c-model', 'c-from-city', 'c-to-city']) fitText($(id));
  }, 150);
});

// Keep the screen awake where the browser allows it (needs HTTPS or localhost).
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch {
    /* not available over plain http — use the tablet's own stay-awake setting */
  }
}
document.addEventListener('visibilitychange', keepAwake);

// ---- go -----------------------------------------------------------------------------------

live.addEventListener('config', onConfig);
live.addEventListener('aircraft', onAircraft);
live.connect();
keepAwake();
setInterval(tick, 250);
setInterval(applyTheme, 60_000);

// for debugging from the console
window.flightMap = { live, cycler, mapView, act };
