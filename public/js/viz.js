// Shared chart helpers: one tooltip for the page (values lead, labels follow,
// built with textContent), number formatting, and reading chart colours.

export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** 1234.5 → "1,234.5" (up to `d` decimals); '–' for nothing. */
export const fmt = (v, d = 0) =>
  v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('en-US', { maximumFractionDigits: d });

/** A real minus sign: "−30.9". */
export const minus = (s) => String(s).replace(/^-/, '−');

/** "$0.0042", "$1.25": small amounts keep enough digits to mean something. */
export const usd = (v) =>
  v == null ? '–' : `$${v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v > 0 ? v.toFixed(4) : '0.00'}`;

function tipEl() {
  let t = document.getElementById('tooltip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'tooltip';
    t.className = 'tooltip';
    t.setAttribute('role', 'status');
    t.hidden = true;
    document.body.append(t);
  }
  return t;
}

/** rows: [{ value, label, key? }]; key is a colour for a short line key. */
export function showTip(x, y, rows, title) {
  const tip = tipEl();
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
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 14))}px`;
  tip.style.top = `${Math.max(8, y - h - 12)}px`;
}

export function hideTip() {
  const t = document.getElementById('tooltip');
  if (t) t.hidden = true;
}

/** A chart colour role (--series-1…) as the element sees it. */
export const cssVar = (el, name) => getComputedStyle(el).getPropertyValue(name).trim();

/** Draw at the size it's shown, so text is its real size on a phone too. */
export const widthOf = (box, min = 280) => Math.max(min, Math.round(box.clientWidth || 520));

/** Wire a mark's hover and keyboard focus to a tooltip. */
export function hoverTip(el, rows, title) {
  const show = (e) => {
    const r = el.getBoundingClientRect();
    showTip(e.clientX ?? r.left + r.width / 2, e.clientY ?? r.top, typeof rows === 'function' ? rows() : rows, title);
  };
  el.addEventListener('pointermove', show);
  el.addEventListener('focus', show);
  el.addEventListener('pointerleave', hideTip);
  el.addEventListener('blur', hideTip);
}

/** A tidy step for an axis covering `span`, about four ticks. */
export function niceStep(span, ticks = 4) {
  const raw = span / ticks;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? raw;
}

/**
 * Columns (one series), 4px rounded at the top, square at the baseline, with
 * a tooltip on each. points: [{ value, label, tip? }].
 */
export function columns(box, points, { height = 120, valueText = (v) => fmt(v), tickEvery = 0, axis = true } = {}) {
  const W = widthOf(box, 200);
  const m = { l: axis ? 36 : 4, r: 4, t: 8, b: tickEvery ? 20 : 6 };
  const max = Math.max(...points.map((p) => p.value ?? 0));
  const step = niceStep(max || 1, 3);
  const top = Math.max(step, Math.ceil((max || 1) / step) * step);
  const y = (v) => m.t + (height - m.t - m.b) * (1 - v / top);
  const slot = (W - m.l - m.r) / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(24, slot - 2));
  let svg = `<svg viewBox="0 0 ${W} ${height}" role="img">`;
  if (axis) {
    for (let v = 0; v <= top + 1e-9; v += step) {
      svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${esc(valueText(v))}</text>`;
    }
  } else {
    svg += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  }
  points.forEach((p, i) => {
    const x = m.l + slot * i + (slot - bw) / 2;
    const h = y(0) - y(p.value ?? 0);
    if (h >= 1) {
      const r = Math.min(4, h, bw / 2);
      svg += `<path class="bar" d="M${x},${y(0)} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${bw - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z"/>`;
    }
    if (tickEvery && i % tickEvery === 0) {
      svg += `<text x="${x + bw / 2}" y="${height - 5}" text-anchor="middle">${esc(p.label)}</text>`;
    }
    svg += `<rect class="hit" data-i="${i}" x="${m.l + slot * i}" y="${m.t}" width="${slot}" height="${height - m.t - m.b}" tabindex="0"/>`;
  });
  svg += '</svg>';
  box.innerHTML = svg;
  for (const el of box.querySelectorAll('.hit')) {
    const p = points[el.dataset.i];
    hoverTip(el, p.tip ?? [{ value: valueText(p.value ?? 0), label: '' }], p.label);
  }
}
