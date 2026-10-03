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
import { EMERGENCY_SQUAWKS, SPECIAL_LABELS } from '/shared/special-kinds.js';
import { silhouettePaths, silhouetteSvg } from './icons.js';
import { LiveData } from './stream.js';
import { MapView } from './map.js';
import { MiniMap } from './minimap.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// ---- per-screen overrides ------------------------------------------------------

const params = new URLSearchParams(location.search);
const THEMES = ['auto', 'dark', 'light'];
const THEME_KEY = 'look-up.theme';

/** Light / dark chosen with the button on this screen (kept in this browser), or null. */
function storedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return THEMES.includes(t) ? t : null;
  } catch {
    return null;
  }
}

const overrides = {
  facingDeg: params.has('facing') ? Number(params.get('facing')) : null,
  layout: ['card', 'split'].includes(params.get('layout')) ? params.get('layout') : null,
  theme: storedTheme() ?? (THEMES.includes(params.get('theme')) ? params.get('theme') : null),
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
  legend: $('map-legend'),
  altitudeScale: $('map-altitude'),
  onSelect: (hex) => openPopup(hex),
});

const miniMap = new MiniMap({ wrap: $('c-minimap'), el: $('c-minimap-map'), attribution: $('c-minimap-attrib') });

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
  updateThemeButton();
  if (want === theme) return;
  theme = want;
  document.body.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f7f6f2' : '#08101d';
  configureMap();
}

const THEME_BUTTON = { auto: '◐ Auto', dark: '☾ Dark', light: '☀ Light' };

function updateThemeButton() {
  const btn = $('theme-btn');
  const mode = eff.display.theme;
  btn.textContent = THEME_BUTTON[mode];
  btn.title =
    mode === 'auto'
      ? 'Light by day, dark at night. Tap to choose (T)'
      : `Always ${mode} on this screen. Tap to change (T)`;
}

/**
 * The theme button steps through: the opposite of what the sun says, then
 * what the sun says, then back to following the sun (Auto). The choice is
 * kept in this browser only, so each screen can have its own.
 */
function cycleTheme() {
  const { receiver } = eff;
  const sun = isDaylight(new Date(), receiver.lat, receiver.lon) ? 'light' : 'dark';
  const mode = eff.display.theme;
  const next = mode === 'auto' ? (sun === 'light' ? 'dark' : 'light') : mode === sun ? 'auto' : sun;
  overrides.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage blocked: the choice lasts until the page reloads */
  }
  eff = effective(live.config);
  applyTheme();
}

function configureMap() {
  if (!eff) return;
  mapView.configure({ ...eff, units: unitsName(), theme });
  const miniMapOn = eff.map.miniMap !== false;
  $('card').classList.toggle('with-mini', miniMapOn);
  miniMap.configure({
    receiver: eff.receiver,
    display: eff.display,
    map: eff.map,
    theme,
    enabled: miniMapOn,
    flightTracks: eff.enrichment?.flightTracks !== false,
  });
}

// ---- what the card (and the map pop-up) says -----------------------------------------------

/** Badges for an aircraft; `ctx` adds the carousel ones (holding, close by). */
function badgesHtml(ac, ctx = null) {
  const badges = [];
  if (ctx && cycler.pinned === ac.hex) badges.push('<span class="badge hot">Holding</span>');
  else if (ctx?.spotlight.some((a) => a.hex === ac.hex)) badges.push('<span class="badge hot">Close by</span>');
  if (isEmergency(ac)) badges.push('<span class="badge danger">Emergency</span>');
  const kind = specialKind(ac);
  if (kind) badges.push(`<span class="badge sp sp-${kind}">${esc(SPECIAL_LABELS[kind])}</span>`);
  return badges.join('');
}

const isEmergency = (ac) => !!ac.emergency || ac.squawk in EMERGENCY_SQUAWKS;
const specialKind = (ac) => ac.special?.kind ?? (ac.military ? 'military' : null);

function cardIdent(ac) {
  const t = ac.typeInfo;
  let airline = ac.airline?.name || ac.special?.name || '';
  if (!airline && ac.military) airline = 'Military';
  // "WS347 · WJA347 · C-GGWJ": the flight as sold, the radio callsign, the registration.
  // A private plane's callsign is usually its registration without the dash: show it once.
  const sameAsReg = ac.reg && ac.callsign?.replace(/[\s-]/g, '') === ac.reg.replace(/[\s-]/g, '');
  const ident = [ac.flight, sameAsReg ? null : ac.callsign, ac.reg];
  return {
    maker: t?.manufacturer || (t ? '' : 'Unidentified aircraft'),
    model: t?.model || t?.code || ac.callsign || ac.hex.toUpperCase(),
    airline,
    flight: ident.filter(Boolean).join(' · '),
  };
}

function airportParts(ap) {
  return {
    city: ap.city || ap.name || ap.iata || ap.icao || '?',
    code: ap.iata || ap.icao || '',
  };
}

/** { from, to, takeoff, landing, duration } or { none: why there's no route }. */
function cardRoute(ac) {
  const r = ac.route;
  if (r?.origin && r?.destination) {
    const times = estimateFlightTimes(r, ac);
    // Kept on one line ("5:10 PM", not "5:10" / "PM") when a narrow panel wraps.
    const clock = (t) =>
      new Date(t)
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !eff.display.clock24h })
        .replace(/\s/g, '\u00a0');
    const past = (t) => t <= Date.now();
    return {
      from: airportParts(r.origin),
      to: airportParts(r.destination),
      takeoff: times ? `Took off ≈\u00a0${clock(times.takeoff)}` : '',
      landing: times ? (past(times.landing) ? 'Landing now' : `Lands ≈\u00a0${clock(times.landing)}`) : '',
      duration: times ? `≈ ${formatDuration(times.durationMin)}` : '',
    };
  }
  let none = 'Route unknown';
  if (ac.routeStatus === 'pending') none = 'Looking up route…';
  else if (isRegistrationCallsign(ac)) none = 'Private flight · no published route';
  else if (ac.military) none = 'Military flight · no published route';
  else if (!ac.callsign) none = 'No flight number broadcast';
  return { none };
}

/** Where to look: relative bearing, elevation angle and the words for both. */
function cardWhere(ac) {
  const rel = relativeBearing(ac.bearingDeg, eff.display.facingDeg);
  const el = ac.elevationDeg;
  if (ac.onGround) return { rel, el, dir: relativeDirectionText(rel), elev: 'On the ground' };
  if (el != null && el >= 75) return { rel, el, dir: 'Right overhead', elev: `Look straight up · ${Math.round(el)}°` };
  const elev = el == null ? '' : `${elevationText(el)} · ${Math.max(0, Math.round(el))}°`;
  return { rel, el, dir: relativeDirectionText(rel), elev };
}

/** Stat values as HTML; `seats` is plain text. */
function cardStats(ac) {
  const units = unitsName();
  let alt = 'Ground';
  if (!ac.onGround) {
    const trend = verticalTrend(ac.vertRateFpm);
    const glyph =
      trend === 'climbing'
        ? '<span class="trend" title="climbing">▲</span>'
        : trend === 'descending'
          ? '<span class="trend" title="descending">▼</span>'
          : '';
    alt = valueHtml(formatAltitude(ac.altFt ?? ac.altGeomFt, units), glyph);
  }
  const seats = ac.typeInfo?.seats;
  return {
    dist: valueHtml(formatDistance(ac.distanceKm, units)),
    alt,
    speed: valueHtml(formatSpeed(ac.gsKt, units)),
    heading:
      ac.trackDeg == null
        ? '—'
        : `${esc(compassPoint(ac.trackDeg, 8))}<span class="u">${String(Math.round(ac.trackDeg) % 360).padStart(3, '0')}°</span>`,
    seatsLabel: ac.cargo ? 'Carries' : 'Seats',
    seats: ac.cargo ? 'Cargo' : seats ? (seats >= 20 ? `~${seats}` : String(seats)) : '—',
  };
}

// ---- card ----------------------------------------------------------------------------

function renderCard(ac, ctx) {
  const id = cardIdent(ac);
  $('c-maker').textContent = id.maker;
  const model = $('c-model');
  if (model.textContent !== id.model) {
    model.textContent = id.model;
    fitText(model);
  }
  $('c-airline').textContent = id.airline;
  $('c-flight').textContent = id.flight;
  $('c-badges').innerHTML = badgesHtml(ac, ctx);

  renderPhoto(ac);
  renderRoute(ac);
  renderLive(ac);
  miniMap.show(ac, live.trails.get(ac.hex));
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

function renderRoute(ac) {
  const box = $('c-route');
  const r = cardRoute(ac);
  box.classList.toggle('empty', !!r.none);
  if (r.none) {
    $('c-route-none').textContent = r.none;
    return;
  }
  setFitted($('c-from-city'), r.from.city);
  $('c-from-code').textContent = r.from.code;
  setFitted($('c-to-city'), r.to.city);
  $('c-to-code').textContent = r.to.code;
  $('c-takeoff').textContent = r.takeoff;
  $('c-landing').textContent = r.landing;
  $('c-duration').textContent = r.duration;
}

/** Values that change every second. */
function renderLive(ac) {
  // where to look
  const w = cardWhere(ac);
  const angle = lastArrowAngle + ((((w.rel - lastArrowAngle) % 360) + 540) % 360) - 180;
  lastArrowAngle = angle;
  $('c-arrow').style.transform = `rotate(${angle}deg)`;
  const planeRot = (ac.trackDeg ?? ac.bearingDeg) - ac.bearingDeg;
  $('c-pointer-plane').innerHTML =
    `<g transform="translate(0 -38) rotate(${planeRot.toFixed(1)}) translate(-8 -8) scale(0.25)">${silhouettePaths(
      ac.typeInfo?.category ?? 'narrowbody',
    )}</g>`;
  $('c-dir').textContent = w.dir;
  $('c-elev').textContent = w.elev;
  const e = Math.max(0, Math.min(90, w.el ?? 0)) * (Math.PI / 180);
  const x = 4 + 32 * Math.cos(e);
  const y = 36 - 32 * Math.sin(e);
  $('c-elev-ray').setAttribute('x2', x.toFixed(1));
  $('c-elev-ray').setAttribute('y2', y.toFixed(1));
  $('c-elev-dot').setAttribute('cx', x.toFixed(1));
  $('c-elev-dot').setAttribute('cy', y.toFixed(1));

  // stats
  const st = cardStats(ac);
  $('c-dist').innerHTML = st.dist;
  $('c-alt').innerHTML = st.alt;
  $('c-speed').innerHTML = st.speed;
  $('c-heading').innerHTML = st.heading;
  $('c-seats-label').textContent = st.seatsLabel;
  $('c-seats').textContent = st.seats;
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

// ---- map pop-up ----------------------------------------------------------------------
// Tapping a plane on the map shows a compact version of its card over the map;
// "Show full card" switches to the carousel card for it. While it's open the
// map stays up; it closes after a minute untouched.

const POP_IDLE_MS = 60_000;
const ROUTE_PLANE =
  '<svg viewBox="0 0 64 64" aria-hidden="true"><path transform="rotate(90 32 32)" d="M32 3c2 0 3 3 3 7v15l25 13v3l-25-6v15l8 6v3l-8-1.5-1.5 3.5h-3l-1.5-3.5-8 1.5v-3l8-6V35L4 41v-3l25-13V10c0-4 1-7 3-7z"/></svg>';
let popHex = null;
let popUntil = 0;
let popArrowAngle = 0;

function openPopup(hex) {
  if (!live.byHex.has(hex)) return;
  if (hex !== popHex) popArrowAngle = cardWhere(live.byHex.get(hex)).rel;
  popHex = hex;
  popUntil = Date.now() + POP_IDLE_MS;
  $('pop').hidden = false;
  // Its whole flight, coloured by altitude, with the map zoomed out to fit it.
  mapView.select(hex, { avoidLeftPx: $('pop').offsetWidth + 16 });
  // Far-away aircraft aren't looked up by default; ask for its route and photo.
  fetch(`/api/aircraft/${hex}/lookup`, { method: 'POST' }).catch(() => {});
  renderPopup();
  onAircraft();
}

function closePopup() {
  if (!popHex) return;
  popHex = null;
  $('pop').hidden = true;
  mapView.select(null);
  onAircraft();
}

function renderPopup() {
  const ac = live.byHex.get(popHex);
  if (!ac) return closePopup();
  const id = cardIdent(ac);
  $('pop-maker').textContent = id.maker;
  $('pop-model').textContent = id.model;
  $('pop-flight').textContent = [id.airline, id.flight].filter(Boolean).join(' · ');
  $('pop-badges').innerHTML = badgesHtml(ac);

  const fig = $('pop-photo');
  const img = $('pop-img');
  const url = ac.photo?.url ?? '';
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    fig.classList.remove('has-photo');
    if (url) {
      img.onload = () => img.dataset.src === url && fig.classList.add('has-photo');
      img.src = url;
    } else img.removeAttribute('src');
  }
  const category = ac.typeInfo?.category ?? 'narrowbody';
  if ($('pop-sil').dataset.key !== category) {
    $('pop-sil').dataset.key = category;
    $('pop-sil').innerHTML = silhouetteSvg(category);
  }

  const r = cardRoute(ac);
  const end = (ap, time, cls) =>
    `<div class="ap ${cls}"><b>${esc(ap.code || ap.city)}</b><span>${esc(ap.code ? ap.city : '')}</span><small>${esc(time)}</small></div>`;
  $('pop-route').innerHTML = r.none
    ? `<div class="none">${esc(r.none)}</div>`
    : `${end(r.from, r.takeoff, 'from')}<div class="mid">${ROUTE_PLANE}<small>${esc(r.duration)}</small></div>${end(r.to, r.landing, 'to')}`;

  const w = cardWhere(ac);
  popArrowAngle += ((((w.rel - popArrowAngle) % 360) + 540) % 360) - 180;
  $('pop-arrow').style.transform = `rotate(${popArrowAngle}deg)`;
  $('pop-dir').textContent = w.dir;
  $('pop-elev').textContent = w.elev;

  placePopup();

  const st = cardStats(ac);
  $('pop-stats').innerHTML = [
    ['Distance', st.dist],
    ['Altitude', st.alt],
    ['Speed', st.speed],
    ['Heading', st.heading],
    [st.seatsLabel, esc(st.seats)],
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join('');
}

/** Dock the pop-up in the bottom corner (left or right) that doesn't cover its plane. */
function placePopup() {
  const pop = $('pop');
  const marker = mapView.markers.get(popHex)?.getElement?.();
  if (!marker) return;
  const m = marker.getBoundingClientRect();
  const p = pop.getBoundingClientRect();
  const wrap = $('map-wrap').getBoundingClientRect();
  const covers = (left, right) => m.right > left && m.left < right && m.bottom > p.top && m.top < p.bottom;
  // The same box mirrored to the other side of the map.
  const altLeft = wrap.left + wrap.right - p.right;
  if (covers(p.left, p.right) && !covers(altLeft, altLeft + p.width)) pop.classList.toggle('right');
}

$('pop').addEventListener('click', (e) => {
  popUntil = Date.now() + POP_IDLE_MS;
  const action = e.target.closest('[data-pop]')?.dataset.pop;
  if (action === 'close') closePopup();
  if (action === 'full') {
    const hex = popHex;
    closePopup();
    act('show', hex);
  }
});

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
  // Keep the map up while a pop-up is open on it.
  if (popHex && cycler.view?.kind === 'map') cycler.view.end = Math.max(cycler.view.end, now + 1500);
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

  const mapShown = kind === 'map' || kind === 'idle-map' || eff.display.layout === 'split';
  if (popHex && (!mapShown || now > popUntil || !live.byHex.has(popHex))) closePopup();
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
  $('map-btn').classList.toggle('active', cycler.mapHeld);
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

// ---- alerts: special aircraft you asked to hear about, and emergencies -------------------

let alertsHtml = '';
function renderAlerts() {
  const items = live.aircraft.filter((a) => a.special?.alert || isEmergency(a)).slice(0, 3);
  const html = items
    .map((a) => {
      const emergency = isEmergency(a);
      const kind = emergency ? 'emergency' : a.special.kind;
      const what = emergency
        ? `${a.squawk in EMERGENCY_SQUAWKS ? `Squawking ${a.squawk} (${EMERGENCY_SQUAWKS[a.squawk]})` : 'Emergency'} · ${a.callsign || a.reg || a.hex.toUpperCase()}`
        : `${a.special.name || SPECIAL_LABELS[kind]} is up`;
      const where = `${joinUnit(formatDistance(a.distanceKm, unitsName()))} ${compassPoint(a.bearingDeg, 8)}`;
      return `<button type="button" class="alert sp-${kind}" data-hex="${esc(a.hex)}"><span class="dot"></span><b>${esc(what)}</b><span class="al-where">${esc(where)}</span></button>`;
    })
    .join('');
  if (html !== alertsHtml) $('alerts').innerHTML = alertsHtml = html;
}

$('alerts').addEventListener('click', (e) => {
  const hex = e.target.closest('[data-hex]')?.dataset.hex;
  if (hex) act('show', hex);
});

function onAircraft() {
  if (!eff) return;
  renderAlerts();
  const ctx = poolCtx();
  for (const ac of ctx.pool) preload(ac.photo?.url);
  const view = cycler.view;
  if (view?.kind === 'card' && view.hex === shownHex && !$('card').classList.contains('swapping')) {
    const ac = live.byHex.get(shownHex);
    if (ac) renderCard(ac, ctx);
  }
  if (popHex) renderPopup();
  mapView.update(live.aircraft, {
    currentHex: popHex ?? (view?.kind === 'card' ? view.hex : null),
    cycleHexes: new Set(ctx.pool.map((a) => a.hex)),
    trails: live.trails,
    now: live.now(),
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
    case 'theme':
      cycleTheme();
      break;
    case 'map':
      // Stays on the map until pressed again.
      if (cycler.mapHeld) cycler.releaseMap(now);
      else cycler.holdMap(now);
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
  if (e.target.closest?.('#pop')) {
    down = null;
    return;
  }
  // Taps on a plane in the map are handled by the map (shows that plane). In the
  // split layout taps elsewhere on the map do nothing, so they can't skip cards.
  const onMap = e.target.closest?.('#map-wrap');
  // With a pop-up open, a tap elsewhere on the map just closes it.
  if (onMap && popHex && !e.target.closest('.ac-marker')) {
    down = null;
    closePopup();
    return;
  }
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
    t: 'theme',
    T: 'theme',
  };
  if (e.key === 'Escape' && popHex) {
    closePopup();
    return;
  }
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
window.flightMap = { live, cycler, mapView, miniMap, act };
