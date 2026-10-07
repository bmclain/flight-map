import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDeg,
  compassPoint,
  destinationPoint,
  distanceM,
  elevationDeg,
  greatCirclePoints,
  normalizeDeg,
  relativeBearing,
  routeDetourM,
} from '../shared/geo.js';
import { elevationText, relativeDirectionText, verticalTrend } from '../shared/directions.js';
import { formatAltitude, formatDistance, formatSpeed, kmToUnit, unitToKm } from '../shared/units.js';
import { isDaylight, sunElevationDeg } from '../shared/sun.js';
import { airportClock, estimateFlightTimes, formatDuration, landingDayOffset } from '../shared/flighttimes.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

test('distance between Seattle and Portland airports', () => {
  near(distanceM(47.4502, -122.3088, 45.5898, -122.5951) / 1000, 208, 3);
});

test('bearings to the cardinal directions', () => {
  near(bearingDeg(0, 0, 1, 0), 0, 0.01);
  near(bearingDeg(0, 0, 0, 1), 90, 0.01);
  near(bearingDeg(0, 0, -1, 0), 180, 0.01);
  near(bearingDeg(0, 0, 0, -1), 270, 0.01);
});

test('destinationPoint round-trips with distance and bearing', () => {
  const p = destinationPoint(47.6, -122.3, 63, 25_000);
  near(distanceM(47.6, -122.3, p.lat, p.lon), 25_000, 1);
  near(bearingDeg(47.6, -122.3, p.lat, p.lon), 63, 0.1);
});

test('elevation angle: overhead, 45° and the horizon', () => {
  near(elevationDeg(0, 3000, 0), 90, 0.001);
  near(elevationDeg(3000, 3000, 0), 45, 0.1);
  // A plane at 35,000 ft drops below the horizon ~370 km away because of curvature.
  near(elevationDeg(300_000, 10_668, 0), 0.69, 0.05);
  assert.ok(elevationDeg(400_000, 10_668, 0) < 0);
});

test('relative bearing is in (-180, 180]', () => {
  assert.equal(relativeBearing(10, 350), 20);
  assert.equal(relativeBearing(350, 10), -20);
  assert.equal(relativeBearing(180, 0), 180);
  assert.equal(relativeBearing(90, 90), 0);
  assert.equal(normalizeDeg(-30), 330);
});

test('compass points', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(44), 'NE');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(200, 16), 'SSW');
});

test('route detour is zero on the great circle and grows off it', () => {
  const a = { lat: 47.45, lon: -122.31 };
  const b = { lat: 37.62, lon: -122.37 };
  const mid = destinationPoint(a.lat, a.lon, bearingDeg(a.lat, a.lon, b.lat, b.lon), 300_000);
  near(routeDetourM(a, b, mid), 0, 50);
  assert.ok(routeDetourM(a, b, { lat: 40.6, lon: -73.8 }) > 3_000_000);
});

test('direction phrasing', () => {
  assert.equal(relativeDirectionText(0), 'Straight ahead');
  assert.equal(relativeDirectionText(45), 'Ahead, to the right');
  assert.equal(relativeDirectionText(-90), 'To your left');
  assert.equal(relativeDirectionText(135), 'Behind you, to the right');
  assert.equal(relativeDirectionText(180), 'Behind you');
  assert.equal(elevationText(2), 'Just above the horizon');
  assert.equal(elevationText(85), 'Almost overhead');
  assert.equal(verticalTrend(1500), 'climbing');
  assert.equal(verticalTrend(-800), 'descending');
  assert.equal(verticalTrend(64), 'level');
});

test('unit formatting', () => {
  assert.deepEqual(formatDistance(10, 'imperial'), { value: '6.2', unit: 'mi' });
  assert.deepEqual(formatDistance(100, 'metric'), { value: '100', unit: 'km' });
  assert.deepEqual(formatDistance(18.52, 'aviation'), { value: '10', unit: 'nm' });
  assert.deepEqual(formatSpeed(450, 'imperial'), { value: '518', unit: 'mph' });
  assert.deepEqual(formatAltitude(35_012, 'imperial'), { value: '35,000', unit: 'ft' });
  assert.deepEqual(formatAltitude(10_000, 'metric'), { value: '3,050', unit: 'm' });
  assert.deepEqual(formatDistance(null, 'metric'), { value: '—', unit: '' });
  near(unitToKm(kmToUnit(24.14, 'imperial'), 'imperial'), 24.14, 1e-9);
});

test('sun elevation: day and night', () => {
  // Seattle, summer solstice: local noon (≈20:10 UTC) vs local midnight.
  assert.ok(sunElevationDeg(new Date('2026-06-21T20:10:00Z'), 47.6, -122.3) > 60);
  assert.ok(sunElevationDeg(new Date('2026-06-21T08:10:00Z'), 47.6, -122.3) < -10);
  assert.equal(isDaylight(new Date('2026-12-21T20:00:00Z'), 47.6, -122.3), true);
  assert.equal(isDaylight(new Date('2026-12-21T06:00:00Z'), 47.6, -122.3), false);
});

test('estimated take-off, landing and duration', () => {
  const yvr = { lat: 49.19, lon: -123.18 };
  const yxe = { lat: 52.17, lon: -106.7 };
  // ~1180 km leg; aircraft 2/3 of the way along at 450 kt (833 km/h)
  const pos = destinationPoint(yvr.lat, yvr.lon, bearingDeg(yvr.lat, yvr.lon, yxe.lat, yxe.lon), 790_000);
  const now = Date.UTC(2026, 9, 2, 20, 0);
  const t = estimateFlightTimes({ origin: yvr, destination: yxe }, { ...pos, gsKt: 450, onGround: false }, now);
  near((t.landing - now) / 60_000, 35, 5, 'minutes to landing');
  near((now - t.takeoff) / 60_000, 65, 5, 'minutes since take-off');
  near(t.durationMin, 100, 10, 'duration');
  assert.equal(t.landing % 300_000, 0, 'rounded to 5 minutes');
  assert.equal(estimateFlightTimes({ origin: yvr, destination: yxe }, { ...pos, gsKt: 0, onGround: true }, now), null);
  // A descending airliner near its destination: elapsed time uses cruise speed, not the slow current speed
  const nearYxe = destinationPoint(yxe.lat, yxe.lon, bearingDeg(yxe.lat, yxe.lon, yvr.lat, yvr.lon), 28_000);
  const d = estimateFlightTimes(
    { origin: yvr, destination: yxe },
    { ...nearYxe, gsKt: 270, onGround: false, typeInfo: { category: 'narrowbody' } },
    now,
  );
  near((d.landing - now) / 60_000, 8, 5, 'landing soon');
  near(d.durationMin, 105, 15, 'YVR-YXE is under two hours');
  assert.equal(formatDuration(95), '1 h 35 min');
  assert.equal(formatDuration(40), '40 min');
  assert.equal(formatDuration(120), '2 h');
});

test("take-off and landing times are shown in each airport's own time zone", () => {
  // 20:00 UTC on 2 Oct 2026: 1:00 PM in Vancouver (PDT), 2:00 PM in Saskatoon (CST all year).
  const t = Date.UTC(2026, 9, 2, 20, 0);
  assert.equal(airportClock(t, 'America/Vancouver', { locale: 'en-US' }), '1:00 PM');
  assert.equal(airportClock(t, 'America/Regina', { locale: 'en-US' }), '2:00 PM');
  assert.equal(airportClock(t, 'Asia/Kolkata', { locale: 'en-US', hour12: false }), '01:30');
  // A missing or unknown zone falls back to the viewer's own clock rather than failing.
  const own = new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  assert.equal(airportClock(t, null, { locale: 'en-US' }), own);
  assert.equal(airportClock(t, 'Mars/Olympus_Mons', { locale: 'en-US' }), own);
});

test('landing day offset compares local dates at each end, like a timetable', () => {
  const hour = 3600_000;
  // Vancouver 1:00 PM 2 Oct → 10 h → Tokyo 3:00 PM 3 Oct: +1.
  const yvr = Date.UTC(2026, 9, 2, 20, 0);
  assert.equal(landingDayOffset(yvr, 'America/Vancouver', yvr + 10 * hour, 'Asia/Tokyo'), 1);
  // Tokyo 5:00 PM 3 Oct → 9 h → Vancouver 10:00 AM 3 Oct: same day.
  const nrt = Date.UTC(2026, 9, 3, 8, 0);
  assert.equal(landingDayOffset(nrt, 'Asia/Tokyo', nrt + 9 * hour, 'America/Vancouver'), 0);
  // Tokyo 12:30 AM 4 Oct → 9 h → Vancouver 5:30 PM 3 Oct: lands the day before.
  const late = Date.UTC(2026, 9, 3, 15, 30);
  assert.equal(landingDayOffset(late, 'Asia/Tokyo', late + 9 * hour, 'America/Vancouver'), -1);
  // Vancouver 11:00 PM → 2 h → Saskatoon 2:00 AM: past midnight there.
  const redeye = Date.UTC(2026, 9, 3, 6, 0);
  assert.equal(landingDayOffset(redeye, 'America/Vancouver', redeye + 2 * hour, 'America/Regina'), 1);
  // No zones known: both in the viewer's zone, still a valid offset.
  assert.equal(landingDayOffset(yvr, null, yvr + hour, null) >= 0, true);
});

test('great-circle points run from end to end along the route', () => {
  const sea = { lat: 47.4502, lon: -122.3088 };
  const jfk = { lat: 40.6413, lon: -73.7781 };
  const pts = greatCirclePoints(sea, jfk, 32);
  assert.equal(pts.length, 33);
  near(pts[0][0], sea.lat, 1e-6);
  near(pts[0][1], sea.lon, 1e-6);
  near(pts[32][0], jfk.lat, 1e-6);
  near(pts[32][1], jfk.lon, 1e-6);
  // Every point lies on the route: no detour.
  for (const [lat, lon] of pts) near(routeDetourM(sea, jfk, { lat, lon }), 0, 50);
  // The great circle bows north of the straight line on a Mercator map.
  assert.ok(pts[16][0] > (sea.lat + jfk.lat) / 2);
});

test('great-circle points across the antimeridian stay continuous', () => {
  const pts = greatCirclePoints({ lat: 35.55, lon: 139.78 }, { lat: 37.62, lon: -122.38 }, 40);
  for (let i = 1; i < pts.length; i++) assert.ok(Math.abs(pts[i][1] - pts[i - 1][1]) < 20);
  near(pts.at(-1)[1], -122.38 + 360, 1e-6);
});
