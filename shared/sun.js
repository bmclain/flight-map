// Approximate solar elevation (±1°), used to switch the display between the
// light (daytime, readable in sun) and dark (night) themes.
import { toDeg, toRad } from './geo.js';

const J2000_MS = Date.UTC(2000, 0, 1, 12);

export function sunElevationDeg(date, lat, lon) {
  const d = (date.getTime() - J2000_MS) / 86400000;
  const g = toRad((357.529 + 0.98560028 * d) % 360); // mean anomaly
  const q = (280.459 + 0.98564736 * d) % 360; // mean longitude
  const L = toRad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)); // ecliptic longitude
  const e = toRad(23.439 - 0.00000036 * d); // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstHours = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = toRad(gmstHours * 15 + lon) - ra;
  const phi = toRad(lat);
  return toDeg(Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)));
}

/** True between civil dawn and civil dusk. */
export function isDaylight(date, lat, lon) {
  return sunElevationDeg(date, lat, lon) > -6;
}
