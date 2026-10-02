// Map overview (Leaflet). Non-interactive: it is meant to be glanced at.
// With orientation 'facing-up' the whole map is rotated so that the top of the
// screen is the direction you face while looking at it.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import { destinationPoint } from '/shared/geo.js';
import { formatDistance, joinUnit } from '/shared/units.js';
import { silhouettePaths } from './icons.js';
import { tileSpec } from '/shared/tiles.js';


const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export class MapView {
  constructor({ wrap, rotor, el, title, compass, attribution, onSelect }) {
    this.onSelect = onSelect;
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
    this.resize();
  }

  #setTiles(mapCfg, theme) {
    const key = `${mapCfg.tiles}|${mapCfg.customTileUrl}|${mapCfg.tileApiKey}|${theme}`;
    if (key === this.tileKey) return;
    this.tileKey = key;
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = null;
    const spec = tileSpec(mapCfg, theme);
    if (this.attribEl) this.attribEl.textContent = spec?.attribution ?? '';
    if (spec) {
      this.tileLayer = L.tileLayer(spec.url, { maxZoom: 18, crossOrigin: true, subdomains: spec.subdomains }).addTo(
        this.map,
      );
    }
    this.el.classList.toggle('osm-dark', !!spec?.invertForDark && theme === 'dark');
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
   * @param {{currentHex: string|null, cycleHexes: Set<string>, trails: Map, pool: number}} state
   */
  update(aircraft, { currentHex, cycleHexes, trails }) {
    if (!this.settings) return;
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    const seen = new Set();
    const showLabels = this.settings.map.labels;
    for (const ac of aircraft) {
      seen.add(ac.hex);
      const isCurrent = ac.hex === currentHex;
      const inCycle = cycleHexes.has(ac.hex);
      const size = Math.round(vmin * (isCurrent ? 0.075 : inCycle ? 0.055 : 0.04));
      const category = ac.typeInfo?.category ?? 'narrowbody';
      const label = showLabels ? this.#label(ac, isCurrent) : '';
      const key = `${category}|${size}|${label}`;
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
        m.setIcon(
          L.divIcon({
            className: 'ac-marker',
            iconSize: [size, size],
            html: `<div class="glyph"><svg viewBox="0 0 64 64">${silhouettePaths(category)}</svg></div>${
              label ? `<div class="label"><span>${label}</span></div>` : ''
            }`,
          }),
        );
      }
      const el = m.getElement();
      if (el) {
        el.classList.toggle('current', isCurrent);
        el.classList.toggle('in-cycle', inCycle);
        el.querySelector('.glyph').style.transform = `rotate(${ac.trackDeg ?? 0}deg)`;
        const lbl = el.querySelector('.label');
        if (lbl) lbl.style.transform = `rotate(${-this.rotation}deg)`;
      }
      m.setZIndexOffset(isCurrent ? 900 : inCycle ? 500 : 0);
    }
    for (const [hex, m] of this.markers) {
      if (!seen.has(hex)) {
        this.planeLayer.removeLayer(m);
        this.markers.delete(hex);
      }
    }
    this.#drawTrails(aircraft, trails, currentHex, cycleHexes);
  }

  #label(ac, isCurrent) {
    const model = ac.typeInfo?.model || ac.typeInfo?.code || '';
    const parts = isCurrent ? [model, ac.callsign] : [model || ac.callsign];
    return esc(parts.filter(Boolean).join(' · '));
  }

  #drawTrails(aircraft, trails, currentHex, cycleHexes) {
    this.trailLayer.clearLayers();
    if (!this.settings.map.trailMinutes) return;
    const css = getComputedStyle(document.body);
    const accent = css.getPropertyValue('--accent').trim();
    const plane = css.getPropertyValue('--map-plane-dim').trim();
    for (const ac of aircraft) {
      const t = trails.get(ac.hex);
      if (!t || t.length < 2) continue;
      const isCurrent = ac.hex === currentHex;
      const pts = t.map(([lat, lon]) => [lat, lon]);
      pts.push([ac.lat, ac.lon]);
      L.polyline(pts, {
        color: isCurrent ? accent : plane,
        weight: isCurrent ? 3 : 1.5,
        opacity: isCurrent ? 0.9 : cycleHexes.has(ac.hex) ? 0.6 : 0.3,
        interactive: false,
      }).addTo(this.trailLayer);
    }
  }

  setTitle(html) {
    if (this.titleEl) this.titleEl.innerHTML = html;
  }
}
