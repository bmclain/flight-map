// The ways the traffic explorer can slice the flights it has logged. Shared by
// the server (grouping and filtering) and the traffic page (labels, in the
// display's units). Each visit is one plane's pass through the map range.
import { formatAltitude, formatDistance, formatSpeed, joinUnit } from './units.js';

export const CATEGORY_NAMES = {
  heavy4: 'Four-engine jets',
  widebody: 'Wide-body jets',
  narrowbody: 'Airliners',
  regional: 'Regional jets',
  bizjet: 'Business jets',
  turboprop: 'Turboprops & twins',
  light: 'Light aircraft',
  helicopter: 'Helicopters',
  fighter: 'Military jets',
  glider: 'Gliders',
  balloon: 'Balloons',
};

const WHO = {
  airline: 'Airlines (passengers)',
  cargo: 'Cargo',
  private: 'Private & charter',
  military: 'Military',
  police: 'Police',
  ambulance: 'Air ambulance',
  firefighting: 'Firefighting',
  rescue: 'Search & rescue',
  government: 'Government',
  other: 'Other special',
};

// Band edges: a value falls in the first band whose edge it's below.
export const ALT_EDGES_FT = [5000, 10_000, 20_000, 30_000, 40_000];
export const DIST_EDGES_KM = [5, 10, 25, 50, 100, 200];
export const SPEED_EDGES_KT = [100, 200, 300, 400, 500];

const band = (v, edges) => {
  if (v == null || !Number.isFinite(v)) return null;
  const i = edges.findIndex((e) => v < e);
  return i < 0 ? edges.length : i;
};

/** "Under 5,000 ft", "5,000–10,000 ft", "40,000 ft and up" in the given units. */
function bandLabel(i, edges, fmt) {
  if (i === 0) return `Under ${fmt(edges[0])}`;
  if (i >= edges.length) return `${fmt(edges.at(-1))} and up`;
  return `${fmt(edges[i - 1]).replace(/\s\S+$/, '')}–${fmt(edges[i])}`;
}

const altFmt = (units) => (ft) => joinUnit(formatAltitude(ft, units));
const distFmt = (units) => (km) => joinUnit(formatDistance(km, units));
const speedFmt = (units) => (kt) => joinUnit(formatSpeed(kt, units));

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hourName = (h, clock24h) =>
  clock24h ? `${String(h).padStart(2, '0')}:00` : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
const airportKey = (a) => a?.code || a?.icao || null;

/**
 * Every dimension: its name, whether its values have a natural order (hours,
 * bands — shown in that order rather than by count), and how to read it off a
 * visit: `value(v, ctx)` → key (or null for "unknown"); `label(key, ctx, v)`.
 * ctx: { units, clock24h, manufacturer(code) }.
 */
export const DIMENSIONS = {
  airline: {
    name: 'Airline',
    value: (v) => v.airline?.icao ?? v.airline?.name ?? null,
    label: (k, ctx, v) => v?.airline?.name ?? k,
    none: 'No airline',
  },
  who: {
    name: 'Who flies it',
    value: (v) => v.special?.kind ?? (v.military ? 'military' : v.cargo ? 'cargo' : v.airline ? 'airline' : 'private'),
    label: (k) => WHO[k] ?? k,
  },
  type: {
    name: 'Aircraft type',
    value: (v) => v.type ?? null,
    label: (k, ctx, v) => v?.typeName ?? k,
    none: 'Unknown type',
  },
  manufacturer: {
    name: 'Manufacturer',
    value: (v, ctx) => (v.type ? (ctx.manufacturer?.(v.type) ?? v.typeName?.split(' ')[0] ?? null) : null),
    label: (k) => k,
    none: 'Unknown',
  },
  kind: {
    name: 'Kind of aircraft',
    value: (v) => v.category ?? null,
    label: (k) => CATEGORY_NAMES[k] ?? k,
    none: 'Unknown',
  },
  route: {
    name: 'Route',
    value: (v) => (airportKey(v.from) && airportKey(v.to) ? `${airportKey(v.from)}-${airportKey(v.to)}` : null),
    label: (k) => k.replace('-', ' → '),
    none: 'No route',
  },
  origin: {
    name: 'Coming from',
    value: (v) => airportKey(v.from),
    label: (k, ctx, v) => (v?.from?.city ? `${v.from.city} (${k})` : k),
    none: 'No route',
  },
  destination: {
    name: 'Going to',
    value: (v) => airportKey(v.to),
    label: (k, ctx, v) => (v?.to?.city ? `${v.to.city} (${k})` : k),
    none: 'No route',
  },
  hour: {
    name: 'Hour of the day',
    ordered: 24,
    value: (v) => new Date(v.first).getHours(),
    label: (k, ctx) => hourName(Number(k), ctx.clock24h),
  },
  weekday: {
    name: 'Day of the week',
    ordered: 7,
    value: (v) => (new Date(v.first).getDay() + 6) % 7,
    label: (k) => WEEKDAYS[k],
  },
  altitude: {
    name: 'Height when closest',
    ordered: ALT_EDGES_FT.length + 1,
    value: (v) => (v.ground && v.altAtClosestFt == null ? null : band(v.altAtClosestFt ?? v.minAltFt, ALT_EDGES_FT)),
    label: (k, ctx) => bandLabel(Number(k), ALT_EDGES_FT, altFmt(ctx.units)),
    none: 'On the ground',
  },
  distance: {
    name: 'Closest distance',
    ordered: DIST_EDGES_KM.length + 1,
    value: (v) => band(v.minKm, DIST_EDGES_KM),
    label: (k, ctx) => bandLabel(Number(k), DIST_EDGES_KM, distFmt(ctx.units)),
  },
  speed: {
    name: 'Top speed',
    ordered: SPEED_EDGES_KT.length + 1,
    value: (v) => band(v.maxGsKt, SPEED_EDGES_KT),
    label: (k, ctx) => bandLabel(Number(k), SPEED_EDGES_KT, speedFmt(ctx.units)),
  },
  overhead: {
    name: 'Card range',
    ordered: 2,
    value: (v) => (v.overhead ? 0 : 1),
    label: (k) => (Number(k) === 0 ? 'Came within card range' : 'Further out'),
  },
  source: {
    name: 'Seen by',
    value: (v) => (v.antenna ? 'antenna' : v.online ? 'online' : null),
    label: (k) => ({ antenna: 'Your antenna', online: 'Online feed only' })[k] ?? k,
    none: 'Not recorded',
  },
};

/** A visit's key for a dimension, as a string ('' when unknown). */
export const dimKey = (dim, v, ctx = {}) => {
  const k = DIMENSIONS[dim].value(v, ctx);
  return k == null ? '' : String(k);
};

/** The label for a key ('' → the dimension's "unknown" wording). */
export function dimLabel(dim, key, ctx = {}, sample = null) {
  const d = DIMENSIONS[dim];
  if (key === '' || key == null) return d.none ?? 'Unknown';
  return d.label(d.ordered ? Number(key) : key, ctx, sample) ?? String(key);
}
