// Map overview (Leaflet). Meant to be glanced at, but you can pinch or scroll
// to zoom and drag to look around; it goes back to the usual view with
// Re-centre, or after a minute untouched.
// With orientation 'facing-up' the whole map is rotated so that the top of the
// screen is the direction you face while looking at it; Leaflet doesn't know
// about the rotation, so then the map zooms about its centre and can't be dragged.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import { destinationPoint } from '/shared/geo.js';
import { formatAltitude, formatDistance, formatSpeed, joinUnit, unitSystem } from '/shared/units.js';
import { silhouettePaths } from './icons.js';
import { tileSpec } from '/shared/tiles.js';
import { SPECIAL_LABELS } from '/shared/special-kinds.js';
import { airlineColor, KIND_ORDER, planeGroup, summarize } from '/shared/plane-groups.js';
import { trackSince } from '/shared/track.js';
import { ALTITUDE_TOP_FT, altitudeColor } from '/shared/altitude-colors.js';

// Trails taper towards their old end: width and opacity of each part, oldest
// first. They thin out rather than fade, because a see-through red over the
// dark map turns orange.
const TRAIL_TAPER = [
  { weight: 0.45, opacity: 0.8 },
  { weight: 0.7, opacity: 0.9 },
  { weight: 1, opacity: 1 },
];
// Line width (px) and opacity of a trail, by how much attention the plane gets.
// The plane on the card gets a soft glow in its own colour; a tapped plane's
// whole flight is drawn in altitude colours instead (see select()).
const TRAIL_STYLE = {
  selected: { weight: 5, opacity: 1 },
  current: { weight: 4.5, opacity: 1, glow: 8 },
  cycle: { weight: 3.5, opacity: 1 },
  far: { weight: 2.5, opacity: 0.85 },
};

// After this long without a touch, a map someone has zoomed or moved goes back to the usual view.
const USER_VIEW_MS = 60_000;

// Pinch zoom. Leaflet's is one-to-one (fingers twice as far apart = one zoom
// level, 2× closer), which takes pinch after pinch on a big tablet screen; this
// zooms PINCH_GAIN times as many levels (fingers twice as far apart = 32×
// closer, the usual view to street level in one pinch), still keeping the spot
// between your fingers under them, and a quick pinch carries on when you let go.
const PINCH_GAIN = 5;
const PINCH_FLING_MS = 250; // momentum: zoom speed at release × this
const PINCH_FLING_MAX = 2; // zoom levels

const QuickPinch = L.Map.TouchZoom.extend({
  _onTouchMove(e) {
    if (!e.touches || e.touches.length !== 2 || !this._zooming) return;
    const map = this._map;
    const p1 = map.mouseEventToContainerPoint(e.touches[0]);
    const p2 = map.mouseEventToContainerPoint(e.touches[1]);
    const scale = p1.distanceTo(p2) / this._startDist;
    const zoom = this._startZoom + PINCH_GAIN * Math.log2(scale);
    this._zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom));
    // Recent zoom levels, for the momentum when the fingers lift.
    const now = performance.now();
    this._samples = (this._samples ?? []).filter((s) => now - s.t < 100);
    this._samples.push({ t: now, zoom: this._zoom });
    if (map.options.touchZoom === 'center') {
      this._center = this._startLatLng;
      if (scale === 1) return;
    } else {
      // Keep the spot that was between the fingers under them as they move.
      this._delta = p1._add(p2)._divideBy(2)._subtract(this._centerPoint);
      if (scale === 1 && this._delta.x === 0 && this._delta.y === 0) return;
      this._center = this._centerFor(this._zoom);
    }
    if (!this._moved) {
      map._moveStart(true, false);
      this._moved = true;
    }
    L.Util.cancelAnimFrame(this._animRequest);
    this._animRequest = L.Util.requestAnimFrame(
      () => map._move(this._center, this._zoom, { pinch: true, round: false }),
      this,
      true,
    );
    L.DomEvent.preventDefault(e);
  },

  _onTouchEnd() {
    if (!this._moved || !this._zooming) {
      this._zooming = false;
      this._samples = [];
      return;
    }
    this._zooming = false;
    L.Util.cancelAnimFrame(this._animRequest);
    L.DomEvent.off(document, 'touchmove', this._onTouchMove, this);
    L.DomEvent.off(document, 'touchend touchcancel', this._onTouchEnd, this);
    const map = this._map;
    // Momentum: carry on in the direction the pinch was going, a little.
    const s = this._samples ?? [];
    this._samples = [];
    if (s.length > 1 && s[s.length - 1].t > s[0].t) {
      const speed = (s[s.length - 1].zoom - s[0].zoom) / (s[s.length - 1].t - s[0].t);
      const extra = Math.max(-PINCH_FLING_MAX, Math.min(PINCH_FLING_MAX, speed * PINCH_FLING_MS));
      if (Math.abs(extra) > 0.05) {
        this._zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), this._zoom + extra));
        if (map.options.touchZoom !== 'center' && this._delta) this._center = this._centerFor(this._zoom);
      }
    }
    if (map.options.zoomAnimation) {
      map._animateZoom(this._center, map._limitZoom(this._zoom), true, map.options.zoomSnap);
    } else {
      map._resetView(this._center, map._limitZoom(this._zoom));
    }
  },

  /** The map centre at `zoom` that keeps the pinch's starting spot under the fingers. */
  _centerFor(zoom) {
    const map = this._map;
    return map.unproject(map.project(this._pinchStartLatLng, zoom).subtract(this._delta), zoom);
  },
});

// Plane icons are sized by the aircraft: a fraction of the screen's shorter
// side for a typical narrow-body airliner, scaled per size class below.
const ICON_VMIN = 0.046;
const CURRENT_BOOST = 1.12;

/** How big an aircraft is drawn, relative to a 737 / A320. */
function sizeScale(typeInfo) {
  const { category, seats, wtc } = typeInfo ?? {};
  switch (category) {
    case 'heavy4':
      return 1.3;
    case 'widebody':
      return wtc === 'J' ? 1.3 : 1.15;
    case 'narrowbody':
      return seats && seats < 110 ? 0.88 : 1;
    case 'regional':
      return 0.82;
    case 'turboprop':
      return seats >= 40 ? 0.82 : 0.66;
    case 'bizjet':
    case 'fighter':
      return 0.66;
    case 'helicopter':
    case 'light':
    case 'glider':
    case 'balloon':
      return 0.55;
    default:
      return 0.8;
  }
}

// Mouse wheel and trackpad zoom, continuous like Google Maps. A trackpad pinch
// reaches the page as a stream of small ctrl+wheel events (Safari sends
// gesture events instead); Leaflet's own wheel zoom handles them in 40 ms
// batches and drops any that arrive during its 250 ms zoom animation, so most
// of a pinch was lost. Here a pinch follows the fingers frame by frame and a
// mouse-wheel notch glides, both zooming about the pointer.
const WHEEL_PINCH_RATE = 1 / 18; // zoom levels per pixel of ctrl+wheel (trackpad pinch)
const WHEEL_SCROLL_RATE = 1 / 50; // …and of plain wheel (a mouse notch is ~100 px: two levels)
const GESTURE_GAIN = 5; // Safari pinch: zoom levels per doubling of the pinch (as on the tablet)
const WHEEL_EASE = 0.3; // share of the remaining zoom a wheel notch covers each frame
const WHEEL_END_MS = 150; // no more input for this long ends the zoom

const SmoothWheelZoom = L.Handler.extend({
  addHooks() {
    L.DomEvent.on(this._map._container, 'wheel', this._onWheel, this);
    L.DomEvent.on(this._map._container, 'gesturestart gesturechange gestureend', this._onGesture, this);
  },

  removeHooks() {
    L.DomEvent.off(this._map._container, 'wheel', this._onWheel, this);
    L.DomEvent.off(this._map._container, 'gesturestart gesturechange gestureend', this._onGesture, this);
  },

  _onWheel(e) {
    L.DomEvent.stop(e); // ctrl+wheel would otherwise zoom the whole page
    const px = e.deltaY * (e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? 60 : 1);
    if (!px) return;
    const rate = e.ctrlKey ? WHEEL_PINCH_RATE : WHEEL_SCROLL_RATE;
    this._zoomTo(this._target() - px * rate, e, e.ctrlKey);
  },

  _onGesture(e) {
    L.DomEvent.preventDefault(e);
    if (e.type === 'gesturestart') this._gestureZoom = this._target();
    else if (e.type === 'gesturechange' && e.scale > 0) {
      this._zoomTo(this._gestureZoom + GESTURE_GAIN * Math.log2(e.scale), e, true);
    }
  },

  /** Where the zoom is heading: the current target mid-gesture, else the map's zoom. */
  _target() {
    return this._goal ?? this._map.getZoom();
  },

  _zoomTo(zoom, e, follow) {
    const map = this._map;
    this._goal = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom));
    this._follow = follow;
    const size = map.getSize();
    const anchor = map.options.scrollWheelZoom === 'center' ? size.divideBy(2) : map.mouseEventToContainerPoint(e);
    // The spot to keep under the pointer is measured once per gesture (or when the
    // pointer moves): measuring it every frame lets rounding creep in.
    if (!this._anchor || anchor.distanceTo(this._anchor) > 2) this._spot = null;
    this._anchor = anchor;
    this._lastInput = performance.now();
    if (!this._frame) this._frame = L.Util.requestAnimFrame(this._step, this);
  },

  _step() {
    this._frame = null;
    const map = this._map;
    // Still settling from the last zoom: carry on next frame (the input isn't lost).
    if (map._animatingZoom) {
      this._frame = L.Util.requestAnimFrame(this._step, this);
      return;
    }
    if (!this._moving) {
      map._stop();
      map._moveStart(true, false);
      this._moving = true;
    }
    const from = map.getZoom();
    const done = this._follow || Math.abs(this._goal - from) < 0.01;
    const zoom = done ? this._goal : from + (this._goal - from) * WHEEL_EASE;
    // Keep the spot under the pointer where it is.
    this._spot ??= map.containerPointToLatLng(this._anchor);
    const spot = this._spot;
    const offset = this._anchor.subtract(map.getSize().divideBy(2));
    const center = map.unproject(map.project(spot, zoom).subtract(offset), zoom);
    if (zoom !== from) map._move(center, zoom, { pinch: true, round: false });
    const idle = performance.now() - this._lastInput;
    if (!done || idle < WHEEL_END_MS) {
      this._frame = L.Util.requestAnimFrame(this._step, this);
      return;
    }
    // Settled: let the map tidy up (snap to its zoom steps, load sharper tiles).
    this._moving = false;
    this._goal = null;
    this._spot = null;
    if (map.options.zoomAnimation) map._animateZoom(center, map._limitZoom(zoom), true, map.options.zoomSnap);
    else map._resetView(center, map._limitZoom(zoom));
  },
});

/**
 * [lat, lon, …] points with each longitude shifted by whole turns to sit next
 * to the one after it, working back from `lon` (where the plane is now), so a
 * flight across the antimeridian draws as one line.
 */
function unwrapBack(points, lon) {
  let ref = lon;
  const out = new Array(points.length);
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    const l = p[1] + Math.round((ref - p[1]) / 360) * 360;
    out[i] = [p[0], l, p[2], p[3]];
    ref = l;
  }
  return out;
}

const specialKind = (ac) => ac.special?.kind ?? (ac.military ? 'military' : null);
const compact = (s) => s?.replace(/[\s-]/g, '');

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export class MapView {
  constructor({
    wrap,
    rotor,
    el,
    title,
    compass,
    attribution,
    legend,
    altitudeScale,
    recenter,
    zoomIn,
    zoomOut,
    onSelect,
  }) {
    this.onSelect = onSelect;
    this.legendEl = legend;
    this.altScaleEl = altitudeScale;
    this.legendKey = null;
    this.colors = {};
    this.attribEl = attribution;
    this.fitKm = null;
    this.wrap = wrap;
    this.rotor = rotor;
    this.el = el;
    this.titleEl = title;
    this.compassEl = compass;
    this.markers = new Map();
    this.trails = new Map();
    this.facing = 0;
    this.rotation = 0;
    this.settings = null;
    this.tileKey = null;
    this.selected = null; // { hex, flight }: a tapped plane, see select()
    // True while someone has zoomed or moved the map: it isn't re-fitted then.
    this.userView = false;
    this.userTimer = null;
    this.recenterEl = recenter;
    recenter?.addEventListener('click', () => this.recenter());
    // The + and − buttons: one zoom level each way, about the middle of the map.
    for (const [btn, dir] of [
      [zoomIn, 1],
      [zoomOut, -1],
    ]) {
      btn?.addEventListener('click', () => {
        this.#userMoved();
        if (dir > 0) this.map.zoomIn(1);
        else this.map.zoomOut(1);
      });
    }

    this.map = L.map(el, {
      zoomControl: false,
      // Attribution is drawn outside the (possibly rotated) map, see #attrib.
      attributionControl: false,
      dragging: true,
      // Pinch zoom is QuickPinch, below.
      touchZoom: false,
      // Wheel and trackpad zoom is SmoothWheelZoom, above.
      scrollWheelZoom: false,
      doubleClickZoom: true,
      boxZoom: false,
      keyboard: false,
      tap: false,
      zoomSnap: 0.05,
      minZoom: 3,
      maxZoom: 16,
      fadeAnimation: true,
      zoomAnimation: true,
    });
    this.map.addHandler('quickPinch', QuickPinch);
    this.map.quickPinch.enable();
    this.map.addHandler('smoothWheel', SmoothWheelZoom);
    this.map.smoothWheel.enable();
    // Pinching, dragging, scrolling or double-tapping means someone is looking around.
    const looking = () => this.#userMoved();
    this.map.on('dragstart', looking);
    this.map.on('dblclick', looking);
    el.addEventListener('wheel', looking, { passive: true });
    el.addEventListener('gesturestart', looking, { passive: true });
    el.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length > 1) looking();
      },
      { passive: true },
    );
    this.overlay = L.layerGroup().addTo(this.map);
    this.trailLayer = L.layerGroup().addTo(this.map);
    // A tapped plane's whole flight, coloured by altitude.
    this.altLayer = L.layerGroup().addTo(this.map);
    this.planeLayer = L.layerGroup().addTo(this.map);
  }

  /**
   * @param {object} s  { receiver, display (effective), map, theme }
   */
  configure(s) {
    this.settings = s;
    this.facing = s.display.facingDeg;
    this.rotation = s.map.orientation === 'facing-up' ? -this.facing : 0;
    // On a rotated map, dragging would go the wrong way and zooming would drift off the
    // point under your fingers: zoom about the centre and don't drag.
    const zoomAbout = this.rotation ? 'center' : true;
    Object.assign(this.map.options, { touchZoom: zoomAbout, scrollWheelZoom: zoomAbout, doubleClickZoom: zoomAbout });
    if (this.rotation) this.map.dragging.disable();
    else this.map.dragging.enable();
    this.#setTiles(s.map, s.theme);
    this.#drawOverlay();
    this.#readColors();
    this.#drawAltitudeScale();
    this.resize();
  }

  /** The key to the altitude colours, in the display's units: 0 to 40,000 ft (or 12,000 m) and up. */
  #drawAltitudeScale() {
    if (!this.altScaleEl) return;
    const { theme, units } = this.settings;
    const metric = unitSystem(units).altitude.unit === 'm';
    // The colours stop changing at ALTITUDE_TOP_FT (40,000 ft ≈ 12,000 m).
    const ticks = metric ? [0, 3000, 6000, 9000, 12000] : [0, 0.25, 0.5, 0.75, 1].map((f) => f * ALTITUDE_TOP_FT);
    const top = ticks[ticks.length - 1];
    const toFt = metric ? 1 / 0.3048 : 1;
    const stops = [];
    for (let i = 0; i <= 40; i++) stops.push(`${altitudeColor((top * toFt * i) / 40, theme)} ${i * 2.5}%`);
    const label = (v) => (v === 0 ? '0' : metric ? `${v / 1000} km` : `${v / 1000}k`);
    this.altScaleEl.innerHTML = `<span class="as-title">Altitude</span><span class="as-bar" style="background: linear-gradient(to right, ${stops.join(', ')})"></span><span class="as-ticks">${ticks
      .map((v, i) => `<span>${label(v)}${i === ticks.length - 1 ? '+' : ''}</span>`)
      .join('')}</span>`;
  }

  /** Plane colours for this theme: CSS tokens for the special kinds and private; airlines are worked out as needed. */
  #readColors() {
    const css = getComputedStyle(document.body);
    this.colors = new Map([['casing', css.getPropertyValue('--trail-casing').trim() || '#000']]);
    for (const k of KIND_ORDER) this.colors.set(k, css.getPropertyValue(`--pg-${k}`).trim() || '#888');
    // Trails and summary were drawn in the old theme's colours.
    for (const t of this.trails.values()) t.color = null;
    this.legendKey = null;
  }

  #color(group) {
    let c = this.colors.get(group.key);
    if (!c) {
      c = airlineColor(group, this.settings.theme) ?? this.colors.get('private');
      this.colors.set(group.key, c);
    }
    return c;
  }

  #setTiles(mapCfg, theme) {
    const spec = tileSpec(mapCfg, theme);
    const key = spec ? `${spec.url}|${spec.filter}` : 'none';
    if (key === this.tileKey) return;
    this.tileKey = key;
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = null;
    if (this.attribEl) this.attribEl.textContent = spec?.attribution ?? '';
    if (spec) {
      this.tileLayer = L.tileLayer(spec.url, { maxZoom: 18, crossOrigin: true, subdomains: spec.subdomains }).addTo(
        this.map,
      );
    }
    this.map.getPane('tilePane').style.filter = spec?.filter ?? '';
  }

  #drawOverlay() {
    const { receiver, display, map, units } = this.settings;
    this.overlay.clearLayers();
    const center = [receiver.lat, receiver.lon];
    const css = getComputedStyle(document.body);
    const accent = css.getPropertyValue('--accent').trim() || '#ffb547';
    const muted = css.getPropertyValue('--muted').trim() || '#888';
    const accent2 = css.getPropertyValue('--accent-2').trim() || '#67cdfd';

    // Which way you're facing when looking at the screen.
    const wedgeR = display.cycleRangeKm * 1000 * 0.55;
    const wedge = [center];
    for (let a = -28; a <= 28; a += 4) {
      const p = destinationPoint(receiver.lat, receiver.lon, this.facing + a, wedgeR);
      wedge.push([p.lat, p.lon]);
    }
    L.polygon(wedge, { stroke: false, fillColor: accent2, fillOpacity: 0.12, interactive: false }).addTo(this.overlay);

    // Range rings: the card rotation range, and the edge of the map.
    L.circle(center, {
      radius: display.cycleRangeKm * 1000,
      color: accent,
      weight: 2,
      opacity: 0.8,
      dashArray: '6 8',
      fill: false,
      interactive: false,
    }).addTo(this.overlay);
    if (map.rangeKm > display.cycleRangeKm * 1.2) {
      L.circle(center, {
        radius: map.rangeKm * 1000,
        color: muted,
        weight: 1,
        opacity: 0.5,
        fill: false,
        interactive: false,
      }).addTo(this.overlay);
    }
    const labelAt = destinationPoint(receiver.lat, receiver.lon, this.facing, display.cycleRangeKm * 1000);
    L.marker([labelAt.lat, labelAt.lon], {
      interactive: false,
      icon: L.divIcon({
        className: 'ring-label',
        html: `<span style="transform: rotate(${-this.rotation}deg)">${esc(joinUnit(formatDistance(display.cycleRangeKm, units)))}</span>`,
        iconSize: [0, 0],
      }),
    }).addTo(this.overlay);

    L.marker(center, {
      interactive: false,
      zIndexOffset: 1000,
      icon: L.divIcon({ className: 'you-marker', html: '<div class="pulse"></div>', iconSize: [14, 14] }),
    }).addTo(this.overlay);
  }

  /** Re-fit after a size or orientation change. */
  resize() {
    if (!this.settings) return;
    const w = this.wrap.clientWidth;
    const h = this.wrap.clientHeight;
    if (!w || !h) return;
    const size = this.rotation ? Math.ceil(Math.hypot(w, h)) : null;
    const rw = size ?? w;
    const rh = size ?? h;
    Object.assign(this.rotor.style, {
      width: `${rw}px`,
      height: `${rh}px`,
      marginLeft: `${-rw / 2}px`,
      marginTop: `${-rh / 2}px`,
      transform: `rotate(${this.rotation}deg)`,
    });
    if (this.compassEl) this.compassEl.firstElementChild.style.transform = `rotate(${this.rotation}deg)`;
    this.map.invalidateSize({ animate: false });
    this.#fit(w, h);
  }

  /**
   * Zoom so that `km` fits on screen (null = default: the map range, but no
   * more than three times the cycle range so the ring stays readable).
   */
  setFitRange(km) {
    const same = km == null ? this.fitKm == null : this.fitKm != null && Math.abs(km / this.fitKm - 1) < 0.15;
    if (same) return;
    this.fitKm = km;
    this.#fit(this.wrap.clientWidth, this.wrap.clientHeight);
  }

  #fit(w, h) {
    if (!this.settings || !w || !h) return;
    // Leave the view alone while someone is looking around.
    if (this.userView) return;
    const { receiver, display, map } = this.settings;
    const rangeKm = this.fitKm ?? Math.min(map.rangeKm, display.cycleRangeKm * 3);
    const px = Math.min(w, h) * 0.92;
    const metersPerPx = (rangeKm * 2000) / px;
    const zoom = Math.log2((156543.03392 * Math.cos((receiver.lat * Math.PI) / 180)) / metersPerPx);
    this.map.setView([receiver.lat, receiver.lon], Math.max(3, Math.min(16, zoom)), { animate: false });
  }

  #userMoved() {
    clearTimeout(this.userTimer);
    this.userTimer = setTimeout(() => this.recenter(), USER_VIEW_MS);
    if (this.userView) return;
    this.userView = true;
    if (this.recenterEl) this.recenterEl.hidden = false;
  }

  /** Back to the usual view, after someone has zoomed or moved the map. */
  recenter() {
    clearTimeout(this.userTimer);
    if (!this.userView) return;
    this.userView = false;
    if (this.recenterEl) this.recenterEl.hidden = true;
    this.#fit(this.wrap.clientWidth, this.wrap.clientHeight);
  }

  /**
   * A plane tapped on the map: fetch its whole flight since take-off (from
   * adsb.lol, via the server) and draw it in altitude colours. The map stays
   * where it is; zoom out to see where it came from. null clears it.
   * @param {string|null} hex
   */
  select(hex) {
    if (hex === (this.selected?.hex ?? null)) return;
    if (!hex) {
      this.selected = null;
      return;
    }
    const sel = { hex, flight: null };
    this.selected = sel;
    // ?tapped: someone wants this one, so the server may fill in the start from FlightAware.
    fetch(`/api/aircraft/${hex}/track?tapped`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body) => {
        if (this.selected === sel) sel.flight = body?.track?.points ?? [];
      });
  }

  /**
   * @param {object[]} aircraft
   * @param {{currentHex: string|null, cycleHexes: Set<string>, trails: Map, now: number}} state  (now: server clock)
   */
  update(aircraft, { currentHex, cycleHexes, trails, now = Date.now(), sources = null }) {
    if (!this.settings) return;
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    const seen = new Set();
    const showLabels = this.settings.map.labels;
    const groups = new Map();
    for (const ac of aircraft) {
      seen.add(ac.hex);
      const group = planeGroup(ac);
      groups.set(ac.hex, group);
      const color = this.#color(group);
      const isCurrent = ac.hex === currentHex;
      const inCycle = cycleHexes.has(ac.hex);
      const size = Math.round(vmin * ICON_VMIN * sizeScale(ac.typeInfo) * (isCurrent ? CURRENT_BOOST : 1));
      const category = ac.typeInfo?.category ?? 'narrowbody';
      const label = showLabels ? this.#label(ac) : '';
      const key = `${category}|${size}|${!!label}`;
      let m = this.markers.get(ac.hex);
      if (!m) {
        m = L.marker([ac.lat, ac.lon], { interactive: true, keyboard: false, bubblingMouseEvents: false });
        const hex = ac.hex;
        m.on('click', () => this.onSelect?.(hex));
        m.addTo(this.planeLayer);
        this.markers.set(ac.hex, m);
      }
      m.setLatLng([ac.lat, ac.lon]);
      if (m.options.iconKey !== key) {
        m.options.iconKey = key;
        m.options.labelHtml = label;
        m.setIcon(
          L.divIcon({
            className: 'ac-marker',
            iconSize: [size, size],
            // The halo copy of the silhouette is the outline shown round the selected plane.
            html: `<div class="glyph"><svg viewBox="0 0 64 64"><g class="halo">${silhouettePaths(category)}</g><g class="body">${silhouettePaths(category)}</g></svg></div>${
              label ? `<div class="label"><span>${label}</span></div>` : ''
            }`,
          }),
        );
      }
      const el = m.getElement();
      if (el) {
        el.dataset.special = specialKind(ac) ?? '';
        if (el.dataset.color !== color) {
          el.dataset.color = color;
          el.style.setProperty('--pc', color);
        }
        el.classList.toggle('current', isCurrent);
        el.classList.toggle('in-cycle', inCycle);
        el.classList.toggle('online', !!sources && ac.via === 'online');
        el.querySelector('.glyph').style.transform = `rotate(${ac.trackDeg ?? 0}deg)`;
        const lbl = el.querySelector('.label');
        if (lbl) {
          lbl.style.transform = `rotate(${-this.rotation}deg)`;
          // Altitude and speed change all the time: update the text, not the whole marker.
          if (m.options.labelHtml !== label) {
            m.options.labelHtml = label;
            lbl.firstElementChild.innerHTML = label;
          }
        }
      }
      m.setZIndexOffset(isCurrent ? 900 : inCycle ? 500 : 0);
    }
    for (const [hex, m] of this.markers) {
      if (!seen.has(hex)) {
        this.planeLayer.removeLayer(m);
        this.markers.delete(hex);
      }
    }
    this.#drawTrails(aircraft, groups, trails, currentHex, cycleHexes, now);
    this.#drawSummary(groups, sources ? { name: sources.online, aircraft } : null);
  }

  /**
   * "WS347 · 737-700" over "WestJet · 3,400 m · 520 km/h": the flight as the
   * airline sells it (or the callsign or registration) and the model, then who
   * flies it (the airline, or private, police, air ambulance…), how high and
   * how fast.
   */
  #label(ac) {
    const model = ac.typeInfo?.model || ac.typeInfo?.code || '';
    const kind = specialKind(ac);
    // A private plane's callsign is usually its registration: show the registration, properly written.
    const sameAsReg = !!ac.reg && compact(ac.reg) === compact(ac.callsign);
    const ident = ac.flight || (sameAsReg ? ac.reg : ac.callsign) || ac.reg || ac.hex.toUpperCase();
    const line1 = [ident, model].filter(Boolean).join(' · ');
    const who = kind ? SPECIAL_LABELS[kind] : ac.airline?.name || 'Private';
    const units = this.settings.units;
    const alt = ac.onGround ? 'on the ground' : ac.altFt != null ? joinUnit(formatAltitude(ac.altFt, units)) : null;
    // Speed to the nearest 10 so the label doesn't flicker.
    const perKt = unitSystem(units).speed.perKt;
    const gs = ac.gsKt != null ? joinUnit(formatSpeed((Math.round((ac.gsKt * perKt) / 10) * 10) / perKt, units)) : null;
    const line2 = [who, alt, ac.onGround ? null : gs].filter(Boolean).join(' · ');
    return `<b>${esc(line1)}</b><small>${esc(line2)}</small>`;
  }

  /**
   * Each plane's track over the last `map.trailMinutes`, in the plane's colour,
   * thinning out towards the old end, on a thin casing that keeps it readable
   * over the map and over other trails. The plane on the card glows in its own
   * colour; a tapped plane's whole flight is coloured by altitude. The lines are
   * kept and reshaped from one update to the next rather than redrawn.
   */
  #drawTrails(aircraft, groups, trails, currentHex, cycleHexes, now) {
    const minutes = this.settings.map.trailMinutes;
    const since = now - minutes * 60_000;
    const seen = new Set();
    let current = null;
    let selected = null;
    for (const ac of minutes ? aircraft : []) {
      const track = trails.get(ac.hex);
      if (!track?.length) continue;
      const pts = trackSince(track, since);
      if (!pts.length) continue;
      pts.push([ac.lat, ac.lon, now, ac.onGround ? 0 : (ac.altFt ?? ac.altGeomFt ?? null)]);
      seen.add(ac.hex);
      const role =
        ac.hex === this.selected?.hex
          ? 'selected'
          : ac.hex === currentHex
            ? 'current'
            : cycleHexes.has(ac.hex)
              ? 'cycle'
              : 'far';
      const color = this.#color(groups.get(ac.hex));
      let t = this.trails.get(ac.hex);
      if (!t) {
        const line = () => L.polyline([], { interactive: false, lineCap: 'round', lineJoin: 'round' });
        t = { casing: line().addTo(this.trailLayer), parts: TRAIL_TAPER.map(() => line().addTo(this.trailLayer)) };
        this.trails.set(ac.hex, t);
      }
      if (t.role !== role || t.color !== color) {
        t.role = role;
        t.color = color;
        const { weight, opacity, glow } = TRAIL_STYLE[role];
        t.casing.setStyle(
          glow
            ? { color, weight: weight + glow, opacity: 0.3 }
            : { color: this.colors.get('casing'), weight: weight + 3, opacity: opacity * 0.45 },
        );
        t.parts.forEach((p, i) =>
          p.setStyle({ color, weight: weight * TRAIL_TAPER[i].weight, opacity: opacity * TRAIL_TAPER[i].opacity }),
        );
      }
      t.casing.setLatLngs(pts.map(([lat, lon]) => [lat, lon]));
      if (role === 'selected') {
        // The whole flight, in altitude colours, below.
        for (const p of t.parts) p.setLatLngs([]);
        selected = { t, ac, pts };
        continue;
      }
      if (role === 'current') current = t;
      // Split the track into equal stretches of time, each sharing its end point with the next.
      const t0 = pts[0][2];
      const span = Math.max(1, now - t0);
      let from = 0;
      t.parts.forEach((p, i) => {
        const until = t0 + (span * (i + 1)) / TRAIL_TAPER.length;
        let to = from;
        while (to < pts.length - 1 && pts[to + 1][2] <= until) to++;
        if (i === TRAIL_TAPER.length - 1) to = pts.length - 1;
        p.setLatLngs(to > from ? pts.slice(from, to + 1).map(([lat, lon]) => [lat, lon]) : []);
        from = to;
      });
    }
    for (const [hex, t] of this.trails) {
      if (seen.has(hex)) continue;
      this.trailLayer.removeLayer(t.casing);
      for (const p of t.parts) this.trailLayer.removeLayer(p);
      this.trails.delete(hex);
    }
    // The plane on the card is drawn over the other trails (a tapped plane's altitude colours are on a layer above).
    if (current) for (const l of [current.casing, ...current.parts]) l.bringToFront();
    let flight = null;
    if (selected) {
      // Its flight from take-off (adsb.lol) up to where our own track begins, then our track.
      const { t, ac, pts } = selected;
      const before = (this.selected.flight ?? []).filter((p) => p[2] < pts[0][2]);
      flight = unwrapBack([...before, ...pts], ac.lon);
      t.casing.setLatLngs(flight.map(([lat, lon]) => [lat, lon]));
      t.casing.bringToFront();
    }
    this.#drawAltitudeTrail(flight);
    // All the lines share one SVG, so the altitude colours have to be moved
    // back on top of the casings brought forward above.
    for (const l of this.altLayer.getLayers()) l.bringToFront();
  }

  /**
   * A tapped plane's flight in altitude colours: one line per stretch of the
   * same colour. Rebuilt only when the flight gains a point; in between, the
   * end of the last line just follows the plane.
   */
  #drawAltitudeTrail(pts) {
    if (this.altScaleEl) this.altScaleEl.hidden = !pts;
    if (!pts) {
      this.altLayer.clearLayers();
      this.altKey = null;
      return;
    }
    const theme = this.settings.theme;
    const key = `${this.selected?.hex}|${theme}|${pts.length}|${pts[pts.length - 2]?.[2]}`;
    const end = pts[pts.length - 1];
    if (key === this.altKey) {
      const last = this.altLayer.getLayers().at(-1);
      const lls = last?.getLatLngs();
      if (lls?.length) {
        lls[lls.length - 1] = L.latLng(end[0], end[1]);
        last.setLatLngs(lls);
      }
      return;
    }
    this.altKey = key;
    this.altLayer.clearLayers();
    const { weight } = TRAIL_STYLE.selected;
    const flush = (run, color) =>
      L.polyline(
        run.map(([lat, lon]) => [lat, lon]),
        { color, weight, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false },
      ).addTo(this.altLayer);
    // Points without an altitude (a gap in the data) take the nearest altitude
    // before them, or failing that after them.
    const alts = pts.map((p) => p[3] ?? null);
    for (let i = 1; i < alts.length; i++) alts[i] ??= alts[i - 1];
    for (let i = alts.length - 2; i >= 0; i--) alts[i] ??= alts[i + 1];
    let run = [pts[0]];
    let color = null;
    for (let i = 1; i < pts.length; i++) {
      const c = altitudeColor(alts[i], theme);
      if (color && c !== color) {
        flush(run, color);
        run = [pts[i - 1]];
      }
      color = c;
      run.push(pts[i]);
    }
    if (color) flush(run, color);
  }

  /**
   * The summary: how many planes on the map per airline (in its colour), then
   * police, air ambulance, government, military and private, always listed.
   */
  #drawSummary(groups, merged = null) {
    if (!this.legendEl) return;
    const rows = summarize(groups.values());
    // With the online fill-in: how many your antenna hears, and how many only the feed has.
    let sourceRow = '';
    if (merged) {
      const mine = merged.aircraft.filter((a) => a.via === 'antenna').length;
      const theirs = merged.aircraft.filter((a) => a.via === 'online').length;
      sourceRow = `<span class="lg src"><i class="solid"></i>Your antenna<b>${mine}</b></span><span class="lg src"><i class="hollow"></i>${esc(merged.name)} only<b>${theirs}</b></span>`;
    }
    const key = `${rows.map((r) => `${r.group.key}:${r.count}`).join('|')}|${sourceRow}`;
    if (key === this.legendKey) return;
    this.legendKey = key;
    this.legendEl.innerHTML =
      rows
        .map(
          ({ group, count }) =>
            `<span class="lg${count ? '' : ' none'}"><i style="background: ${esc(this.#color(group))}"></i>${esc(group.label)}<b>${count}</b></span>`,
        )
        .join('') + sourceRow;
  }

  setTitle(html) {
    if (this.titleEl) this.titleEl.innerHTML = html;
  }
}
