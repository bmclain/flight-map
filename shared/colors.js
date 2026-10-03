// Colour helpers (OKLCH, a perceptual colour space) for drawing brand colours
// on the map: a navy livery would vanish on the dark map and a yellow one on
// the light map, so each colour keeps its hue but has its lightness moved into
// a range that shows up on the current theme.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** "#rrggbb" → [r, g, b] in 0…1, or null. */
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}

export function toHex(rgb) {
  return `#${rgb
    .map((v) =>
      Math.round(clamp(v, 0, 1) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** sRGB (0…1) → OKLCH [L 0…1, C, h degrees]. */
export function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** OKLCH → sRGB (0…1), possibly out of gamut (values outside 0…1). */
export function oklchToRgb([L, C, h]) {
  const A = C * Math.cos((h * Math.PI) / 180);
  const B = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toGamma);
}

const inGamut = (rgb) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → "#rrggbb", lowering chroma until the colour fits in sRGB. */
export function oklchToHex([L, C, h]) {
  let rgb = oklchToRgb([L, C, h]);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToRgb([L, mid, h]))) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgb([L, lo, h]);
  }
  return toHex(rgb);
}

// Lightness that stands out on each theme's map, and a minimum chroma so a
// near-black livery still reads as a colour rather than grey.
// The dark floor is just low enough to leave Air Canada's red alone: lifted
// any higher, saturated reds turn coral.
const MAP_LIGHTNESS = { dark: [0.6, 0.8], light: [0.42, 0.58] };
const MIN_CHROMA = 0.09;

/** A brand colour moved into the lightness range that shows up on this theme's map. */
export function mapColor(hex, theme) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [L, C, h] = rgbToOklch(rgb);
  const [lo, hi] = MAP_LIGHTNESS[theme] ?? MAP_LIGHTNESS.dark;
  return oklchToHex([clamp(L, lo, hi), Math.max(C, MIN_CHROMA), h]);
}

/**
 * A steady colour for a name with no known brand colour (same name → same
 * colour), picked from 12 hues spaced evenly round the colour wheel so two
 * names rarely land on look-alike colours.
 */
export function colorFromName(name, theme) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const [lo, hi] = MAP_LIGHTNESS[theme] ?? MAP_LIGHTNESS.dark;
  return oklchToHex([(lo + hi) / 2, 0.13, (hash % 12) * 30 + 15]);
}
