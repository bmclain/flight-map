// Mini map on the aircraft card: the whole flight, origin to destination, with
// the part already flown, where the plane is now, and the track we've seen.
// Without a known route it shows just the recent track around you.
import * as L from '/vendor/leaflet/leaflet-src.esm.js';
import { greatCirclePoints } from '/shared/geo.js';
import { tileSpec } from '/shared/tiles.js';
import { silhouettePaths } from './icons.js';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** Shift `lon` by whole turns so it is as close as possible to `ref`. */
const nearLon = (lon, ref) => lon + Math.round((ref - lon) / 360) * 360;

export class MiniMap {
  constructor({ wrap, el, attribution }) {
    this.wrap = wrap;
    this.el = el;
    this.attribEl = attribution;
    this.settings = null;
    this.tileKey = null;
    this.fitKey = null;
    this.routeKey = null;
    this.colors = {};

    this.map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      zoomSnap: 0.25,
      fadeAnimation: false,
      zoomAnimation: false,
      worldCopyJump: false,
    });
    // Layers can't be drawn on a map with no view yet; this is replaced on the first fit.
    this.map.setView([0, 0], 2, { animate: false });
    this.ringLayer = L.layerGroup().addTo(this.map);
    this.routeLayer = L.layerGroup().addTo(this.map);
    this.trailLine = L.polyline([], { interactive: false, weight: 2.5, opacity: 0.95 }).addTo(this.map);
    this.flownLine = L.polyline([], { interactive: false, weight: 2.5, opacity: 0.9 }).addTo(this.map);
    this.aheadLine = L.polyline([], { interactive: false, weight: 2, opacity: 0.8, dashArray: '4 5' }).addTo(this.map);
    this.you = L.circleMarker([0, 0], { interactive: false, radius: 3.5, weight: 1.5, fillOpacity: 1 }).addTo(this.map);
    this.plane = L.marker([0, 0], { interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(this.map);
    this.planeKey = null;
    this.last = null;
    // The inset changes size with the layout (card, split, portrait); Leaflet
    // needs telling, and the flight re-framing.
    new ResizeObserver(() => {
      if (!this.wrap.clientWidth) return;
      this.resize();
      if (this.last) this.show(...this.last);
    }).observe(wrap);
  }

  /** @param {object} s { receiver, display, map, theme, enabled } */
  configure(s) {
    this.settings = s;
    const wasHidden = this.wrap.hidden;
    this.wrap.hidden = !s.enabled;
    const css = getComputedStyle(document.body);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    this.colors = {
      accent: v('--accent', '#ffb547'),
      accent2: v('--accent-2', '#67cdfd'),
      muted: v('--muted', '#888'),
      text: v('--text', '#fff'),
      bg: v('--bg', '#000'),
    };
    const c = this.colors;
    this.flownLine.setStyle({ color: c.accent });
    this.trailLine.setStyle({ color: c.accent });
    this.aheadLine.setStyle({ color: c.text });
    this.you.setStyle({ color: c.bg, fillColor: c.accent2 });
    this.#setTiles(s.map, s.theme);
    this.#drawRing();
    this.routeKey = null; // redraw the airports in the new colours
    if (wasHidden && s.enabled) this.resize();
    else this.fitKey = null;
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

  /** Faint ring at the card rotation range, for a sense of scale without tiles. */
  #drawRing() {
    const { receiver, display } = this.settings;
    this.ringLayer.clearLayers();
    L.circle([receiver.lat, receiver.lon], {
      radius: display.cycleRangeKm * 1000,
      color: this.colors.muted,
      weight: 1,
      opacity: 0.6,
      dashArray: '3 4',
      fill: false,
      interactive: false,
    }).addTo(this.ringLayer);
  }

  resize() {
    this.map.invalidateSize({ animate: false });
    this.fitKey = null;
  }

  /**
   * Draw (or update) the flight of `ac`.
   * @param {object} ac  enriched aircraft
   * @param {[number, number, number][]|undefined} trail  recent [lat, lon, t] positions
   */
  show(ac, trail) {
    if (!this.settings?.enabled || ac?.lat == null) return;
    this.last = [ac, trail];
    if (!this.wrap.clientWidth) return; // hidden; drawn when it's next on screen
    const { receiver } = this.settings;
    const r = ac.route;
    const hasRoute = r?.origin?.lat != null && r?.destination?.lat != null;
    this.wrap.classList.toggle('no-route', !hasRoute);

    // Work in longitudes unwrapped around the origin (or the receiver) so a
    // trans-Pacific route draws as one line.
    const refLon = hasRoute ? r.origin.lon : receiver.lon;
    const pos = [ac.lat, nearLon(ac.lon, refLon)];
    const track = (trail ?? []).map(([lat, lon]) => [lat, nearLon(lon, refLon)]);
    track.push(pos);

    let origin;
    let dest;
    if (hasRoute) {
      origin = { lat: r.origin.lat, lon: r.origin.lon };
      dest = { lat: r.destination.lat, lon: nearLon(r.destination.lon, refLon) };
      this.#drawAirports(ac.hex, r, origin, dest);
      this.flownLine.setLatLngs(greatCirclePoints(origin, { lat: pos[0], lon: pos[1] }, 48));
      const ahead = greatCirclePoints({ lat: pos[0], lon: pos[1] }, dest, 48);
      this.aheadLine.setLatLngs(ahead.map(([lat, lon]) => [lat, nearLon(lon, pos[1])]));
    } else {
      this.#drawAirports(ac.hex, null);
      this.flownLine.setLatLngs([]);
      this.aheadLine.setLatLngs([]);
    }
    this.trailLine.setLatLngs(track.length > 1 ? track : []);
    this.you.setLatLng([receiver.lat, nearLon(receiver.lon, refLon)]);
    this.#drawPlane(ac, pos);

    // Re-frame for a new aircraft or route, or when the plane nears the edge.
    const fitKey = `${ac.hex}|${hasRoute ? `${r.origin.lat},${r.origin.lon}>${r.destination.lat},${r.destination.lon}` : ''}`;
    const inside = this.fitKey && this.map.getBounds().pad(-0.12).contains(pos);
    if (fitKey !== this.fitKey || !inside) {
      this.fitKey = fitKey;
      this.#fit(
        hasRoute
          ? [[origin.lat, origin.lon], [dest.lat, dest.lon], pos]
          : [...track, [receiver.lat, nearLon(receiver.lon, refLon)]],
      );
    }
  }

  #fit(points) {
    let bounds = L.latLngBounds(points);
    // Don't zoom in to street level on a short track: show at least ~15 km.
    const c = bounds.getCenter();
    const minDeg = 0.07;
    bounds = bounds.extend([c.lat - minDeg, c.lng - minDeg / Math.cos((c.lat * Math.PI) / 180)]);
    bounds = bounds.extend([c.lat + minDeg, c.lng + minDeg / Math.cos((c.lat * Math.PI) / 180)]);
    const pad = Math.round(Math.min(this.wrap.clientWidth, this.wrap.clientHeight) * 0.14);
    this.map.fitBounds(bounds, { padding: [pad, pad], maxZoom: 11, animate: false });
  }

  #drawAirports(hex, route, origin, dest) {
    const key = route ? `${hex}|${origin.lat},${origin.lon}|${dest.lat},${dest.lon}` : `${hex}|none`;
    if (key === this.routeKey) return;
    this.routeKey = key;
    this.routeLayer.clearLayers();
    if (!route) return;
    const c = this.colors;
    const airport = (ap, at, cls) => {
      L.circleMarker([at.lat, at.lon], {
        interactive: false,
        radius: 4,
        weight: 2,
        color: c.text,
        fillColor: c.bg,
        fillOpacity: 1,
      }).addTo(this.routeLayer);
      const code = ap.iata || ap.icao;
      if (code) {
        L.marker([at.lat, at.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: `mm-ap ${cls}`, html: `<span>${esc(code)}</span>`, iconSize: [0, 0] }),
        }).addTo(this.routeLayer);
      }
    };
    airport(route.origin, origin, 'from');
    airport(route.destination, dest, 'to');
  }

  #drawPlane(ac, pos) {
    const category = ac.typeInfo?.category ?? 'narrowbody';
    const size = Math.round(Math.max(18, Math.min(this.wrap.clientWidth, this.wrap.clientHeight) * 0.13));
    const key = `${category}|${size}`;
    if (key !== this.planeKey) {
      this.planeKey = key;
      this.plane.setIcon(
        L.divIcon({
          className: 'mm-plane',
          iconSize: [size, size],
          html: `<div class="glyph"><svg viewBox="0 0 64 64">${silhouettePaths(category)}</svg></div>`,
        }),
      );
    }
    this.plane.setLatLng(pos);
    const glyph = this.plane.getElement()?.querySelector('.glyph');
    if (glyph) glyph.style.transform = `rotate(${ac.trackDeg ?? 0}deg)`;
  }
}
