// Map overview (Leaflet). Non-interactive: it is meant to be glanced at.
// With orientation 'facing-up' the whole map is rotated so that the top of the
// screen is the direction you face while looking at it.
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
const TRAIL_STYLE = {
  current: { weight: 5, opacity: 1 },
  cycle: { weight: 3.5, opacity: 1 },
  far: { weight: 2.5, opacity: 0.85 },
};

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

const specialKind = (ac) => ac.special?.kind ?? (ac.military ? 'military' : null);
const compact = (s) => s?.replace(/[\s-]/g, '');

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export class MapView {
  constructor({ wrap, rotor, el, title, compass, attribution, legend, altitudeScale, onSelect }) {
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

    this.map = L.map(el, {
      zoomControl: false,
      // Attribution is drawn outside the (possibly rotated) map, see #attrib.
      attributionControl: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      zoomSnap: 0.05,
      fadeAnimation: true,
      zoomAnimation: false,
    });
    this.overlay = L.layerGroup().addTo(this.map);
    this.trailLayer = L.layerGroup().addTo(this.map);
    // The selected plane's path, coloured by altitude.
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
    const { receiver, display, map } = this.settings;
    const rangeKm = this.fitKm ?? Math.min(map.rangeKm, display.cycleRangeKm * 3);
    const px = Math.min(w, h) * 0.92;
    const metersPerPx = (rangeKm * 2000) / px;
    const zoom = Math.log2((156543.03392 * Math.cos((receiver.lat * Math.PI) / 180)) / metersPerPx);
    this.map.setView([receiver.lat, receiver.lon], Math.max(3, Math.min(16, zoom)), { animate: false });
  }

  /**
   * @param {object[]} aircraft
   * @param {{currentHex: string|null, cycleHexes: Set<string>, trails: Map, now: number}} state  (now: server clock)
   */
  update(aircraft, { currentHex, cycleHexes, trails, now = Date.now() }) {
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
    this.#drawSummary(groups);
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
   * over the map and over other trails. The selected plane's track is coloured
   * by altitude instead. The lines are kept and reshaped from one update to the
   * next rather than redrawn.
   */
  #drawTrails(aircraft, groups, trails, currentHex, cycleHexes, now) {
    const minutes = this.settings.map.trailMinutes;
    const since = now - minutes * 60_000;
    const seen = new Set();
    let current = null;
    let currentPts = null;
    for (const ac of minutes ? aircraft : []) {
      const track = trails.get(ac.hex);
      if (!track?.length) continue;
      const pts = trackSince(track, since);
      if (!pts.length) continue;
      pts.push([ac.lat, ac.lon, now, ac.onGround ? 0 : (ac.altFt ?? ac.altGeomFt ?? null)]);
      seen.add(ac.hex);
      const role = ac.hex === currentHex ? 'current' : cycleHexes.has(ac.hex) ? 'cycle' : 'far';
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
        const { weight, opacity } = TRAIL_STYLE[role];
        t.casing.setStyle({ color: this.colors.get('casing'), weight: weight + 3, opacity: opacity * 0.45 });
        t.parts.forEach((p, i) =>
          p.setStyle({ color, weight: weight * TRAIL_TAPER[i].weight, opacity: opacity * TRAIL_TAPER[i].opacity }),
        );
      }
      t.casing.setLatLngs(pts.map(([lat, lon]) => [lat, lon]));
      if (role === 'current') {
        // Drawn by altitude below instead.
        for (const p of t.parts) p.setLatLngs([]);
        current = t;
        currentPts = pts;
        continue;
      }
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
    // The selected plane's trail is drawn over the others (its altitude colours are on a layer above).
    if (current) current.casing.bringToFront();
    this.#drawAltitudeTrail(currentPts);
  }

  /** The selected plane's path in altitude colours: one line per stretch of the same colour. */
  #drawAltitudeTrail(pts) {
    this.altLayer.clearLayers();
    if (this.altScaleEl) this.altScaleEl.hidden = !pts;
    if (!pts) return;
    const theme = this.settings.theme;
    const { weight } = TRAIL_STYLE.current;
    const flush = (run, color) =>
      L.polyline(
        run.map(([lat, lon]) => [lat, lon]),
        { color, weight, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false },
      ).addTo(this.altLayer);
    // Points without an altitude (recorded by an older version, or a gap in the
    // data) take the nearest altitude before them, or failing that after them.
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
  #drawSummary(groups) {
    if (!this.legendEl) return;
    const rows = summarize(groups.values());
    const key = rows.map((r) => `${r.group.key}:${r.count}`).join('|');
    if (key === this.legendKey) return;
    this.legendKey = key;
    this.legendEl.innerHTML = rows
      .map(
        ({ group, count }) =>
          `<span class="lg${count ? '' : ' none'}"><i style="background: ${esc(this.#color(group))}"></i>${esc(group.label)}<b>${count}</b></span>`,
      )
      .join('');
  }

  setTitle(html) {
    if (this.titleEl) this.titleEl.innerHTML = html;
  }
}
