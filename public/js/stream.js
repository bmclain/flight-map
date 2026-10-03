// Live connection to the server (Server-Sent Events). Keeps the latest config,
// aircraft list and each aircraft's track (the server sends what it has
// on connecting, so trails show straight away), and emits 'config' /
// 'aircraft' events.
import { addTrackPoint } from '/shared/track.js';

export class LiveData extends EventTarget {
  constructor(url = '/api/stream') {
    super();
    this.url = url;
    this.config = null;
    this.aircraft = [];
    this.byHex = new Map();
    this.trails = new Map();
    this.status = null;
    this.lastMessageAt = 0;
    this.connected = false;
    this.bootId = null;
    // Server clock minus ours: track times are the server's.
    this.clockOffset = 0;
  }

  /** The time now by the server's clock. */
  now() {
    return Date.now() + this.clockOffset;
  }

  get ready() {
    return !!this.config;
  }

  /** True if we have heard from the server recently. */
  get live() {
    return this.connected && Date.now() - this.lastMessageAt < 10_000;
  }

  connect() {
    this.es = new EventSource(this.url);
    this.es.addEventListener('open', () => {
      this.connected = true;
    });
    this.es.addEventListener('error', () => {
      this.connected = false;
      this.dispatchEvent(new Event('status'));
    });
    this.es.addEventListener('hello', (e) => {
      const data = JSON.parse(e.data);
      // The server restarted with (possibly) new code: reload to pick it up.
      if (this.bootId && data.bootId && data.bootId !== this.bootId) {
        location.reload();
        return;
      }
      this.bootId = data.bootId ?? null;
      this.connected = true;
      this.trails.clear();
      for (const ac of data.aircraft) {
        if (ac.trail) this.trails.set(ac.hex, ac.trail);
      }
      this.#setConfig(data.config);
      this.#setAircraft(data);
    });
    this.es.addEventListener('aircraft', (e) => this.#setAircraft(JSON.parse(e.data)));
    this.es.addEventListener('config', (e) => this.#setConfig(JSON.parse(e.data).config));
  }

  #setConfig(config) {
    this.config = config;
    this.dispatchEvent(new Event('config'));
  }

  #setAircraft({ aircraft, status, serverTime }) {
    this.lastMessageAt = Date.now();
    if (Number.isFinite(serverTime)) this.clockOffset = serverTime - this.lastMessageAt;
    this.status = status ?? this.status;
    this.aircraft = aircraft;
    this.byHex = new Map(aircraft.map((a) => [a.hex, a]));
    this.#updateTrails();
    this.dispatchEvent(new Event('aircraft'));
  }

  #updateTrails() {
    const now = this.now();
    for (const ac of this.aircraft) {
      let trail = this.trails.get(ac.hex);
      if (!trail) {
        trail = [];
        this.trails.set(ac.hex, trail);
      }
      addTrackPoint(trail, ac.lat, ac.lon, now, ac.onGround ? 0 : (ac.altFt ?? ac.altGeomFt ?? null));
    }
    for (const hex of this.trails.keys()) {
      if (!this.byHex.has(hex)) this.trails.delete(hex);
    }
  }
}
