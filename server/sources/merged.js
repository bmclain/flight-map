// Your own receiver, filled in from an online feed: the antenna's aircraft.json
// every second or so, plus a readsb-style API (adsb.lol) every few seconds for
// the planes the antenna doesn't hear. Each aircraft is marked with where its
// position came from: `via: 'antenna'` or `via: 'online'`.
import { HttpSource } from './http.js';

/** Online positions are only used when they're fresher than the antenna's by this much (s). */
const PREFER_ANTENNA_S = 5;

/**
 * Merge the antenna's aircraft with the online feed's, as of `now` (ms).
 * Online records are aged by the time since they were fetched.
 */
export function mergeAircraft(local, online, now = Date.now()) {
  const out = new Map();
  for (const ac of local?.data.aircraft ?? []) out.set(ac.hex, { ...ac, via: 'antenna' });
  if (online) {
    const age = Math.max(0, (now - online.at) / 1000);
    for (const rec of online.data.aircraft) {
      const ac = {
        ...rec,
        // Their receivers' signal strength, not ours.
        rssi: null,
        seen: rec.seen + age,
        seenPos: rec.seenPos == null ? null : rec.seenPos + age,
        via: 'online',
      };
      const mine = out.get(ac.hex);
      if (!mine) {
        out.set(ac.hex, ac);
        continue;
      }
      // Heard by the antenna but without a (recent) position: use the online one,
      // keeping what the antenna knows.
      const minePos = mine.lat != null ? mine.seenPos : Infinity;
      if (ac.seenPos != null && ac.seenPos + PREFER_ANTENNA_S < minePos) {
        out.set(ac.hex, { ...ac, rssi: mine.rssi, heardByAntenna: true });
      }
    }
  }
  return [...out.values()];
}

export class MergedSource {
  /**
   * @param {object} opts
   * @param {() => string} opts.url        the antenna's aircraft.json
   * @param {() => string} opts.onlineUrl  the online API
   * @param {number} opts.pollSeconds      for the antenna
   * @param {number} opts.onlineSeconds    for the online feed (free APIs rate-limit)
   */
  constructor({ url, onlineUrl, pollSeconds, onlineSeconds, onData, log = console, fetchImpl = fetch }) {
    this.onData = onData;
    this.local = null; // { at, data } latest from the antenna
    this.online = null; // { at, data } latest from the online feed
    this.antenna = new HttpSource({
      type: 'aircraft-json',
      url,
      pollSeconds,
      log,
      fetchImpl,
      onData: (data) => {
        this.local = { at: Date.now(), data };
        this.#emit();
      },
    });
    this.feed = new HttpSource({
      type: 'adsb-api',
      url: onlineUrl,
      pollSeconds: Math.max(5, onlineSeconds),
      log,
      fetchImpl,
      onData: (data) => {
        this.online = { at: Date.now(), data };
        // With the antenna down, the online feed alone keeps the display going.
        if (!this.#antennaOk()) this.#emit();
      },
    });
  }

  #antennaOk() {
    return !!this.local && Date.now() - this.local.at < 15_000;
  }

  #emit(now = Date.now()) {
    // An online snapshot older than a minute is no help.
    const online = this.online && now - this.online.at < 60_000 ? this.online : null;
    const local = this.#antennaOk() ? this.local : null;
    this.onData({ now, messages: local?.data.messages ?? null, aircraft: mergeAircraft(local, online, now) });
  }

  start() {
    this.antenna.start();
    this.feed.start();
  }

  stop() {
    this.antenna.stop();
    this.feed.stop();
  }

  /** "Test connection": both feeds once. */
  async pollOnce() {
    const [mine, theirs] = await Promise.allSettled([this.antenna.pollOnce(), this.feed.pollOnce()]);
    if (mine.status === 'rejected') throw mine.reason;
    return {
      ...mine.value,
      online: theirs.status === 'fulfilled' ? theirs.value : null,
      onlineError: theirs.reason?.message,
    };
  }

  status() {
    const a = this.antenna.status();
    const o = this.feed.status();
    const antennaOk = !!a.lastOkAt && Date.now() - a.lastOkAt < 15_000;
    const onlineOk = !!o.lastOkAt && Date.now() - o.lastOkAt < 60_000;
    return {
      ...a,
      type: 'merged',
      // The display keeps working on either feed.
      lastOkAt: Math.max(a.lastOkAt ?? 0, onlineOk ? o.lastOkAt : 0) || null,
      lastError: antennaOk ? null : a.lastError,
      antenna: { ...a, ok: antennaOk },
      online: { ...o, ok: onlineOk },
    };
  }
}
