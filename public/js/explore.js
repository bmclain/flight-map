// Traffic → Explore: slice everything logged by any dimension, over a range of
// days, with filters that scope every chart below them. Server side:
// /api/traffic/explore (server/traffic-explore.js). State lives in the address
// (#explore?range=30&group=type&f.airline=WJA) so a view can be bookmarked.
import { DIMENSIONS, dimLabel } from '/shared/traffic-dims.js';
import { formatAltitude, formatDistance, joinUnit } from '/shared/units.js';
import { columns, esc, fmt, hideTip, hoverTip, widthOf } from './viz.js';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return keyOf(d);
};

// Clicking a bar filters to it and looks one level in.
const DRILL = {
  airline: 'type',
  who: 'airline',
  type: 'airline',
  manufacturer: 'type',
  kind: 'type',
  route: 'airline',
  origin: 'destination',
  destination: 'origin',
  hour: 'airline',
  weekday: 'hour',
  altitude: 'kind',
  distance: 'kind',
  speed: 'kind',
  overhead: 'kind',
  source: 'kind',
};
const GROUP_ORDER = [
  'airline',
  'who',
  'type',
  'manufacturer',
  'kind',
  'route',
  'origin',
  'destination',
  'hour',
  'weekday',
  'altitude',
  'distance',
  'speed',
  'overhead',
  'source',
];

// Sequential blue (light → dark) for the hour × weekday grid; on a dark
// surface the near-zero end is the dark one, so it recedes.
const BLUES = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
];
const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

let units = 'imperial';
let clock24h = false;
let state = { range: '7', group: 'airline', measure: 'flights', q: '', filters: {} };
const filterLabels = new Map(); // "dim:key" → label, for the chips
let last = null;
let loadSeq = 0;
let logRows = 50; // flights listed; "Show more" adds 50

const ctx = () => ({ units, clock24h });

// ---- address <-> state -------------------------------------------------------------------

function readHash() {
  const [view, query = ''] = location.hash.slice(1).split('?');
  if (view !== 'explore') return false;
  const p = new URLSearchParams(query);
  state = {
    range: p.get('range') ?? '7',
    group: DIMENSIONS[p.get('group')] ? p.get('group') : 'airline',
    measure: p.get('measure') === 'aircraft' ? 'aircraft' : 'flights',
    q: p.get('q') ?? '',
    filters: {},
  };
  for (const [k, v] of p) {
    if (k.startsWith('f.') && DIMENSIONS[k.slice(2)]) state.filters[k.slice(2)] = v.split(',');
    if (k.startsWith('l.')) filterLabels.set(k.slice(2), v);
  }
  return true;
}

function writeHash() {
  const p = new URLSearchParams({ range: state.range, group: state.group, measure: state.measure });
  if (state.q) p.set('q', state.q);
  for (const [d, keys] of Object.entries(state.filters)) {
    if (!keys.length) continue;
    p.set(`f.${d}`, keys.join(','));
    for (const k of keys) {
      const label = filterLabels.get(`${d}:${k}`);
      if (label) p.set(`l.${d}:${k}`, label);
    }
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#explore?${p}`);
}

function rangeDates() {
  switch (state.range) {
    case 'today':
      return { from: daysAgo(0), to: daysAgo(0) };
    case 'yesterday':
      return { from: daysAgo(1), to: daysAgo(1) };
    default:
      return { from: daysAgo(Number(state.range) - 1), to: daysAgo(0) };
  }
}

// ---- view switching (One day / Explore) ---------------------------------------------------

function showView(name) {
  for (const b of document.querySelectorAll('.page-tabs [data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
    b.tabIndex = b.dataset.tab === name ? 0 : -1;
  }
  for (const s of document.querySelectorAll('main [data-tab]')) s.hidden = s.dataset.tab !== name;
  hideTip();
  if (name === 'explore') {
    writeHash();
    load();
  } else {
    if (location.hash.startsWith('#explore')) history.replaceState(null, '', `${location.pathname}${location.search}`);
    // The day view's charts may have been drawn while hidden: let them measure again.
    window.dispatchEvent(new Event('resize'));
  }
}

document.querySelector('.page-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showView(b.dataset.tab);
});

// ---- controls ----------------------------------------------------------------------------

function renderControls() {
  for (const b of $('ex-range').children) b.setAttribute('aria-checked', String(b.dataset.v === state.range));
  for (const b of $('ex-measure').children) b.setAttribute('aria-checked', String(b.dataset.v === state.measure));
  $('ex-group').value = state.group;
  if (document.activeElement !== $('ex-q')) $('ex-q').value = state.q;
  const chips = Object.entries(state.filters).flatMap(([d, keys]) =>
    keys.map((k) => {
      const label = filterLabels.get(`${d}:${k}`) ?? dimLabel(d, k, ctx());
      return `<button type="button" class="chip" data-d="${esc(d)}" data-k="${esc(k)}" aria-label="Remove filter ${esc(DIMENSIONS[d].name)}: ${esc(label)}"><span class="muted">${esc(DIMENSIONS[d].name)}:</span> ${esc(label)} <span aria-hidden="true">×</span></button>`;
    }),
  );
  $('ex-chips').innerHTML = chips.length
    ? `${chips.join('')}<button type="button" class="chip clear" data-clear="1">Clear all</button>`
    : '<span class="muted small">No filters: click any bar below to narrow things down.</span>';
}

$('ex-group').innerHTML = GROUP_ORDER.map((d) => `<option value="${d}">${esc(DIMENSIONS[d].name)}</option>`).join('');

const set = (patch) => {
  Object.assign(state, patch);
  logRows = 50;
  writeHash();
  load();
};
$('ex-range').addEventListener('click', (e) => e.target.dataset.v && set({ range: e.target.dataset.v }));
$('ex-measure').addEventListener('click', (e) => e.target.dataset.v && set({ measure: e.target.dataset.v }));
$('ex-group').addEventListener('change', (e) => set({ group: e.target.value }));
let qTimer = null;
$('ex-q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => set({ q: e.target.value.trim() }), 300);
});
$('ex-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if (chip.dataset.clear) return set({ filters: {} });
  const { d, k } = chip.dataset;
  const keys = (state.filters[d] ?? []).filter((x) => x !== k);
  const filters = { ...state.filters };
  if (keys.length) filters[d] = keys;
  else delete filters[d];
  set({ filters });
});

/** Click on a group: keep only it, and look inside by the next dimension. */
function drill(dim, key, label) {
  filterLabels.set(`${dim}:${key}`, label);
  const keys = new Set(state.filters[dim] ?? []);
  keys.add(key);
  const next = DRILL[dim];
  set({ filters: { ...state.filters, [dim]: [...keys] }, group: next && !state.filters[next] ? next : state.group });
}

// ---- charts ------------------------------------------------------------------------------

const value = (r) => (state.measure === 'aircraft' ? r.aircraft : r.flights);
const measureWord = () => (state.measure === 'aircraft' ? 'aircraft' : 'flights');

function renderTiles(r) {
  const t = r.totals;
  const share = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '–');
  const tiles = [
    ['Flights', fmt(t.flights), r.totals.ofAll !== t.flights ? `of ${fmt(t.ofAll)} in these days` : 'in these days'],
    ['Different aircraft', fmt(t.aircraft), t.aircraft ? `${fmt(t.flights / t.aircraft, 1)} flights each` : ''],
    ['Airlines', fmt(t.airlines), ''],
    ['Aircraft types', fmt(t.types), ''],
    ['Within card range', share(t.withinCardRange, t.flights), `${fmt(t.withinCardRange)} flights`],
    [
      'Heard by your antenna',
      t.antenna == null ? '–' : share(t.antenna, t.withSource),
      t.antenna == null ? 'not recorded for these days' : `${fmt(t.antenna)} of ${fmt(t.withSource)}`,
    ],
  ];
  $('ex-tiles').innerHTML = tiles
    .map(
      ([k, v, s]) =>
        `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`,
    )
    .join('');
}

/** Ranked horizontal bars (one series), value and share at the tip, click to drill. */
function rankedBars(box, rows, total, other) {
  const W = widthOf(box);
  const rowH = 28;
  const labelW = Math.min(230, Math.round(W * 0.36));
  const right = 92;
  const max = Math.max(1, ...rows.map(value));
  const H = rows.length * rowH + 4;
  const x0 = labelW + 8;
  const len = (v) => ((W - x0 - right) * v) / max;
  const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const chars = Math.max(8, Math.floor(labelW / 7));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(DIMENSIONS[state.group].name)}">`;
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = len(value(r));
    svg += `<text class="ink2" x="${labelW}" y="${y + 14}" text-anchor="end">${esc(trim(r.label, chars))}</text>`;
    if (w >= 4) {
      svg += `<path class="bar" d="M${x0},${y + 3} h${w - 4} a4,4 0 0 1 4,4 v8 a4,4 0 0 1 -4,4 h${-(w - 4)} z"/>`;
    }
    const pct = total ? Math.round((100 * value(r)) / total) : 0;
    svg += `<text class="ink" x="${x0 + Math.max(0, w) + 6}" y="${y + 14}">${fmt(value(r))}</text><text x="${x0 + Math.max(0, w) + 6 + String(fmt(value(r))).length * 7 + 6}" y="${y + 14}">${pct}%</text>`;
    svg += `<rect class="hit" data-i="${i}" x="0" y="${y}" width="${W}" height="${rowH}" tabindex="0"/>`;
  });
  svg += '</svg>';
  box.innerHTML =
    svg +
    (other
      ? `<p class="muted small">And ${fmt(other.groups)} more with ${fmt(state.measure === 'aircraft' ? other.aircraft : other.flights)} ${measureWord()} between them.</p>`
      : '');
  for (const el of box.querySelectorAll('.hit')) {
    const r = rows[el.dataset.i];
    hoverTip(
      el,
      [
        { value: fmt(r.flights), label: 'flights' },
        { value: fmt(r.aircraft), label: 'different aircraft' },
      ],
      r.label,
    );
    const go = () => drill(state.group, r.key, r.label);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    el.style.cursor = 'pointer';
  }
}

function renderGroups(r) {
  const dim = DIMENSIONS[state.group];
  $('ex-group-title').textContent =
    `${measureWord()[0].toUpperCase()}${measureWord().slice(1)} by ${dim.name.toLowerCase()}`;
  const box = $('ex-groups');
  // Ordered scales read best as columns in their own order; the rest ranked.
  const rows = r.groups.map((g) => ({ ...g, label: dim.ordered ? dimLabel(state.group, g.key, ctx()) : g.label }));
  if (!rows.some((g) => value(g) > 0)) {
    box.innerHTML = '<p class="empty">Nothing matches.</p>';
    return;
  }
  if (dim.ordered && state.group !== 'overhead') {
    const every = state.group === 'hour' ? 3 : 1;
    columns(
      box,
      rows.map((g) => ({
        value: value(g),
        label: g.label,
        tip: [
          { value: fmt(g.flights), label: 'flights' },
          { value: fmt(g.aircraft), label: 'different aircraft' },
        ],
      })),
      { height: 220, tickEvery: every },
    );
    box.querySelectorAll('.hit').forEach((el) => {
      const g = rows[el.dataset.i];
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => drill(state.group, g.key, g.label));
    });
  } else {
    rankedBars(box, rows, r.total, r.other);
  }
}

function renderTrend(r) {
  const byDay = r.trend.unit === 'day';
  $('ex-trend-title').textContent = byDay
    ? `${measureWord()[0].toUpperCase()}${measureWord().slice(1)} per day`
    : `${measureWord()[0].toUpperCase()}${measureWord().slice(1)} per hour`;
  const pts = r.trend.points.map((p) => {
    const label = byDay
      ? new Date(`${p.key}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : dimLabel('hour', p.key, ctx());
    return {
      value: value(p),
      label,
      tip: [
        { value: fmt(p.flights), label: 'flights' },
        { value: fmt(p.aircraft), label: 'different aircraft' },
      ],
    };
  });
  if (!pts.some((p) => p.value)) {
    $('ex-trend').innerHTML = '<p class="empty">Nothing matches.</p>';
    return;
  }
  columns($('ex-trend'), pts, { height: 180, tickEvery: byDay ? Math.ceil(pts.length / 7) : 3 });
}

function renderHeat(r) {
  const box = $('ex-heat');
  const max = Math.max(0, ...r.heat.flat());
  if (!max) {
    box.innerHTML = '<p class="empty">Nothing matches.</p>';
    return;
  }
  const W = widthOf(box);
  const left = 40;
  const top = 4;
  const cw = (W - left - 4) / 24;
  const ch = Math.max(14, Math.min(26, cw));
  const H = top + ch * 7 + 34;
  const ramp = dark() ? [...BLUES].reverse() : BLUES;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Flights by weekday and hour">`;
  r.heat.forEach((row, d) => {
    svg += `<text class="ink2" x="${left - 6}" y="${top + ch * d + ch / 2 + 4}" text-anchor="end">${days[d]}</text>`;
    row.forEach((n, h) => {
      const fill = n ? ramp[Math.min(ramp.length - 1, Math.floor((n / max) * (ramp.length - 1) + 0.5))] : 'var(--grid)';
      svg += `<rect x="${left + h * cw + 1}" y="${top + d * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="2" fill="${fill}" class="cell" data-d="${d}" data-h="${h}" tabindex="0"/>`;
    });
  });
  for (let h = 0; h < 24; h += 3) {
    svg += `<text x="${left + h * cw + cw / 2}" y="${top + ch * 7 + 14}" text-anchor="middle">${esc(dimLabel('hour', String(h), ctx()))}</text>`;
  }
  // Scale: fewer → more.
  const lx = W - 170;
  const ly = top + ch * 7 + 22;
  svg += `<text x="${lx - 6}" y="${ly + 8}" text-anchor="end">fewer</text>`;
  ramp.forEach((c, i) => {
    svg += `<rect x="${lx + i * 10}" y="${ly}" width="10" height="10" fill="${c}"/>`;
  });
  svg += `<text x="${lx + ramp.length * 10 + 6}" y="${ly + 8}">more (${fmt(max)})</text>`;
  svg += '</svg>';
  box.innerHTML = svg;
  for (const el of box.querySelectorAll('.cell')) {
    const d = Number(el.dataset.d);
    const h = Number(el.dataset.h);
    hoverTip(
      el,
      [{ value: fmt(r.heat[d][h]), label: 'flights' }],
      `${['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][d]}, ${dimLabel('hour', String(h), ctx())}`,
    );
  }
}

function renderSpread(box, dim, spread) {
  const pts = spread.counts.map((n, i) => ({
    value: n,
    label: dimLabel(dim, String(i), ctx()),
    tip: [{ value: fmt(n), label: 'flights' }],
  }));
  if (!pts.some((p) => p.value)) {
    box.innerHTML = '<p class="empty">Nothing matches.</p>';
    return;
  }
  columns(box, pts, { height: 170, tickEvery: 1 });
  // Short tick labels: the band's lower edge.
  const ticks = box.querySelectorAll('svg > text[text-anchor="middle"]');
  ticks.forEach((t, i) => {
    t.textContent = i === 0 ? '0' : pts[i].label.replace(/[–].*$/, '').replace(' and up', '+');
  });
  if (spread.unknown)
    box.insertAdjacentHTML('beforeend', `<p class="muted small">${fmt(spread.unknown)} without a reading.</p>`);
}

function renderLog(r) {
  $('ex-count').textContent =
    r.totals.flights > r.flightsShown
      ? `latest ${fmt(r.flightsShown)} of ${fmt(r.totals.flights)}`
      : `${fmt(r.totals.flights)}`;
  const when = (t) =>
    new Date(t).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: !clock24h,
    });
  const head =
    '<thead><tr><th>Seen</th><th>Flight</th><th>Type</th><th>Airline</th><th>Route</th><th class="num">Closest</th><th class="num">Height</th><th>Seen by</th></tr></thead>';
  const rows = r.flights
    .slice(0, logRows)
    .map(
      (f) =>
        `<tr><td>${esc(when(f.first))}</td><td>${esc(f.flight || f.callsign || f.reg || f.hex.toUpperCase())}</td><td>${esc(f.typeName || f.type || '')}</td><td>${esc(f.airline || (f.special ? f.special : 'Private'))}</td><td>${esc(f.from && f.to ? `${f.from} → ${f.to}` : '')}</td><td class="num">${f.minKm == null ? '' : esc(joinUnit(formatDistance(f.minKm, units)))}</td><td class="num">${f.altFt == null ? '' : esc(joinUnit(formatAltitude(f.altFt, units)))}</td><td>${f.source === 'antenna' ? 'Your antenna' : f.source === 'online' ? 'Online feed' : ''}</td></tr>`,
    )
    .join('');
  $('ex-log').innerHTML =
    `${head}<tbody>${rows || '<tr><td colspan="8" class="muted">Nothing matches.</td></tr>'}</tbody>`;
  const more = r.flights.length - logRows;
  $('ex-more').innerHTML =
    more > 0
      ? `<button type="button" class="btn ghost" id="ex-more-btn">Show ${fmt(Math.min(50, more))} more</button>`
      : '';
  $('ex-more-btn')?.addEventListener('click', () => {
    logRows += 50;
    renderLog(r);
  });
}

function render(r) {
  renderControls();
  renderTiles(r);
  renderGroups(r);
  renderTrend(r);
  renderHeat(r);
  renderSpread($('ex-alt'), 'altitude', r.altitude);
  renderSpread($('ex-dist'), 'distance', r.distance);
  renderLog(r);
}

async function load() {
  renderControls();
  const seq = ++loadSeq;
  const { from, to } = rangeDates();
  const p = new URLSearchParams({ from, to, group: state.group, measure: state.measure });
  if (state.q) p.set('q', state.q);
  for (const [d, keys] of Object.entries(state.filters)) if (keys.length) p.set(`f.${d}`, keys.join(','));
  // Keep the previous charts on screen, dimmed, while the new ones load.
  for (const s of document.querySelectorAll('main [data-tab="explore"]')) s.setAttribute('aria-busy', 'true');
  try {
    const r = await (await fetch(`/api/traffic/explore?${p}`)).json();
    if (seq !== loadSeq) return;
    if (r.error) throw new Error(r.error);
    last = r;
    render(r);
  } catch (err) {
    $('ex-groups').innerHTML = `<p class="empty">Couldn't load: ${esc(err.message)}</p>`;
  } finally {
    if (seq === loadSeq)
      for (const s of document.querySelectorAll('main [data-tab="explore"]')) s.setAttribute('aria-busy', 'false');
  }
}

let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (!last || window.innerWidth === lastWidth || $('ex-controls').hidden) return;
  lastWidth = window.innerWidth;
  render(last);
});

async function init() {
  try {
    const { config } = await (await fetch('/api/config')).json();
    units = config.display.units;
    clock24h = config.display.clock24h;
  } catch {
    // Defaults.
  }
  showView(readHash() ? 'explore' : 'day');
}
init();
