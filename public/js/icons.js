// Top-down aircraft silhouettes (nose up, 64×64 viewBox). Used for map
// markers, the "where is it" pointer, and as a fallback when there's no photo.

const PATHS = {
  narrowbody:
    'M32 3c2 0 3 3 3 7v15l25 13v3l-25-6v15l8 6v3l-8-1.5-1.5 3.5h-3l-1.5-3.5-8 1.5v-3l8-6V35L4 41v-3l25-13V10c0-4 1-7 3-7z' +
    'M13.5 29h3.5v7h-3.5zM47 29h3.5v7H47z',
  widebody:
    'M32 2c2.5 0 3.5 3 3.5 8v14l26.5 15v3.5l-26.5-7v16l9 6.5v3l-9-2-2 4h-3l-2-4-9 2v-3l9-6.5v-16L2 42.5V39l26.5-15V10c0-5 1-8 3.5-8z' +
    'M11.5 31.5h4.5v8h-4.5zM48 31.5h4.5v8H48z',
  heavy4:
    'M32 2c2.5 0 3.5 3 3.5 8v14l26.5 15v3.5l-26.5-7v16l9 6.5v3l-9-2-2 4h-3l-2-4-9 2v-3l9-6.5v-16L2 42.5V39l26.5-15V10c0-5 1-8 3.5-8z' +
    'M8 34h3.5v7H8zM18 28.5h3.5v7H18zM42.5 28.5H46v7h-3.5zM52.5 34H56v7h-3.5z',
  regional:
    'M32 4c1.8 0 2.8 3 2.8 7V54l-1 5h-3.6l-1-5V11c0-4 1-7 2.8-7z' +
    'M33 26l23 11v3l-23-5zM31 26 8 37v3l23-5z' +
    'M36.2 41h4v10h-4zM23.8 41h4v10h-4zM34 44.5h2.5v3H34zM27.5 44.5H30v3h-2.5z' +
    'M31 55l-11 3.5V61l12-1.5L44 61v-2.5L33 55z',
  bizjet:
    'M32 8c1.6 0 2.5 3 2.5 6.5V53l-.9 4.5h-3.2l-.9-4.5V14.5C29.5 11 30.4 8 32 8z' +
    'M33 29l18 9v3l-18-4zM31 29l-18 9v3l18-4z' +
    'M35.8 41h3.4v8h-3.4zM24.8 41h3.4v8h-3.4zM34 43.5h2V46h-2zM28 43.5h2V46h-2z' +
    'M31 53.5l-8.5 3V59l9.5-1.2 9.5 1.2v-2.5L33 53.5z',
  turboprop:
    'M32 5c1.8 0 2.8 3 2.8 7v14h26v5h-26v19l8 2v3h-8l-1 3h-3.6l-1-3h-8v-3l8-2V31h-26v-5h26V12c0-4 1-7 2.8-7z' +
    'M15 20h4v13h-4zM45 20h4v13h-4zM11 19.5h12v1.4H11zM41 19.5h12v1.4H41z',
  light:
    'M32 8c1.6 0 2.5 2 2.5 5v10h25v5h-25v19l7 1.5v3l-7 .5-1 3h-3l-1-3-7-.5v-3l7-1.5V28h-25v-5h25V13c0-3 .9-5 2.5-5z' +
    'M25 6h14v1.6H25z',
  helicopter:
    'M32 14c4 0 6 3.5 6 8.5s-2 9.5-4.5 10.5V52h4v3h-4v4h-3V33c-2.5-1-4.5-5.5-4.5-10.5S28 14 32 14z' +
    'M10 8.5 54 34.5l-1.3 2.2L8.7 10.7zM54 8.5 10 34.5l1.3 2.2 44-26z',
  fighter:
    'M32 2c1.5 0 2.5 4 2.5 10v11l22 18v4l-22-6v11l7 5v3l-8-1.5-1.5 2.5h-0l-1.5-2.5-8 1.5v-3l7-5V39l-22 6v-4l22-18V12c0-6 1-10 2.5-10z',
  glider: 'M32 12c1.2 0 1.8 2 1.8 5v6l29 2.5v3l-29-1V55l7 1v2.5H25.2V56l7-1V27.5l-29 1v-3l29-2.5v-6c0-3 .6-5 1.8-5z',
  balloon: 'M32 6c11 0 18 8 18 18 0 9-7 16-13 20l-2 6h-6l-2-6c-6-4-13-11-13-20 0-10 7-18 18-18zM28 52h8v7h-8z',
};

export const CATEGORIES = Object.keys(PATHS);

export function silhouettePath(category) {
  return PATHS[category] ?? PATHS.narrowbody;
}

/** SVG <path> elements for a silhouette (one per sub-shape so overlaps never cut holes). */
export function silhouettePaths(category) {
  return silhouettePath(category)
    .split(/(?=M)/)
    .map((d) => `<path d="${d}"/>`)
    .join('');
}

/** Inline SVG markup for a silhouette. */
export function silhouetteSvg(category, { className = '' } = {}) {
  return `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true">${silhouettePaths(category)}</svg>`;
}
