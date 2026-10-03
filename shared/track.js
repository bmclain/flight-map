// Aircraft tracks: arrays of [lat, lon, t, altFt] points, oldest first (altFt
// is 0 on the ground, null when unknown), shared by the server (which keeps
// every aircraft's track) and the browser (which extends the tracks it was
// sent). Straight, steady flight is stored as just the ends of each straight
// run, so an hour-long track stays small.
import { bearingDeg, distanceM } from './geo.js';

export const TRACK_STEP_MS = 4000;
/** How much track is kept per aircraft. */
export const TRACK_KEEP_MS = 3 * 3600_000;
const MIN_MOVE_M = 20;
// A point continues the current straight run while it stays within this many
// degrees of the run's direction and the run is no longer than MAX_RUN_MS.
const STRAIGHT_DEG = 2.5;
const MAX_RUN_MS = 120_000;
// …and while its altitude stays within this of the run's start, so a climb or
// descent keeps enough points to colour the path by altitude.
const RUN_ALT_FT = 1000;

/** Direction of the straight run that ends at each track's last point. */
const runs = new WeakMap();

const angleBetween = (a, b) => Math.abs(((b - a + 540) % 360) - 180);

/**
 * Add a position to `track` (unless it's too soon or too close to the last
 * one) and drop points older than TRACK_KEEP_MS. Returns true if it changed.
 */
export function addTrackPoint(track, lat, lon, t, altFt = null) {
  const last = track[track.length - 1];
  if (last && (t - last[2] < TRACK_STEP_MS || distanceM(last[0], last[1], lat, lon) < MIN_MOVE_M)) return false;
  const anchor = track[track.length - 2];
  const run = runs.get(track);
  if (
    run &&
    anchor &&
    run.end === last &&
    t - anchor[2] <= MAX_RUN_MS &&
    (altFt == null || anchor[3] == null || Math.abs(altFt - anchor[3]) <= RUN_ALT_FT) &&
    angleBetween(run.brg, bearingDeg(anchor[0], anchor[1], lat, lon)) <= STRAIGHT_DEG
  ) {
    // Still flying straight: move the end of the run instead of adding a point.
    run.end = [lat, lon, t, altFt];
    track[track.length - 1] = run.end;
  } else {
    const point = [lat, lon, t, altFt];
    if (last) runs.set(track, { brg: bearingDeg(last[0], last[1], lat, lon), end: point });
    track.push(point);
  }
  while (track.length && t - track[0][2] > TRACK_KEEP_MS) track.shift();
  return true;
}

/** The part of a track from `since` (ms) on. */
export function trackSince(track, since) {
  let i = 0;
  while (i < track.length && track[i][2] < since) i++;
  // Start from the point just before `since` so the line reaches back to it.
  return track.slice(Math.max(0, i - 1));
}
