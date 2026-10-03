// Geometry helpers shared by the server and the browser.
// Distances are in metres unless the name says otherwise; angles are degrees.

export const EARTH_RADIUS_M = 6371008.8;
export const FT_PER_M = 3.28084;
export const M_PER_FT = 0.3048;

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

/** Wrap any angle into [0, 360). */
export function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Great-circle distance between two points (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial compass bearing from point 1 to point 2, in [0, 360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** Point reached by travelling `distM` from (lat, lon) on initial bearing `brgDeg`. */
export function destinationPoint(lat, lon, brgDeg, distM) {
  const d = distM / EARTH_RADIUS_M;
  const brg = toRad(brgDeg);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: toDeg(p2), lon: ((toDeg(l2) + 540) % 360) - 180 };
}

/**
 * Angle above the horizon at which an observer sees a target, accounting for
 * the curvature of the earth (no refraction).
 */
export function elevationDeg(groundDistM, targetAltM, observerAltM = 0) {
  const theta = groundDistM / EARTH_RADIUS_M;
  const rt = EARTH_RADIUS_M + targetAltM;
  const ro = EARTH_RADIUS_M + observerAltM;
  const horizontal = rt * Math.sin(theta);
  const vertical = rt * Math.cos(theta) - ro;
  if (horizontal === 0 && vertical === 0) return 90;
  return toDeg(Math.atan2(vertical, horizontal));
}

/**
 * Bearing of a target relative to the direction the viewer is facing,
 * in (-180, 180]. 0 = straight ahead, +90 = to the right, -90 = to the left.
 */
export function relativeBearing(bearing, facing) {
  let rel = normalizeDeg(bearing - facing);
  if (rel > 180) rel -= 360;
  return rel;
}

const POINTS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const POINTS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** Compass point name ("NE") for a bearing. */
export function compassPoint(deg, points = 8) {
  const names = points === 16 ? POINTS_16 : POINTS_8;
  const step = 360 / names.length;
  return names[Math.round(normalizeDeg(deg) / step) % names.length];
}

const COMPASS_WORDS = {
  N: 'north',
  NE: 'northeast',
  E: 'east',
  SE: 'southeast',
  S: 'south',
  SW: 'southwest',
  W: 'west',
  NW: 'northwest',
};

/** "northeast" etc. */
export function compassWord(deg) {
  return COMPASS_WORDS[compassPoint(deg, 8)];
}

/**
 * How far a point is off the great-circle "corridor" between two airports.
 * Returns the extra distance (m) flown by detouring via the point:
 * d(a,p) + d(p,b) - d(a,b). Zero when the point lies on the route.
 */
export function routeDetourM(a, b, p) {
  return (
    distanceM(a.lat, a.lon, p.lat, p.lon) +
    distanceM(p.lat, p.lon, b.lat, b.lon) -
    distanceM(a.lat, a.lon, b.lat, b.lon)
  );
}

/**
 * Points along the great circle from a to b (inclusive), for drawing a route.
 * Longitudes are "unwrapped" so consecutive points never jump by more than
 * 180°, which keeps a line across the antimeridian from streaking round the map.
 * @returns {[number, number][]} [lat, lon] pairs
 */
export function greatCirclePoints(a, b, segments = 64) {
  const p1 = toRad(a.lat);
  const l1 = toRad(a.lon);
  const p2 = toRad(b.lat);
  const l2 = toRad(b.lon);
  const d = distanceM(a.lat, a.lon, b.lat, b.lon) / EARTH_RADIUS_M;
  if (d < 1e-9) return [[a.lat, a.lon]];
  const out = [];
  let prevLon = a.lon;
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    const lat = toDeg(Math.atan2(z, Math.hypot(x, y)));
    let lon = toDeg(Math.atan2(y, x));
    lon += Math.round((prevLon - lon) / 360) * 360;
    prevLon = lon;
    out.push([lat, lon]);
  }
  return out;
}
