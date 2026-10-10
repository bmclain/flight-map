// The traffic explorer: filter the logged visits, group them by any dimension
// (shared/traffic-dims.js) and count flights or different aircraft, plus the
// views that always come with it — a trend, an hour × weekday grid, height
// and distance spreads, and the matching flights themselves. Pure: give it
// the visits; TrafficLog.explore() reads them from the day files.
import { DIMENSIONS, dimKey, dimLabel, ALT_EDGES_FT, DIST_EDGES_KM } from '../shared/traffic-dims.js';

export const MAX_GROUPS = 20;
export const MAX_FLIGHTS = 300;

/** Free-text search over the things people look for. */
function matchesText(v, q) {
  if (!q) return true;
  const hay = [
    v.callsign,
    v.flight,
    v.reg,
    v.type,
    v.typeName,
    v.airline?.name,
    v.airline?.icao,
    v.from?.code,
    v.from?.city,
    v.to?.code,
    v.to?.city,
    v.special?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * @param {object[]} visits
 * @param {object} opts
 * @param {string} opts.group      dimension to group by
 * @param {'flights'|'aircraft'} opts.measure
 * @param {Record<string,string[]>} opts.filters  dimension → keys to keep ('' = unknown)
 * @param {string} [opts.q]        search text
 * @param {string[]} opts.dates    the days covered, oldest first ("2026-10-08")
 * @param {object} ctx            { manufacturer(code), units, clock24h }
 */
export function explore(
  visits,
  { group = 'airline', measure = 'flights', filters = {}, q = '', dates = [] },
  ctx = {},
) {
  const active = Object.entries(filters).filter(([d, keys]) => DIMENSIONS[d] && keys?.length);
  const kept = visits.filter((v) => matchesText(v, q) && active.every(([d, keys]) => keys.includes(dimKey(d, v, ctx))));
  const count = (list) => (measure === 'aircraft' ? new Set(list.map((v) => v.hex)).size : list.length);

  // The grouped view: by count, or in natural order for hours, weekdays and bands.
  const buckets = new Map();
  for (const v of kept) {
    const k = dimKey(group, v, ctx);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { key: k, label: dimLabel(group, k, ctx, v), visits: [] }));
    b.visits.push(v);
  }
  const dim = DIMENSIONS[group];
  let rows = [...buckets.values()].map((b) => ({
    key: b.key,
    label: b.label,
    flights: b.visits.length,
    aircraft: new Set(b.visits.map((v) => v.hex)).size,
  }));
  const value = (r) => (measure === 'aircraft' ? r.aircraft : r.flights);
  let other = null;
  if (dim.ordered) {
    // Every step of the scale, empty ones too, so the shape reads right.
    const byKey = new Map(rows.map((r) => [r.key, r]));
    rows = Array.from(
      { length: dim.ordered },
      (_, i) =>
        byKey.get(String(i)) ?? {
          key: String(i),
          label: dimLabel(group, String(i), ctx),
          flights: 0,
          aircraft: 0,
        },
    );
    if (byKey.has('')) rows.unshift(byKey.get(''));
  } else {
    rows.sort((a, b) => value(b) - value(a) || a.label.localeCompare(b.label));
    if (rows.length > MAX_GROUPS) {
      const rest = rows.slice(MAX_GROUPS);
      const restKeys = new Set(rest.map((r) => r.key));
      const restVisits = kept.filter((v) => restKeys.has(dimKey(group, v, ctx)));
      other = { groups: rest.length, flights: restVisits.length, aircraft: new Set(restVisits.map((v) => v.hex)).size };
      rows = rows.slice(0, MAX_GROUPS);
    }
  }

  // Over time: by day for a range, by hour for one day.
  const byDay = dates.length > 1;
  const trend = byDay
    ? dates.map((date) => {
        const list = kept.filter((v) => v.day === date);
        return { key: date, flights: list.length, aircraft: new Set(list.map((v) => v.hex)).size };
      })
    : Array.from({ length: 24 }, (_, h) => {
        const list = kept.filter((v) => new Date(v.first).getHours() === h);
        return { key: String(h), flights: list.length, aircraft: new Set(list.map((v) => v.hex)).size };
      });

  // When: weekday (Monday first) × hour.
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const v of kept) heat[(new Date(v.first).getDay() + 6) % 7][new Date(v.first).getHours()]++;

  const spread = (dimName, edges) => {
    const out = Array(edges.length + 1).fill(0);
    let unknown = 0;
    for (const v of kept) {
      const k = dimKey(dimName, v, ctx);
      if (k === '') unknown++;
      else out[Number(k)]++;
    }
    return { counts: out, unknown };
  };

  const hexes = new Set(kept.map((v) => v.hex));
  const withSource = kept.filter((v) => v.antenna || v.online);
  return {
    group,
    measure,
    totals: {
      flights: kept.length,
      aircraft: hexes.size,
      airlines: new Set(kept.map((v) => v.airline?.icao ?? v.airline?.name).filter(Boolean)).size,
      types: new Set(kept.map((v) => v.type).filter(Boolean)).size,
      withinCardRange: kept.filter((v) => v.overhead).length,
      // Share of flights your antenna heard, where that was recorded.
      antenna: withSource.length ? withSource.filter((v) => v.antenna).length : null,
      withSource: withSource.length,
      ofAll: visits.length,
    },
    groups: rows,
    other,
    total: count(kept),
    trend: { unit: byDay ? 'day' : 'hour', points: trend },
    heat,
    altitude: spread('altitude', ALT_EDGES_FT),
    distance: spread('distance', DIST_EDGES_KM),
    flights: [...kept]
      .sort((a, b) => b.first - a.first)
      .slice(0, MAX_FLIGHTS)
      .map((v) => ({
        hex: v.hex,
        first: v.first,
        last: v.last,
        callsign: v.callsign ?? null,
        flight: v.flight ?? null,
        reg: v.reg ?? null,
        type: v.type ?? null,
        typeName: v.typeName ?? null,
        airline: v.airline?.name ?? null,
        from: v.from?.code ?? null,
        to: v.to?.code ?? null,
        minKm: v.minKm ?? null,
        altFt: v.altAtClosestFt ?? v.minAltFt ?? null,
        maxGsKt: v.maxGsKt ?? null,
        source: v.antenna ? 'antenna' : v.online ? 'online' : null,
        special: v.special?.kind ?? (v.military ? 'military' : null),
      })),
    flightsShown: Math.min(kept.length, MAX_FLIGHTS),
  };
}
