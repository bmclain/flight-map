// Settings → Receiver health: how well the ADS-B receiver on the Pi is doing.
// Data from /api/rf (server/rf.js), refreshed every 30 s while the tab is open;
// charts are plain SVG, drawn to the width they're shown at.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const fmt = (v, d = 0) =>
  v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-US', { maximumFractionDigits: d });
const minus = (s) => String(s).replace(/^-/, '−');

const VERDICT = {
  good: { icon: '✓', title: 'Receiver is working well' },
  fair: { icon: '!', title: 'Receiver needs attention' },
  poor: { icon: '✕', title: 'Receiver is performing poorly' },
  unknown: { icon: '?', title: 'Not enough to go on yet' },
};
const MARK = { ok: '✓', warn: '!', bad: '✕', info: 'i' };
const STATUS_WORD = { ok: 'Good', warn: 'Check', bad: 'Problem', info: 'Note' };

// ---- tooltip -----------------------------------------------------------------------------

const tip = $('tooltip');
/** rows: [{ value, label, key? }] — values lead, labels follow; built with textContent. */
function showTip(x, y, rows, title) {
  tip.replaceChildren();
  if (title) {
    const t = document.createElement('div');
    t.className = 'muted';
    t.textContent = title;
    tip.append(t);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    if (r.key) {
      const k = document.createElement('span');
      k.className = 'tk';
      k.style.background = r.key;
      row.append(k);
    }
    const v = document.createElement('span');
    v.className = 'tv';
    v.textContent = r.value;
    const l = document.createElement('span');
    l.className = 'muted';
    l.textContent = r.label ?? '';
    row.append(v, l);
    tip.append(row);
  }
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, y - h - 12)}px`;
}
const hideTip = () => {
  tip.hidden = true;
};
const cssVar = (name) => getComputedStyle($('rf')).getPropertyValue(name).trim();

// ---- verdict, checks, tiles ----------------------------------------------------------------

function renderVerdict(r) {
  const v = VERDICT[r.verdict] ?? VERDICT.unknown;
  const icon = $('verdict-icon');
  icon.className = `status-icon ${r.verdict}`;
  icon.textContent = v.icon;
  $('verdict-title').textContent = v.title;
  const n = r.numbers;
  $('verdict-sub').textContent =
    `${fmt(n.msgsPerSec, 1)} messages a second from ${fmt(n.aircraftWithPos)} aircraft · furthest ${fmt(n.maxRangeKm)} km · updated ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const order = { bad: 0, warn: 1, ok: 2, info: 3 };
  $('checks').innerHTML = [...r.checks]
    .sort((a, b) => order[a.status] - order[b.status])
    .map(
      (c) => `<li class="check"><span class="mark ${c.status}" aria-hidden="true">${MARK[c.status]}</span><div>
        <b><span class="label">${STATUS_WORD[c.status]}</span>${esc(c.title)}</b>
        <p>${esc(c.detail)}</p>${c.advice ? `<p class="advice">${esc(c.advice)}</p>` : ''}</div></li>`,
    )
    .join('');
}

function renderTiles(r) {
  const n = r.numbers;
  const tiles = [
    ['Messages', fmt(n.msgsPerSec, 1), 'a second', `${fmt(n.positionsPerMin)} positions a minute`],
    ['Furthest plane', fmt(n.maxRangeKm), 'km', 'in the last 15 minutes'],
    [
      'Signal above noise',
      fmt(n.snrDb, 1),
      'dB',
      `signal ${minus(fmt(n.signalDb, 1))}, noise ${minus(fmt(n.noiseDb, 1))} dBFS`,
    ],
    ['Strongest signal', minus(fmt(n.peakDb, 1)), 'dBFS', `${fmt(n.strongPct, 1)}% of messages near full scale`],
    ['Gain', fmt(n.gainDb, 1), 'dB', 'set by autogain'],
    ['Tuning error', fmt(n.ppm, 1), 'ppm', 'within ±2 is normal for this stick'],
    ['Failed decodes', fmt(n.badPct), '%', 'of message-like bursts'],
  ];
  $('tiles').innerHTML = tiles
    .map(
      ([k, v, u, s]) =>
        `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}<small>${esc(u)}</small></div><div class="s">${esc(s)}</div></div>`,
    )
    .join('');
  $('facts').innerHTML = [
    ['Gain', `${fmt(n.gainDb, 1)} dB (autogain)`],
    ['Frequency error', `${fmt(n.ppm, 1)} ppm`],
    ['Samples dropped', fmt(n.droppedSamples)],
    ['Compared with', r.merged ? 'adsb.lol, every 10 s' : 'nothing (online fill-in is off)'],
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  if (r.graphsUrl) {
    $('graphs-link').href = r.graphsUrl;
    $('graphs-link').hidden = false;
  }
}

// ---- coverage by distance: one series, horizontal bars, value at the tip ----------------

function renderCoverage(r) {
  const box = $('coverage');
  if (!r.merged) {
    box.innerHTML = `<p class="empty">Turn on <b>Also fill in the planes my antenna doesn't hear</b> in Settings → Aircraft data to compare with adsb.lol.</p>`;
    return;
  }
  const W = widthOf(box);
  const rowH = 34;
  const left = 78;
  const right = 120;
  const bands = r.coverage.bands;
  const H = bands.length * rowH + 22;
  const x = (p) => left + ((W - left - right) * p) / 100;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of planes heard by distance">`;
  for (const p of [0, 50, 100]) {
    svg += `<line class="gridline" x1="${x(p)}" x2="${x(p)}" y1="0" y2="${H - 18}"/><text x="${x(p)}" y="${H - 4}" text-anchor="middle">${p}%</text>`;
  }
  bands.forEach((b, i) => {
    const y = i * rowH + 8;
    const label = `${b.range[0]}–${b.range[1]} km`;
    svg += `<text class="ink2" x="${left - 10}" y="${y + 13}" text-anchor="end">${label}</text>`;
    if (!b.total) {
      svg += `<text x="${x(0) + 4}" y="${y + 13}">no planes there</text>`;
      return;
    }
    const w = x(b.pct) - x(0);
    // 18px bar, 4px rounded at the data end, square at the baseline; none at all for 0%.
    if (w >= 4)
      svg += `<path class="bar" d="M${x(0)},${y + 2} h${w - 4} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h${-(w - 4)} z"/>`;
    svg += `<text class="ink" x="${x(0) + w + 8}" y="${y + 15}">${b.pct}%</text><text x="${x(0) + w + 44}" y="${y + 15}">${b.heard} of ${b.total}</text>`;
    svg += `<rect class="hit" x="0" y="${y - 4}" width="${W}" height="${rowH}" data-i="${i}" tabindex="0"/>`;
  });
  svg += '</svg>';
  box.innerHTML = svg;
  for (const el of box.querySelectorAll('.hit')) {
    const b = bands[el.dataset.i];
    const show = (e) => {
      const rect = el.getBoundingClientRect();
      showTip(
        e.clientX ?? rect.left + rect.width / 2,
        e.clientY ?? rect.top,
        [
          { value: `${b.pct}%`, label: 'heard' },
          { value: `${b.heard} of ${b.total}`, label: 'sightings in the last hour' },
        ],
        `${b.range[0]}–${b.range[1]} km`,
      );
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerleave', hideTip);
    el.addEventListener('blur', hideTip);
  }
}

// ---- range by direction: polar plot -------------------------------------------------------

/** Draw at the size it's shown, so text is its real size on a phone too. */
const widthOf = (box) => Math.max(280, Math.round(box.clientWidth || 520));

function niceMax(km) {
  return Math.max(100, Math.ceil(km / 50) * 50);
}

function renderPolar(r) {
  const box = $('polar');
  // The furthest point in each 10° sector: the single-degree outline is mostly noise.
  const sectors = new Map();
  for (const [b, km] of r.outline ?? []) {
    const s = (Math.round(b / 10) * 10) % 360;
    sectors.set(s, Math.max(sectors.get(s) ?? 0, km));
  }
  const outline = [...sectors].sort((a, b) => a[0] - b[0]);
  const planes = r.planes ?? [];
  const maxKm = niceMax(Math.max(0, ...outline.map((p) => p[1]), ...planes.map((p) => p.km)));
  const R = 100;
  const pos = (bearing, km) => {
    const a = (bearing * Math.PI) / 180;
    const d = (km / maxKm) * R;
    return [d * Math.sin(a), -d * Math.cos(a)];
  };
  const step = maxKm > 300 ? 100 : 50;
  let svg = `<svg viewBox="-128 -118 256 236" role="img" aria-label="Range outline and planes by direction">`;
  for (let km = step; km <= maxKm; km += step) {
    const rr = (km / maxKm) * R;
    const [lx, ly] = pos(45, km);
    svg += `<circle class="gridline" cx="0" cy="0" r="${rr}" fill="none"/><text class="ring" x="${lx + 2}" y="${ly - 2}">${km} km</text>`;
  }
  svg += `<line class="gridline" x1="${-R}" x2="${R}" y1="0" y2="0"/><line class="gridline" x1="0" x2="0" y1="${-R}" y2="${R}"/>`;
  for (const [t, xx, yy] of [
    ['N', 0, -R - 6],
    ['E', R + 8, 3],
    ['S', 0, R + 12],
    ['W', -R - 8, 3],
  ]) {
    svg += `<text class="ink2 compass" x="${xx}" y="${yy}" text-anchor="middle">${t}</text>`;
  }
  if (outline.length > 2) {
    const d =
      outline
        .map(
          ([b, km], i) =>
            `${i ? 'L' : 'M'}${pos(b, km)
              .map((v) => v.toFixed(1))
              .join(',')}`,
        )
        .join('') + 'Z';
    svg += `<path class="wash" d="${d}"/><path class="line s1" d="${d}" stroke-width="1.5"/>`;
  }
  svg += `<circle class="you" cx="0" cy="0" r="2.5"/>`;
  planes.forEach((p, i) => {
    const [px, py] = pos(p.bearing, Math.min(p.km, maxKm));
    svg += `<circle class="dot${p.heard ? '' : ' missed'}" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.2"/>`;
    svg += `<circle class="hit" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" data-i="${i}" tabindex="0"/>`;
  });
  svg += '</svg>';
  box.innerHTML = svg;
  for (const el of box.querySelectorAll('.hit')) {
    const p = planes[el.dataset.i];
    const show = (e) => {
      const rect = el.getBoundingClientRect();
      showTip(
        e.clientX ?? rect.left,
        e.clientY ?? rect.top,
        [
          { value: `${fmt(p.km)} km`, label: compass(p.bearing) },
          { value: p.heard ? 'Heard' : 'Missed', label: p.heard ? 'by your antenna' : 'only the online feed has it' },
        ],
        p.label,
      );
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerleave', hideTip);
    el.addEventListener('blur', hideTip);
  }
}

const compass = (b) =>
  ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(b / 45) % 8];

// ---- signal vs distance: scatter with the noise floor --------------------------------------

function renderSignal(r) {
  const box = $('signal');
  const pts = r.signal ?? [];
  if (!pts.length) {
    box.innerHTML = '<p class="empty">No planes heard by the antenna in the last hour yet.</p>';
    return;
  }
  const W = widthOf(box);
  const H = 270;
  const m = { l: 44, r: 12, t: 22, b: 40 };
  const maxKm = niceMax(Math.max(...pts.map((p) => p[0])));
  const yMin = -40;
  const yMax = 0;
  const x = (km) => m.l + ((W - m.l - m.r) * km) / maxKm;
  const y = (db) => m.t + ((H - m.t - m.b) * (yMax - Math.max(yMin, Math.min(yMax, db)))) / (yMax - yMin);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Signal strength against distance">`;
  for (let db = yMin; db <= yMax; db += 10) {
    svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(db)}" y2="${y(db)}"/><text x="${m.l - 6}" y="${y(db) + 3}" text-anchor="end">${minus(db)}</text>`;
  }
  for (let km = 0; km <= maxKm; km += maxKm > 300 ? 100 : 50) {
    svg += `<text x="${x(km)}" y="${H - m.b + 16}" text-anchor="middle">${km}</text>`;
  }
  svg += `<text x="${(m.l + W - m.r) / 2}" y="${H - 2}" text-anchor="middle">distance (km)</text>`;
  svg += `<text x="${m.l - 34}" y="${m.t - 10}">signal (dBFS)</text>`;
  const noise = r.numbers.noiseDb;
  if (noise != null) {
    svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(noise)}" y2="${y(noise)}"/><text class="ink2" x="${W - m.r}" y="${y(noise) - 4}" text-anchor="end">noise floor ${minus(noise)}</text>`;
  }
  for (const [km, db] of pts) svg += `<circle class="dot" cx="${x(km).toFixed(1)}" cy="${y(db).toFixed(1)}" r="4"/>`;
  svg += `<circle class="hover" r="6" fill="none" visibility="hidden"/>`;
  svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>`;
  svg += '</svg>';
  box.innerHTML = svg;
  const el = box.querySelector('svg');
  const ring = el.querySelector('.hover');
  el.querySelector('.hit').addEventListener('pointermove', (e) => {
    // The nearest dot within 24 px, so the pointer only has to be close.
    const rect = el.getBoundingClientRect();
    const sx = rect.width / W;
    let best = null;
    for (const p of pts) {
      const d = Math.hypot(rect.left + x(p[0]) * sx - e.clientX, rect.top + y(p[1]) * sx - e.clientY);
      if (d < 24 && (!best || d < best.d)) best = { d, p };
    }
    if (!best) {
      ring.setAttribute('visibility', 'hidden');
      return hideTip();
    }
    ring.setAttribute('cx', x(best.p[0]));
    ring.setAttribute('cy', y(best.p[1]));
    ring.setAttribute('visibility', 'visible');
    showTip(e.clientX, e.clientY, [
      { value: `${minus(fmt(best.p[1], 1))} dBFS`, label: 'signal' },
      { value: `${fmt(best.p[0])} km`, label: 'away' },
    ]);
  });
  el.querySelector('.hit').addEventListener('pointerleave', () => {
    ring.setAttribute('visibility', 'hidden');
    hideTip();
  });
}

// ---- history: small multiples, one axis each, crosshair tooltip ---------------------------

const HISTORY = [
  { title: 'Messages per second', series: [{ key: 'msgsPerSec', cls: 's1', label: 'messages/s' }], unit: '' },
  {
    title: 'Planes heard within 250 km',
    series: [{ key: 'coveragePct', cls: 's1', label: 'heard' }],
    unit: '%',
    min: 0,
    max: 100,
  },
  { title: 'Furthest plane each minute', series: [{ key: 'maxRangeKm', cls: 's1', label: 'km' }], unit: ' km', min: 0 },
  {
    title: 'Signal and noise floor',
    series: [
      { key: 'signalDb', cls: 's1', label: 'average signal' },
      { key: 'noiseDb', cls: 's2', label: 'noise floor' },
    ],
    unit: ' dBFS',
  },
];

function niceStep(span) {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw;
}

function renderHistory(r) {
  const box = $('history');
  const h = r.history ?? [];
  if (h.length < 2) {
    box.innerHTML = '<p class="empty">History builds up a minute at a time; check back shortly.</p>';
    return;
  }
  box.innerHTML = HISTORY.map(
    (c, i) =>
      `<div><h3>${esc(c.title)}</h3>${
        c.series.length > 1
          ? `<div class="legend">${c.series.map((s) => `<span><i class="key line ${s.cls}"></i>${esc(s.label)}</span>`).join('')}</div>`
          : ''
      }<div class="chart" id="hist-${i}"></div></div>`,
  ).join('');
  HISTORY.forEach((c, i) => lineChart($(`hist-${i}`), h, c));
}

function lineChart(box, data, c) {
  const W = widthOf(box);
  const H = 170;
  const m = { l: 44, r: 12, t: 10, b: 24 };
  const values = data.flatMap((d) => c.series.map((s) => d[s.key])).filter((v) => v != null);
  if (!values.length) {
    box.innerHTML = `<p class="empty">${
      c.series[0].key === 'coveragePct' ? 'Needs the online fill-in to compare with.' : 'Nothing to show yet.'
    }</p>`;
    return;
  }
  let lo = c.min ?? Math.min(...values);
  let hi = c.max ?? Math.max(...values);
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = c.min ?? Math.floor(lo / step) * step;
  hi = c.max ?? Math.ceil(hi / step) * step;
  const t0 = data[0].t;
  const t1 = data[data.length - 1].t;
  const x = (t) => m.l + ((W - m.l - m.r) * (t - t0)) / Math.max(1, t1 - t0);
  const y = (v) => m.t + ((H - m.t - m.b) * (hi - v)) / (hi - lo);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)} over time">`;
  for (let v = lo; v <= hi + 1e-9; v += niceStep(hi - lo)) {
    svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${minus(fmt(v, 1))}</text>`;
  }
  // Time ticks every 6 hours (or hourly for a short history).
  const span = t1 - t0;
  const every = span > 12 * 3600_000 ? 6 * 3600_000 : span > 3 * 3600_000 ? 3600_000 : 15 * 60_000;
  for (let t = Math.ceil(t0 / every) * every; t <= t1; t += every) {
    svg += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: every < 3600_000 ? '2-digit' : undefined })}</text>`;
  }
  for (const s of c.series) {
    // Gaps (no reading) break the line rather than bridging it.
    let d = '';
    let pen = false;
    for (const p of data) {
      const v = p[s.key];
      if (v == null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    svg += `<path class="line ${s.cls}" d="${d}"/>`;
  }
  svg += `<line class="crosshair" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
  svg += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>`;
  svg += '</svg>';
  box.innerHTML = svg;
  const el = box.querySelector('svg');
  const hair = el.querySelector('.crosshair');
  const hit = el.querySelector('.hit');
  hit.addEventListener('pointermove', (e) => {
    const rect = el.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left) / (rect.width / W) - m.l) * (Math.max(1, t1 - t0) / (W - m.l - m.r));
    let p = data[0];
    for (const d of data) if (Math.abs(d.t - t) < Math.abs(p.t - t)) p = d;
    hair.setAttribute('x1', x(p.t));
    hair.setAttribute('x2', x(p.t));
    hair.setAttribute('visibility', 'visible');
    showTip(
      e.clientX,
      e.clientY,
      c.series.map((s) => ({
        value: p[s.key] == null ? 'no reading' : `${minus(fmt(p[s.key], 1))}${c.unit}`,
        label: s.label,
        key: cssVar(s.cls === 's1' ? '--series-1' : '--series-2'),
      })),
      new Date(p.t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    );
  });
  hit.addEventListener('pointerleave', () => {
    hair.setAttribute('visibility', 'hidden');
    hideTip();
  });
}

// ---- load ----------------------------------------------------------------------------------

let last = null;

function renderCharts(r) {
  renderCoverage(r);
  renderPolar(r);
  renderSignal(r);
  renderHistory(r);
}

// Charts are drawn to fit: redraw them when the page changes width.
let lastWidth = window.innerWidth;
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => timer && last?.available && renderCharts(last), 150);
});

async function load() {
  $('rf').setAttribute('aria-busy', 'true');
  try {
    const r = await (await fetch('/api/rf')).json();
    last = r;
    if (!r.available) {
      $('verdict-icon').className = 'status-icon unknown';
      $('verdict-icon').textContent = '?';
      $('verdict-title').textContent = 'No receiver to check';
      $('verdict-sub').textContent = r.reason;
      return;
    }
    renderVerdict(r);
    renderTiles(r);
    renderCharts(r);
  } catch (err) {
    $('verdict-sub').textContent = `Couldn't load: ${err.message}`;
  } finally {
    $('rf').setAttribute('aria-busy', 'false');
  }
}

let timer = null;

/** The tab was opened: load now (charts need it visible to size themselves), then every 30 s. */
export function startRf() {
  if (timer) return;
  load();
  timer = setInterval(load, 30_000);
}

/** The tab was closed: stop asking. */
export function stopRf() {
  clearInterval(timer);
  timer = null;
  hideTip();
}
