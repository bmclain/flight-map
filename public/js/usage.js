// Settings → Overview → API usage: what Claude, FlightAware, adsb.lol and the
// other outside services have been used for. /api/usage, refreshed every
// minute while Overview is open.
import { columns, esc, fmt, usd } from './viz.js';

const $ = (id) => document.getElementById(id);
const shortDate = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const OTHER = {
  'adsb.im': 'adsb.im — routes',
  adsbdb: 'adsbdb — routes, airlines',
  planespotters: 'planespotters.net — photos',
  wikipedia: 'Wikipedia — type photos',
  databases: 'Aircraft & airport databases',
};

/** The monthly cap as a meter: the fill carries severity, the track is the same hue lighter. */
function meter(spent, budget) {
  if (!budget) return '<p class="muted small">No cap set (0): no paid requests are made.</p>';
  const pct = Math.min(100, (100 * spent) / budget);
  const level = pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'ok';
  return `<div class="meter ${level}" role="meter" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${spent}" aria-label="Spent this month">
    <span style="width:${pct.toFixed(1)}%"></span></div>
    <p class="meter-label"><b>${usd(spent)}</b> of ${usd(budget)} this month${
      level === 'ok' ? '' : level === 'warning' ? ' · getting close' : ' · nearly all used'
    }</p>`;
}

function panel({ id, title, status, headline, sub, body, chartTitle }) {
  return `<article class="usage-panel" id="${id}">
    <header><h3>${esc(title)}</h3><span class="pill-text ${status.cls}">${esc(status.text)}</span></header>
    <div class="usage-head">${headline}</div>
    ${sub ? `<p class="muted small">${sub}</p>` : ''}
    ${body ?? ''}
    <p class="chart-title">${esc(chartTitle)}</p>
    <div class="chart" id="${id}-chart"></div>
  </article>`;
}

const day = (svc, s) => s?.services?.[svc] ?? null;

function render(r) {
  const claude = r.anthropic;
  const fa = r.flightaware;
  const c = day('anthropic', r);
  const f = day('flightaware', r);
  const a = day('adsb.lol', r);
  const tokens = (n) => (n >= 1e6 ? `${fmt(n / 1e6, 2)}M` : n >= 1e3 ? `${fmt(n / 1e3, 1)}k` : fmt(n));

  $('usage').innerHTML = [
    panel({
      id: 'u-claude',
      title: 'Claude (ATC summaries)',
      status: claude.configured ? { cls: 'ok', text: claude.model } : { cls: 'off', text: 'No API key' },
      headline: meter(claude.spentThisMonthUsd ?? 0, claude.budgetUsd),
      sub: `Today ${usd(claude.spentTodayUsd)} · ${fmt(c?.today.requests ?? 0)} summaries · ${tokens(
        (c?.today.inputTokens ?? 0) + (c?.today.outputTokens ?? 0),
      )} tokens${c?.month ? ` · this month ${fmt(c.month.requests)} summaries, ${tokens(c.month.inputTokens)} in / ${tokens(c.month.outputTokens)} out` : ''}`,
      chartTitle: 'Spent per day, last 30 days',
    }),
    panel({
      id: 'u-fa',
      title: 'FlightAware',
      status: !fa.configured
        ? { cls: 'off', text: 'No API key' }
        : fa.active
          ? { cls: 'ok', text: 'In use' }
          : { cls: 'off', text: 'Not in use' },
      headline: meter(fa.spentThisMonthUsd ?? 0, fa.budgetUsd),
      sub: `Today ${usd(fa.spentTodayUsd)} (${usd(fa.leftTodayUsd)} left) · ${fmt(f?.today.requests ?? 0)} queries${
        fa.reported ? ` · FlightAware's own figure: ${usd(fa.reported.cost)}` : ''
      }${fa.lastRefusal && Date.now() - fa.lastRefusal.at < 3600_000 ? ` · holding back: ${esc(fa.lastRefusal.reason)}` : ''}`,
      chartTitle: 'Spent per day, last 30 days',
    }),
    panel({
      id: 'u-lol',
      title: 'adsb.lol',
      status:
        (a?.today.rateLimited ?? 0) > 0
          ? { cls: 'warn', text: `${fmt(a.today.rateLimited)} refused today` }
          : { cls: 'ok', text: 'Free · no key' },
      headline: `<p class="big">${fmt(a?.today.requests ?? 0)}<small> requests today</small></p>`,
      sub: `${r.adsbLol.liveFeedSeconds ? `Live feed every ${r.adsbLol.liveFeedSeconds} s` : 'Live feed off'}, plus flight paths for the mini map · ${fmt(
        a?.today.errors ?? 0,
      )} failed today · ${fmt(a?.month.requests ?? 0)} this month`,
      chartTitle: 'Requests per day, last 30 days',
    }),
  ].join('');

  const series = (svc, key) =>
    (day(svc, r)?.daily ?? []).map((d) => ({
      value: d[key],
      label: shortDate(d.date),
      tip:
        key === 'costUsd'
          ? [
              { value: usd(d.costUsd), label: 'spent' },
              { value: fmt(d.requests), label: svc === 'anthropic' ? 'summaries' : 'queries' },
            ]
          : [
              { value: fmt(d.requests), label: 'requests' },
              ...(d.rateLimited ? [{ value: fmt(d.rateLimited), label: 'refused (too many)' }] : []),
            ],
    }));
  const empty = (id, text) => ($(`${id}-chart`).innerHTML = `<p class="empty">${esc(text)}</p>`);
  const draw = (id, svc, key, valueText) => {
    const pts = series(svc, key);
    if (!pts.some((p) => p.value > 0)) return empty(id, 'Nothing used yet.');
    columns($(`${id}-chart`), pts, { height: 110, valueText, tickEvery: 7 });
  };
  draw('u-claude', 'anthropic', 'costUsd', usd);
  draw('u-fa', 'flightaware', 'costUsd', usd);
  draw('u-lol', 'adsb.lol', 'requests', (v) => fmt(v));

  const rows = Object.entries(OTHER)
    .map(([svc, name]) => [name, day(svc, r)])
    .filter(([, d]) => d);
  $('usage-other').innerHTML = rows.length
    ? `<table class="usage-table"><thead><tr><th>Service</th><th class="num">Today</th><th class="num">Failed today</th><th class="num">Last 30 days</th></tr></thead><tbody>${rows
        .map(
          ([name, d]) =>
            `<tr><td>${esc(name)}</td><td class="num">${fmt(d.today.requests)}</td><td class="num">${fmt(d.today.errors)}</td><td class="num">${fmt(
              d.daily.reduce((n, x) => n + x.requests, 0),
            )}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted small">Nothing yet.</p>';
}

let timer = null;
let last = null;

async function load() {
  try {
    last = await (await fetch('/api/usage')).json();
    render(last);
  } catch (err) {
    $('usage').innerHTML = `<p class="empty">Couldn't load usage: ${esc(err.message)}</p>`;
  }
}

let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (!timer || !last || window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  render(last);
});

/** Overview opened: load now and every minute. */
export function startUsage() {
  if (timer) return;
  load();
  timer = setInterval(load, 60_000);
}

export function stopUsage() {
  clearInterval(timer);
  timer = null;
}
