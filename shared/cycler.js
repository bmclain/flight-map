// Decides what the display shows next: an aircraft card, the map overview,
// or the idle screen. Pure logic (no DOM) so it can be unit tested.

/**
 * Split the aircraft list into the ones eligible for the card rotation and
 * the "spotlight" subset (very close aircraft that take over the display).
 */
export function selectPools(aircraft, display) {
  const minAlt = display.minAltitudeFt ?? -Infinity;
  const maxAlt = display.maxAltitudeFt ?? Infinity;
  const pool = aircraft.filter((a) => {
    if (a.distanceKm == null || a.distanceKm > display.cycleRangeKm) return false;
    if (a.onGround) return !display.hideGround;
    const alt = a.altFt ?? a.altGeomFt;
    if (alt == null) return true;
    return alt >= minAlt && alt <= maxAlt;
  });
  const sp = display.spotlight;
  const spotlight =
    sp && sp.enabled
      ? pool.filter(
          (a) => !a.onGround && a.distanceKm <= sp.rangeKm && (a.altFt ?? a.altGeomFt ?? 0) <= sp.maxAltitudeFt,
        )
      : [];
  return { pool, spotlight };
}

const HISTORY_LIMIT = 50;
const FORGET_AFTER_MS = 60 * 60 * 1000;

export class Cycler {
  constructor() {
    /** @type {{kind: 'card'|'map'|'idle', hex?: string, start: number, end: number} | null} */
    this.view = null;
    this.lastShown = new Map();
    this.history = [];
    this.cardsSinceMap = 0;
    this.pinned = null;
  }

  /**
   * Advance the rotation if the current slot has expired or became invalid.
   * @param {number} now ms timestamp
   * @param {{pool: object[], spotlight: object[], cycleMs: number, mapEvery: number, mapMs: number}} ctx
   */
  update(now, ctx) {
    this.#forgetOld(now);
    const active = this.#active(ctx);
    const v = this.view;

    if (this.pinned) {
      if ((ctx.all ?? ctx.pool).some((a) => a.hex === this.pinned)) {
        if (v?.kind !== 'card' || v.hex !== this.pinned) {
          this.view = { kind: 'card', hex: this.pinned, start: now, end: Infinity };
        }
        return this.view;
      }
      this.pinned = null;
    }

    let advance = !v || now >= v.end;
    if (v?.kind === 'card') {
      // A card someone asked for (tapped on the map) may be outside the cycle range.
      const present = v.manual ? (ctx.all ?? ctx.pool) : active;
      if (!present.some((a) => a.hex === v.hex)) advance = true;
    }
    if (v?.kind === 'idle' && active.length) advance = true;
    if (v?.kind === 'map' && ctx.spotlight.length) advance = true;
    return advance ? this.#advance(now, ctx) : v;
  }

  /** Show a specific aircraft now (e.g. tapped on the map), then carry on cycling. */
  show(hex, now, ctx) {
    this.pinned = null;
    this.view = { kind: 'card', hex, start: now, end: now + ctx.cycleMs, manual: true };
    this.lastShown.set(hex, now);
    if (this.history[this.history.length - 1] !== hex) this.history.push(hex);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    return this.view;
  }

  /** Skip to the next item immediately (also releases a pin). */
  next(now, ctx) {
    this.pinned = null;
    return this.#advance(now, ctx, { skipMap: true });
  }

  /** Go back to the previously shown aircraft that is still in range. */
  prev(now, ctx) {
    this.pinned = null;
    const present = new Set(ctx.pool.map((a) => a.hex));
    const current = this.view?.kind === 'card' ? this.view.hex : null;
    // history ends with the current aircraft; walk backwards past it
    for (let i = this.history.length - 1; i >= 0; i--) {
      const hex = this.history[i];
      if (hex !== current && present.has(hex)) {
        this.history.splice(i + 1);
        this.view = { kind: 'card', hex, start: now, end: now + ctx.cycleMs };
        this.lastShown.set(hex, now);
        return this.view;
      }
    }
    return this.view;
  }

  /** Hold the display on one aircraft until it leaves or is released. */
  pin(hex, now) {
    this.pinned = hex;
    this.view = { kind: 'card', hex, start: now, end: Infinity };
  }

  unpin(now, cycleMs) {
    this.pinned = null;
    if (this.view?.kind === 'card') this.view = { ...this.view, end: now + cycleMs };
  }

  #active(ctx) {
    return ctx.spotlight.length ? ctx.spotlight : ctx.pool;
  }

  #advance(now, ctx, { skipMap = false } = {}) {
    const active = this.#active(ctx);
    const prev = this.view;

    if (!active.length) {
      this.view = { kind: 'idle', start: now, end: Infinity };
      return this.view;
    }

    const mapDue =
      !skipMap &&
      !ctx.spotlight.length &&
      ctx.mapEvery > 0 &&
      this.cardsSinceMap >= ctx.mapEvery &&
      prev?.kind === 'card';
    if (mapDue) {
      this.cardsSinceMap = 0;
      this.view = { kind: 'map', start: now, end: now + ctx.mapMs };
      return this.view;
    }

    const currentHex = prev?.kind === 'card' ? prev.hex : null;
    let candidates = active;
    if (active.length > 1 && currentHex) candidates = active.filter((a) => a.hex !== currentHex);

    // Least recently shown first; never-shown aircraft first of all; ties → closest.
    const sorted = [...candidates].sort((a, b) => {
      const la = this.lastShown.get(a.hex) ?? -Infinity;
      const lb = this.lastShown.get(b.hex) ?? -Infinity;
      if (la !== lb) return la < lb ? -1 : 1;
      return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    });
    const hex = sorted[0].hex;

    this.view = { kind: 'card', hex, start: now, end: now + ctx.cycleMs };
    this.lastShown.set(hex, now);
    if (this.history[this.history.length - 1] !== hex) this.history.push(hex);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.cardsSinceMap++;
    return this.view;
  }

  #forgetOld(now) {
    for (const [hex, t] of this.lastShown) {
      if (now - t > FORGET_AFTER_MS) this.lastShown.delete(hex);
    }
  }
}
