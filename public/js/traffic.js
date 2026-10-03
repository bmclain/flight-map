// Daily traffic page: what flew over on a given day, BirdNET-style tallies by
// aircraft type and airline across the hours of the day.
import { formatAltitude, formatDistance, formatSpeed, joinUnit } from '/shared/units.js';
import { SPECIAL_LABELS } from '/shared/special-kinds.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const nf = new Intl.NumberFormat();
const SVG = 'http://www.w3.org/2000/svg';
const REFRESH_MS = 60_000;
const TALLY_ROWS = 25;
const LOG_ROWS = 200;

const CATEGORY_NAMES = {
  light: 'Light aircraft',
  bizjet: 'Business jets',
  narrowbody: 'Narrow-body jets',
  widebody: 'Wide-body jets',
  heavy4: 'Four-engine jets',
  turboprop: 'Turboprops',
  helicopter: 'Helicopters',
  glider: 'Gliders',
  balloon: 'Balloons',
  fighter: 'Military fast jets',
};

let units = 'imperial';
let clock24h = false;
let data = null;
let date = null;
let tab = 'types';
let showAllTally = false;
let refreshTimer = null;

// ---- dates & times -----------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const parseKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
const shiftKey = (k, days) => {
  const d = parseKey(k);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayTitle = (k) =>
  k === todayKey()
    ? 'Today'
    : k === shiftKey(todayKey(), -1)
      ? 'Yesterday'
      : parseKey(k).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const longDate = (k) =>
  parseKey(k).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
const shortDate = (k) => parseKey(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function hourLabel(h, { compact = false } = {}) {
  if (clock24h) return compact ? String(h) : `${pad(h)}:00`;
  const suffix = h < 12 ? 'am' : 'pm';
  const n = h % 12 || 12;
  return compact ? `${n}${suffix[0]}` : `${n} ${suffix}`;
}
const hourRange = (h) => `${hourLabel(h)}–${hourLabel((h + 1) % 24)}`;
const timeOf = (t) =>
  new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !clock24h });

// ---- formatting ------------------------------------------------------------------

const dist = (km) => joinUnit(formatDistance(km, units));
const alt = (ft) => joinUnit(formatAltitude(ft, units));
const speed = (kt) => joinUnit(formatSpeed(kt, units));
const plural = (n, one, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;

function flightName(v) {
  return v.callsign || v.reg || v.hex.toUpperCase();
}
function flightDesc(v) {
  const bits = [];
  if (v.airline?.name && !v.callsign?.startsWith(v.reg ?? '\0')) bits.push(v.airline.name);
  if (v.typeName) bits.push(v.typeName);
  return bits.join(' · ');
}
const routeText = (v) => (v.from?.code && v.to?.code ? `${v.from.code} → ${v.to.code}` : '');

// ---- tooltip ------------------------------------------------------------------------

const tip = $('#tip');
function showTip(html, e) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const x = Math.min(window.innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2));
  const y = e.clientY - r.height - 14 < 8 ? e.clientY + 18 : e.clientY - r.height - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => (tip.hidden = true);
document.addEventListener('scroll', hideTip, { passive: true });

// ---- bar chart (single series) -----------------------------------------------------------

const el = (name, attrs = {}) => {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Rounded-top bar path anchored to the baseline. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

/**
 * items: [{ value, label, tip, dim?, onClick? }]. labelEvery: show every n-th x label.
 */
function barChart(container, items, { labelEvery = 1, emptyText = 'Nothing recorded yet' } = {}) {
  container.textContent = '';
  const W = Math.max(280, container.clientWidth);
  const H = 200;
  const m = { top: 10, right: 4, bottom: 22, left: 30 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const max = niceMax(Math.max(0, ...items.map((i) => i.value)));
  const y = (v) => m.top + plotH - (v / max) * plotH;

  const axis = el('g', { class: 'axis' });
  for (const t of [0, max / 2, max]) {
    if (t) axis.append(el('line', { class: 'gridline', x1: m.left, x2: W - m.right, y1: y(t), y2: y(t) }));
    const label = el('text', { x: m.left - 6, y: y(t) + 4, 'text-anchor': 'end' });
    label.textContent = nf.format(t);
    axis.append(label);
  }
  axis.append(el('line', { class: 'baseline', x1: m.left, x2: W - m.right, y1: y(0), y2: y(0) }));
  svg.append(axis);

  const slot = plotW / items.length;
  const gap = Math.max(2, Math.min(8, slot * 0.25));
  const bw = Math.max(2, slot - gap);
  items.forEach((it, i) => {
    const x = m.left + i * slot + gap / 2;
    const g = el('g', { class: 'col' });
    const hit = el('rect', {
      class: `hit${it.onClick ? ' link' : ''}`,
      x: m.left + i * slot,
      y: m.top,
      width: slot,
      height: plotH + m.bottom,
    });
    g.append(hit);
    g.append(el('path', { class: `bar${it.dim ? ' dim' : ''}`, d: barPath(x, y(it.value), bw, y(0) - y(it.value)) }));
    if (i % labelEvery === 0) {
      const t = el('text', { x: x + bw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' });
      t.textContent = it.label;
      t.setAttribute('fill', 'var(--muted)');
      t.setAttribute('font-size', '11');
      g.append(t);
    }
    g.addEventListener('pointermove', (e) => showTip(it.tip, e));
    g.addEventListener('pointerleave', hideTip);
    if (it.onClick) g.addEventListener('click', it.onClick);
    svg.append(g);
  });
  if (!items.some((i) => i.value)) {
    const t = el('text', { class: 'empty', x: m.left + plotW / 2, y: m.top + plotH / 2, 'text-anchor': 'middle' });
    t.textContent = emptyText;
    svg.append(t);
  }
  svg.setAttribute('aria-label', items.map((i) => `${i.label}: ${i.value}`).join(', '));
  container.append(svg);
}

// ---- sections ------------------------------------------------------------------------------

function renderHeader() {
  $('#day-title').textContent = dayTitle(date);
  $('#day-pick').value = date;
  $('#day-pick').max = todayKey();
  $('#next').disabled = date >= todayKey();
  $('#today').hidden = date === todayKey();
  document.title = `Look Up · ${dayTitle(date)}'s traffic`;
}

function renderSentence() {
  const s = data;
  const t = s.totals;
  if (!t.flights) {
    $('#sentence').textContent = s.isToday
      ? 'Nothing recorded yet today. The log fills in as aircraft come by.'
      : 'No traffic was recorded on this day.';
    return;
  }
  const parts = [
    `<strong>${plural(t.flights, 'flight')}</strong> by ${plural(t.aircraft, 'aircraft', 'aircraft')}${s.isToday ? ' so far' : ''}`,
  ];
  if (s.averageFlights) {
    const diff = Math.round(((t.flights - s.averageFlights) / s.averageFlights) * 100);
    if (!s.isToday && Math.abs(diff) >= 5)
      parts[0] += `, ${Math.abs(diff)}% ${diff > 0 ? 'busier' : 'quieter'} than usual`;
  }
  let text = `${parts[0]}.`;
  if (s.busiestHour) text += ` Busiest ${hourRange(s.busiestHour.hour)} with ${s.busiestHour.flights}.`;
  const topAirline = s.airlines[0];
  const topType = s.types[0];
  if (topAirline) text += ` Most seen airline: <strong>${esc(topAirline.label)}</strong> (${topAirline.count}).`;
  if (topType) text += ` Most common type: <strong>${esc(topType.label)}</strong> (${topType.count}).`;
  const c = s.notable.closest;
  if (c)
    text += ` Closest: ${esc(flightName(c))}${c.typeName ? `, a ${esc(c.typeName)},` : ''} at ${dist(c.minKm)}${c.altAtClosestFt != null ? ` and ${alt(c.altAtClosestFt)}` : ''}.`;
  if (s.notable.newTypes.length) text += ` ${plural(s.notable.newTypes.length, 'type')} not seen in the last month.`;
  $('#sentence').innerHTML = text;
}

function renderTiles() {
  const s = data;
  const t = s.totals;
  const tiles = [
    {
      k: 'Flights',
      v: nf.format(t.flights),
      d: s.averageFlights != null ? `30-day average ${nf.format(s.averageFlights)}` : '',
    },
    { k: 'Aircraft', v: nf.format(t.aircraft), d: 'different airframes' },
    { k: 'Overhead', v: nf.format(t.overhead), d: 'within the display range' },
    { k: 'Types', v: nf.format(t.types), d: s.notable.newTypes.length ? `${s.notable.newTypes.length} new` : '' },
    { k: 'Airlines', v: nf.format(t.airlines), d: '' },
    {
      k: 'Busiest hour',
      v: s.busiestHour ? hourLabel(s.busiestHour.hour) : '—',
      d: s.busiestHour ? plural(s.busiestHour.flights, 'flight') : '',
    },
  ];
  if (t.cargo) tiles.push({ k: 'Cargo', v: nf.format(t.cargo), d: 'freight flights' });
  if (t.military) tiles.push({ k: 'Military', v: nf.format(t.military), d: '' });
  $('#tiles').innerHTML = tiles
    .map(
      (x) =>
        `<div class="tile"><div class="v">${esc(x.v)}</div><div class="k">${esc(x.k)}</div>${x.d ? `<div class="d">${esc(x.d)}</div>` : ''}</div>`,
    )
    .join('');
}

function renderHourly() {
  const now = new Date();
  const items = data.hourly.map((n, h) => ({
    value: n,
    label: hourLabel(h, { compact: true }),
    dim: data.isToday && h > now.getHours(),
    tip: `<strong>${hourRange(h)}</strong><br>${plural(n, 'flight')}`,
  }));
  const narrow = $('#hourly').clientWidth < 600;
  barChart($('#hourly'), items, { labelEvery: narrow ? 3 : 1 });
}

function renderHistory() {
  const items = data.history.map((d) => ({
    value: d.flights,
    label: shortDate(d.date),
    dim: d.date !== date,
    tip: `<strong>${esc(longDate(d.date))}</strong><br>${plural(d.flights, 'flight')} · ${plural(d.aircraft, 'aircraft', 'aircraft')}`,
    onClick: () => go(d.date),
  }));
  barChart($('#history'), items, { labelEvery: 7, emptyText: 'History builds up day by day' });
}

function tallyRows() {
  if (tab === 'airlines') return data.airlines.map((r) => ({ ...r, sub: r.icao ?? '' }));
  if (tab === 'categories')
    return data.categories.map((r) => ({ ...r, label: CATEGORY_NAMES[r.key] ?? r.key, sub: '' }));
  const fresh = new Set(data.notable.newTypes.map((v) => v.type));
  return data.types.map((r) => ({ ...r, sub: r.code !== r.label ? r.code : '', isNew: fresh.has(r.code) }));
}

function renderTally() {
  for (const b of document.querySelectorAll('#tally-tabs button'))
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const rows = tallyRows();
  const table = $('#tally');
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td class="empty-note">Nothing recorded${data.isToday ? ' yet' : ''}.</td></tr></tbody>`;
    return;
  }
  const shown = showAllTally ? rows : rows.slice(0, TALLY_ROWS);
  const max = Math.max(1, ...shown.flatMap((r) => r.hourly));
  const level = (n) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor(((n - 1) / max) * 4)));
  const head = `<thead><tr><th>${tab === 'airlines' ? 'Airline' : tab === 'categories' ? 'Kind' : 'Type'}</th><th class="num">Total</th>${data.hourly
    .map((_, h) => `<th class="h">${h % 3 === 0 ? hourLabel(h, { compact: true }) : ''}</th>`)
    .join('')}</tr></thead>`;
  const body = shown
    .map(
      (r) =>
        `<tr><td class="name" title="${esc(r.label)}">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}${r.isNew ? '<span class="new-badge">new</span>' : ''}</td><td class="total">${nf.format(r.count)}</td>${r.hourly
          .map((n, h) => `<td class="c" data-l="${level(n)}" data-h="${h}" data-n="${n}">${n || ''}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  const more =
    rows.length > TALLY_ROWS
      ? `<tr class="more"><td colspan="26"><button type="button" class="btn ghost" id="tally-more">${showAllTally ? 'Show fewer' : `Show all ${rows.length}`}</button></td></tr>`
      : '';
  table.innerHTML = `${head}<tbody>${body}${more}</tbody>`;
  $('#tally-more')?.addEventListener('click', () => {
    showAllTally = !showAllTally;
    renderTally();
  });
}

$('#tally').addEventListener('pointerover', (e) => {
  const td = e.target.closest('td.c');
  if (!td) return hideTip();
  const name = td.parentElement.querySelector('.name').title;
  showTip(`<strong>${esc(name)}</strong><br>${hourRange(Number(td.dataset.h))}: ${td.dataset.n}`, e);
});
$('#tally').addEventListener('pointerleave', hideTip);

function rankedList(target, rows, { sub = () => '' } = {}) {
  if (!rows.length) {
    target.innerHTML = `<li class="empty-note">No routes known${data.isToday ? ' yet' : ''}.</li>`;
    return;
  }
  const max = rows[0].count;
  target.innerHTML = rows
    .map(
      (r) =>
        `<li><span>${esc(r.label)}<span class="sub">${esc(sub(r))}</span></span><span class="n">${nf.format(r.count)}</span><span class="track"><span style="width:${(r.count / max) * 100}%"></span></span></li>`,
    )
    .join('');
}

// ---- local airport ----------------------------------------------------------------------

const APT_ROWS = 12;
let aptSpan = 'day';
const total = (rows) => rows.reduce((n, r) => n + r.count, 0);

/** Airports as shares of `sum`: "Calgary YYC   42% 5". */
function shareList(target, rows, sum, emptyText) {
  if (!rows.length) {
    target.innerHTML = `<li class="empty-note">${esc(emptyText)}</li>`;
    return;
  }
  const items = rows.slice(0, APT_ROWS).map((r) => {
    const share = (r.count / sum) * 100;
    const code = r.label !== r.code ? `<span class="sub">${esc(r.code)}</span>` : '';
    return `<li><span>${esc(r.label)}${code}</span><span class="n">${Math.round(share)}%<span class="sub">${nf.format(r.count)}</span></span><span class="track"><span style="width:${share}%"></span></span></li>`;
  });
  if (rows.length > APT_ROWS) items.push(`<li class="empty-note">and ${rows.length - APT_ROWS} more</li>`);
  target.innerHTML = items.join('');
}

function renderAirport() {
  const a = data.airport;
  $('#apt-card').classList.toggle('off', !a);
  if (!a) {
    $('#apt-title').textContent = 'Local airport';
    $('#apt-help').innerHTML =
      'Set your local airport in <a href="/admin#traffic-settings">Settings</a> to see where its flights go and come from.';
    return;
  }
  const d = aptSpan === '30' ? data.airport30 : a;
  const city = a.city ?? data.airport30?.city;
  $('#apt-title').textContent = city ? `${city} airport (${a.code})` : `${a.code} airport`;
  $('#apt-help').textContent =
    `Flights seen lower than ${alt(a.maxHeightFt)} above the airport within ${dist(a.radiusKm)} of it, ` +
    'by where they were going or coming from.';
  const none = aptSpan === 'day' && data.isToday ? 'None yet today.' : 'None recorded.';
  for (const [key, id] of [
    ['departures', 'dep'],
    ['arrivals', 'arr'],
  ]) {
    const sum = total(d[key]);
    $(`#apt-${id}-n`).textContent = sum ? plural(sum, 'flight') : '';
    shareList($(`#apt-${id}`), d[key], sum, none);
  }

  const verb = { arrival: 'came down to', departure: 'climbed out from', low: 'flew low over' };
  $('#apt-unusual-wrap').hidden = !d.unusual.length;
  $('#apt-unusual').innerHTML = d.unusual
    .map((u) => {
      const at = u.airport.minAt ?? u.first;
      const when = aptSpan === '30' ? `${shortDate(u.date)}, ${timeOf(at)}` : timeOf(at);
      const lowest = `${alt(u.airport.minFt)} above ${a.code}`;
      const what = u.movement === 'departure' ? `${verb.departure} ${a.code}` : `${verb[u.movement]} ${lowest}`;
      const scheduled = u.from?.code && u.to?.code ? `scheduled ${u.from.code} → ${u.to.code}` : '';
      return `<li><strong>${esc(flightName(u))}</strong> ${esc(what)}<small>${esc(
        [flightDesc(u), scheduled, when].filter(Boolean).join(' · '),
      )}</small></li>`;
    })
    .join('');

  const u = d.unrouted;
  const others = u.departure + u.arrival + u.low;
  $('#apt-foot').textContent = others
    ? `Not counted above: ${plural(others, 'other low flight')} with no known route (private, training, medical and so on).`
    : '';
}

$('#apt-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-span]');
  if (!b || !data) return;
  aptSpan = b.dataset.span;
  for (const t of $('#apt-tabs').querySelectorAll('button')) t.setAttribute('aria-selected', String(t === b));
  renderAirport();
});

function notableItem(label, v, detail) {
  if (!v) return '';
  const desc = flightDesc(v);
  return `<dt>${esc(label)}</dt><dd><strong>${esc(flightName(v))}</strong> ${esc(detail)}<small>${esc(
    [desc, routeText(v), timeOf(v.closestAt ?? v.first)].filter(Boolean).join(' · '),
  )}</small></dd>`;
}

function renderNotable() {
  const n = data.notable;
  let html = '';
  html += notableItem(
    'Closest',
    n.closest,
    n.closest
      ? `${dist(n.closest.minKm)}${n.closest.altAtClosestFt != null ? ` away at ${alt(n.closest.altAtClosestFt)}` : ''}`
      : '',
  );
  html += notableItem('Highest', n.highest, n.highest ? alt(n.highest.maxAltFt) : '');
  html += notableItem('Fastest', n.fastest, n.fastest ? speed(n.fastest.maxGsKt) : '');
  html += notableItem('First', n.first, n.first ? timeOf(n.first.first) : '');
  if (!data.isToday) html += notableItem('Last', n.last, n.last ? timeOf(n.last.first) : '');
  if (n.newTypes.length) {
    html += `<dt>New types</dt><dd>${n.newTypes.map((v) => `<strong>${esc(v.typeName ?? v.type)}</strong> <small>${esc([flightName(v), timeOf(v.first)].join(' · '))}</small>`).join('')}</dd>`;
  }
  if (n.special?.length) {
    html += `<dt>Special</dt><dd>${n.special
      .map(
        (v) =>
          `<strong>${esc(v.special.name || flightName(v))}</strong> <span class="flag sp-${esc(v.special.kind)}">${esc(SPECIAL_LABELS[v.special.kind] ?? v.special.kind)}</span> <small>${esc([flightName(v), v.typeName, timeOf(v.first)].filter(Boolean).join(' · '))}</small>`,
      )
      .join('')}</dd>`;
  }
  if (n.emergencies.length) {
    html += `<dt>Emergency squawks</dt><dd>${n.emergencies.map((v) => `<strong>${esc(flightName(v))}</strong> squawked ${esc(v.squawk7x00)} <small>${esc(timeOf(v.first))}</small>`).join('')}</dd>`;
  }
  $('#notable').innerHTML = html || `<dt></dt><dd class="empty-note">Nothing yet.</dd>`;
}

function renderLog() {
  const q = $('#log-filter').value.trim().toLowerCase();
  const all = [...data.flights].reverse();
  const rows = q
    ? all.filter((v) =>
        [
          v.callsign,
          v.reg,
          v.hex,
          v.type,
          v.typeName,
          v.airline?.name,
          v.from?.code,
          v.to?.code,
          v.from?.city,
          v.to?.city,
          v.special?.name,
          SPECIAL_LABELS[v.special?.kind],
        ]
          .filter(Boolean)
          .some((s) => s.toLowerCase().includes(q)),
      )
    : all;
  $('#log-count').textContent = q ? `${nf.format(rows.length)} of ${nf.format(all.length)}` : nf.format(all.length);
  const head = `<thead><tr><th>Time</th><th>Flight</th><th>Type</th><th>Airline</th><th>Route</th><th class="num">Closest</th><th class="num">Altitude</th></tr></thead>`;
  const body = rows
    .slice(0, LOG_ROWS)
    .map((v) => {
      const flags = [
        v.squawk7x00 ? `<span class="flag alert">${esc(v.squawk7x00)}</span>` : '',
        v.special
          ? `<span class="flag sp-${esc(v.special.kind)}" title="${esc(v.special.name ?? '')}">${esc(SPECIAL_LABELS[v.special.kind] ?? v.special.kind)}</span>`
          : v.military
            ? '<span class="flag sp-military">Military</span>'
            : '',
        v.cargo ? '<span class="flag">cargo</span>' : '',
        v.ground ? '<span class="flag">ground</span>' : '',
      ].join('');
      const altRange =
        v.minAltFt != null
          ? v.maxAltFt - v.minAltFt > 2000
            ? `${alt(v.minAltFt)}–${alt(v.maxAltFt)}`
            : alt(v.maxAltFt)
          : '—';
      return `<tr><td>${esc(timeOf(v.first))}</td><td><strong>${esc(flightName(v))}</strong>${v.callsign && v.reg ? ` <span class="muted">${esc(v.reg)}</span>` : ''}${flags}</td><td>${esc(v.typeName ?? v.type ?? '')}</td><td>${esc(v.airline?.name ?? '')}</td><td>${esc(routeText(v))}</td><td class="num">${v.minKm != null ? dist(v.minKm) : '—'}</td><td class="num">${altRange}</td></tr>`;
    })
    .join('');
  const more =
    rows.length > LOG_ROWS
      ? `<tr><td colspan="7" class="muted">${nf.format(rows.length - LOG_ROWS)} more; use the filter to narrow it down.</td></tr>`
      : '';
  $('#log').innerHTML = rows.length
    ? `${head}<tbody>${body}${more}</tbody>`
    : `<tbody><tr><td class="empty-note">No flights${q ? ' match' : ''}.</td></tr></tbody>`;
}

function renderAll() {
  renderHeader();
  renderSentence();
  renderTiles();
  renderHourly();
  renderTally();
  renderAirport();
  renderNotable();
  renderHistory();
  rankedList($('#routes'), data.topRoutes, {
    sub: (r) => (r.from?.city && r.to?.city ? `${r.from.city} to ${r.to.city}` : ''),
  });
  rankedList($('#airports'), data.topAirports, { sub: (r) => (r.label !== r.code ? r.code : '') });
  renderLog();
}

// ---- loading -------------------------------------------------------------------------------

async function load() {
  clearTimeout(refreshTimer);
  const want = date;
  try {
    const res = await fetch(`/api/traffic?date=${want}`, { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    const body = await res.json();
    if (want !== date) return;
    data = body;
    renderAll();
  } catch (err) {
    $('#sentence').textContent = `Couldn't load traffic: ${err.message}`;
  }
  if (date === todayKey()) refreshTimer = setTimeout(load, REFRESH_MS);
}

function go(next) {
  if (!next || next > todayKey()) return;
  date = next;
  showAllTally = false;
  const url = new URL(location.href);
  if (date === todayKey()) url.searchParams.delete('date');
  else url.searchParams.set('date', date);
  history.replaceState(null, '', url);
  renderHeader();
  load();
}

$('#prev').addEventListener('click', () => go(shiftKey(date, -1)));
$('#next').addEventListener('click', () => go(shiftKey(date, 1)));
$('#today').addEventListener('click', () => go(todayKey()));
$('#day-pick').addEventListener('change', (e) => go(e.target.value));
$('#tally-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  showAllTally = false;
  renderTally();
});
$('#log-filter').addEventListener('input', () => data && renderLog());
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  if (e.key === 'ArrowLeft') go(shiftKey(date, -1));
  if (e.key === 'ArrowRight') go(shiftKey(date, 1));
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => data && (renderHourly(), renderHistory()), 150);
});

try {
  const { config } = await (await fetch('/api/config')).json();
  units = config.display.units;
  clock24h = config.display.clock24h;
} catch {
  /* defaults */
}
const fromUrl = new URLSearchParams(location.search).get('date');
date = /^\d{4}-\d{2}-\d{2}$/.test(fromUrl ?? '') && fromUrl <= todayKey() ? fromUrl : todayKey();
renderHeader();
load();
