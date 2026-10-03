// Colours for altitude, on the scale tar1090 and adsb.lol use for flight
// paths: orange on the ground, then yellow, green and blue as the plane
// climbs, purple from 40,000 ft up. Each hue is drawn at the same perceived
// brightness so no band of the scale stands out or fades into the map.
import { oklchToHex, rgbToOklch } from './colors.js';

// [altitude ft, hue°] — tar1090's altitude hues.
const HUE_STOPS = [
  [0, 20],
  [2000, 32.5],
  [4000, 43],
  [6000, 54],
  [8000, 72],
  [9000, 85],
  [11000, 140],
  [40000, 300],
];
export const ALTITUDE_TOP_FT = 40000;
const STEP_FT = 500;
const LIGHTNESS = { dark: 0.74, light: 0.56 };
const MAX_CHROMA = 0.17;
const UNKNOWN = { dark: '#8a97ab', light: '#6b7486' };

/** Hue (degrees, HSL) for an altitude in feet. */
export function altitudeHue(ft) {
  if (ft <= HUE_STOPS[0][0]) return HUE_STOPS[0][1];
  for (let i = 1; i < HUE_STOPS.length; i++) {
    const [a1, h1] = HUE_STOPS[i];
    if (ft <= a1) {
      const [a0, h0] = HUE_STOPS[i - 1];
      return h0 + ((h1 - h0) * (ft - a0)) / (a1 - a0);
    }
  }
  return HUE_STOPS[HUE_STOPS.length - 1][1];
}

/** HSL hue at full saturation → sRGB 0…1. */
function hueToRgb(h) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 0.5 - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const cache = new Map();

/** "#rrggbb" for an altitude in feet (in 500 ft steps) on this theme's map. */
export function altitudeColor(ft, theme = 'dark') {
  if (ft == null || !Number.isFinite(ft)) return UNKNOWN[theme] ?? UNKNOWN.dark;
  const step = Math.round(Math.min(Math.max(ft, 0), ALTITUDE_TOP_FT) / STEP_FT) * STEP_FT;
  const key = `${theme}|${step}`;
  let hex = cache.get(key);
  if (!hex) {
    const [, c, h] = rgbToOklch(hueToRgb(altitudeHue(step)));
    hex = oklchToHex([LIGHTNESS[theme] ?? LIGHTNESS.dark, Math.min(c, MAX_CHROMA), h]);
    cache.set(key, hex);
  }
  return hex;
}
