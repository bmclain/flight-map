// Polls an aircraft.json URL (readsb/dump1090/tar1090 on the Pi, or a
// readsb-style online API) and hands parsed aircraft to `onData`.
import { parseAircraftJson } from './parse.js';
import { USER_AGENT } from '../util/fetch.js';

export const KM_PER_NM = 1.852;

/** Fill {lat} {lon} {radiusNm} {radiusKm} placeholders in an API URL. */
export function expandUrl(template, { lat, lon, radiusKm }) {
  const radiusNm = Math.min(250, Math.ceil(radiusKm / KM_PER_NM));
  return template
    .replaceAll('{lat}', lat.toFixed(4))
    .replaceAll('{lon}', lon.toFixed(4))
    .replaceAll('{radiusNm}', String(radiusNm))
    .replaceAll('{radiusKm}', String(Math.ceil(radiusKm)));
}

export class HttpSource {
  /**
   * @param {object} opts
   * @param {string} opts.type     config source type (for status display)
   * @param {() => string} opts.url  called before each poll so config changes apply
   * @param {number} opts.pollSeconds
   * @param {(data: {now:number, aircraft:object[]}) => void} opts.onData
   */
  constructor({ type, url, pollSeconds, onData, log = console, fetchImpl = fetch }) {
    this.type = type;
    this.url = url;
    this.pollMs = Math.max(500, pollSeconds * 1000);
    this.onData = onData;
    this.log = log;
    this.fetch = fetchImpl;
    this.timer = null;
    this.running = false;
    this.state = {
      lastOkAt: null,
      lastError: null,
      lastErrorAt: null,
      aircraftCount: 0,
      positionCount: 0,
      messageRate: null,
    };
    this.lastMessages = null;
  }

  start() {
    this.running = true;
    this.#loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  async #loop() {
    if (!this.running) return;
    const started = Date.now();
    try {
      await this.pollOnce();
    } catch {
      // recorded in state by pollOnce
    }
    if (!this.running) return;
    const wait = Math.max(this.state.lastError && !this.#recentlyOk() ? 5000 : 0, this.pollMs - (Date.now() - started));
    this.timer = setTimeout(() => this.#loop(), wait);
  }

  #recentlyOk() {
    return this.state.lastOkAt && Date.now() - this.state.lastOkAt < 10_000;
  }

  async pollOnce() {
    const url = this.url();
    try {
      const res = await this.fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const data = parseAircraftJson(await res.json());
      this.#recordOk(data);
      this.onData(data);
      return data;
    } catch (err) {
      let message = err.message;
      if (err.name === 'TimeoutError') message = `Timed out fetching ${url}`;
      else if (err.cause?.code) message = `Can't reach ${url} (${err.cause.code})`;
      else if (err instanceof SyntaxError) message = `${url} did not return JSON`;
      if (this.state.lastError !== message) this.log.warn(`source: ${message}`);
      this.state.lastError = message;
      this.state.lastErrorAt = Date.now();
      throw err;
    }
  }

  #recordOk(data) {
    const now = Date.now();
    if (data.messages != null && this.lastMessages) {
      const dt = (now - this.lastMessages.at) / 1000;
      if (dt > 0) this.state.messageRate = Math.max(0, (data.messages - this.lastMessages.count) / dt);
    }
    if (data.messages != null) this.lastMessages = { count: data.messages, at: now };
    this.state.lastOkAt = now;
    this.state.lastError = null;
    this.state.aircraftCount = data.aircraft.length;
    this.state.positionCount = data.aircraft.filter((a) => a.lat != null).length;
  }

  status() {
    return { type: this.type, url: this.url(), ...this.state };
  }
}
