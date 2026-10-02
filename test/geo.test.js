import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDeg,
  compassPoint,
  destinationPoint,
  distanceM,
  elevationDeg,
  normalizeDeg,
  relativeBearing,
  routeDetourM,
} from '../shared/geo.js';
import { elevationText, relativeDirectionText, verticalTrend } from '../shared/directions.js';
import { formatAltitude, formatDistance, formatSpeed, kmToUnit, unitToKm } from '../shared/units.js';
import { isDaylight, sunElevationDeg } from '../shared/sun.js';

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
