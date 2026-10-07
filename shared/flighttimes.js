// Estimated take-off and landing times from the route and the aircraft's live
// position and ground speed. The free route databases have no schedules, so
// these are estimates: good to roughly ±15 minutes for landing, rougher for
// take-off on long flights. Times are shown in each airport's local time, as on
// a timetable.
import { distanceM } from './geo.js';

const MIN = 60_000;
const ROUND_MS = 5 * MIN;

const round = (t) => Math.round(t / ROUND_MS) * ROUND_MS;

// Typical cruise ground speed (kt) by silhouette category. Used for the part of
// the flight we didn't see, since the current speed is misleading while the
// aircraft is climbing out or descending.
const CRUISE_KT = {
  heavy4: 480,
  widebody: 480,
  narrowbody: 450,
  regional: 430,
  bizjet: 430,
  fighter: 450,
  turboprop: 270,
  light: 130,
  helicopter: 110,
  glider: 60,
  balloon: 10,
};

/**
 * @param {{origin: {lat, lon}, destination: {lat, lon}}} route
 * @param {{lat: number, lon: number, gsKt: number|null, onGround: boolean, typeInfo?: {category: string}}} ac
 * @param {number} now ms
 * @returns {{takeoff: number, landing: number, durationMin: number} | null}
 */
export function estimateFlightTimes(route, ac, now = Date.now()) {
  const o = route?.origin;
  const d = route?.destination;
  if (!o || !d || o.lat == null || d.lat == null || ac?.lat == null) return null;
  if (ac.onGround || !(ac.gsKt > 60)) return null;
  const cruiseKt = CRUISE_KT[ac.typeInfo?.category] ?? Math.max(ac.gsKt, 300);
  const perMs = (kt) => (kt * 1.852) / 3_600_000; // km per ms
  const flownKm = distanceM(o.lat, o.lon, ac.lat, ac.lon) / 1000;
  const remainingKm = distanceM(ac.lat, ac.lon, d.lat, d.lon) / 1000;
  // Time already flown: at least typical cruise speed (the aircraft may be slow
  // right now because it's descending), plus a few minutes for the climb.
  const takeoff = now - flownKm / perMs(Math.max(ac.gsKt, cruiseKt)) - (flownKm > 80 ? 8 * MIN : 2 * MIN);
  // Time to go: the current speed is right when close in; far out it may still
  // be climbing, so use at least 90% of cruise. Plus a few minutes for approach.
  const toGoKt = remainingKm > 150 ? Math.max(ac.gsKt, cruiseKt * 0.9) : ac.gsKt;
  const landing = now + remainingKm / perMs(toGoKt) + (remainingKm > 80 ? 6 * MIN : 2 * MIN);
  const durationMin = Math.max(5, Math.round((landing - takeoff) / ROUND_MS) * 5);
  return { takeoff: round(takeoff), landing: round(landing), durationMin };
}

const knownZones = new Map();

/** True when this browser knows the zone (an old one may lack a newly added zone). */
function knownZone(tz) {
  if (!knownZones.has(tz)) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      knownZones.set(tz, true);
    } catch {
      knownZones.set(tz, false);
    }
  }
  return knownZones.get(tz);
}

/** Options with the airport's zone, or none (the viewer's own) when it's missing or unknown here. */
const zoneOptions = (tz, opts) => (tz && knownZone(tz) ? { ...opts, timeZone: tz } : opts);

/** Clock time at an airport, e.g. "5:10 PM" in `tz` ("America/Regina"). */
export function airportClock(t, tz, { hour12 = true, locale } = {}) {
  return new Date(t).toLocaleTimeString(locale, zoneOptions(tz, { hour: 'numeric', minute: '2-digit', hour12 }));
}

/** Calendar day number of `t` at an airport, for comparing dates across zones. */
function airportDay(t, tz) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    zoneOptions(tz, { year: 'numeric', month: 'numeric', day: 'numeric' }),
  ).formatToParts(new Date(t));
  const n = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(n('year'), n('month') - 1, n('day')) / 86_400_000;
}

/**
 * Days between the local take-off date at the origin and the local landing
 * date at the destination, like the "+1" on an airline timetable.
 */
export function landingDayOffset(takeoff, originTz, landing, destTz) {
  return airportDay(landing, destTz) - airportDay(takeoff, originTz);
}

/** 95 → "1 h 35 min", 40 → "40 min". */
export function formatDuration(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
