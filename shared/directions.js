// Plain-language "where do I look?" phrasing.

/**
 * Describe a relative bearing (0 = straight ahead of the viewer) in words.
 * @param {number} rel degrees in (-180, 180]
 */
export function relativeDirectionText(rel) {
  const a = Math.abs(rel);
  if (a <= 22.5) return 'Straight ahead';
  if (a >= 157.5) return 'Behind you';
  const side = rel > 0 ? 'right' : 'left';
  if (a < 67.5) return `Ahead, to the ${side}`;
  if (a <= 112.5) return `To your ${side}`;
  return `Behind you, to the ${side}`;
}

/** Describe how high to look. */
export function elevationText(el) {
  if (el == null || !Number.isFinite(el)) return '';
  if (el < 0) return 'Below the horizon';
  if (el < 5) return 'Just above the horizon';
  if (el < 15) return 'Low in the sky';
  if (el < 35) return 'Partway up';
  if (el < 60) return 'High up';
  if (el < 80) return 'Very high up';
  return 'Almost overhead';
}

/** Climb / descent wording from a vertical rate in ft/min. */
export function verticalTrend(fpm) {
  if (fpm == null || !Number.isFinite(fpm)) return null;
  if (fpm > 300) return 'climbing';
  if (fpm < -300) return 'descending';
  return 'level';
}
