// A hard spending limit for paid APIs (FlightAware, Anthropic): every request
// is booked here, and saved to disk, before it's sent, and refused unless it
// fits the monthly budget, today's even share of what's left of it, and a
// per-minute limit. A new month starts afresh.
import fs from 'node:fs/promises';
import path from 'node:path';

const monthKey = (t) => new Date(t).toISOString().slice(0, 7); // calendar month (UTC), as FlightAware and Anthropic bill
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const round6 = (v) => Math.round(v * 1e6) / 1e6;

function daysLeftInMonth(t) {
  const d = new Date(t);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return last - d.getUTCDate() + 1; // including today
}

/** Persistent record of what we've spent, and the gate every query goes through. */
export class SpendLedger {
  constructor({ file, log = console, name = 'ledger' }) {
    this.file = file;
    this.name = name;
    this.log = log;
    this.state = this.#fresh(Date.now());
  }

  #fresh(now) {
    return { month: monthKey(now), spent: 0, days: {}, calls: {}, recent: [], reported: null };
  }

  async load(now = Date.now()) {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (saved?.month) this.state = { ...this.#fresh(now), ...saved };
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`${this.name}: ledger unreadable (${err.message}); starting a new one`);
    }
    this.#roll(now);
  }

  /** New month: start again (FlightAware's free allowance renews monthly). */
  #roll(now) {
    if (this.state.month !== monthKey(now)) this.state = this.#fresh(now);
  }

  spentToday(now = Date.now()) {
    return this.state.days[dayKey(now)] ?? 0;
  }

  /** How much may still be spent this month and today. */
  allowance(budget, now = Date.now()) {
    this.#roll(now);
    const month = Math.max(0, budget - this.state.spent);
    const beforeToday = this.state.spent - this.spentToday(now);
    // Today's share: what was left this morning, split over the days left.
    const today = Math.max(0, (budget - beforeToday) / daysLeftInMonth(now) - this.spentToday(now));
    return { month: round6(month), today: round6(Math.min(today, month)) };
  }

  /**
   * Why a query costing `cost` can't be made now, or null if it can.
   * `retryAt` says when the per-minute limit frees up.
   */
  refusal(cost, { budget, perMinute }, now = Date.now()) {
    const left = this.allowance(budget, now);
    if (cost > left.month + 1e-9) return { reason: 'monthly budget used up' };
    if (cost > left.today + 1e-9) return { reason: "today's share of the budget used up" };
    this.state.recent = this.state.recent.filter((t) => now - t < 60_000);
    if (this.state.recent.length >= perMinute)
      return { reason: 'per-minute limit', retryAt: this.state.recent[0] + 60_000 };
    return null;
  }

  /** Book a query, and save, before it's sent. */
  async charge(endpoint, cost, now = Date.now()) {
    this.#roll(now);
    const s = this.state;
    s.spent = round6(s.spent + cost);
    s.days[dayKey(now)] = round6(this.spentToday(now) + cost);
    s.calls[endpoint] = (s.calls[endpoint] ?? 0) + 1;
    s.recent.push(now);
    await this.save();
  }

  /** Correct a booking once the real cost is known (e.g. from token counts). */
  async adjust(delta, now = Date.now()) {
    if (!delta) return;
    this.#roll(now);
    const s = this.state;
    s.spent = round6(Math.max(0, s.spent + delta));
    s.days[dayKey(now)] = round6(Math.max(0, this.spentToday(now) + delta));
    await this.save();
  }

  /** The provider's own figure for this month: go by it if it's higher than ours. */
  async reconcile(reportedCost, now = Date.now()) {
    this.#roll(now);
    const s = this.state;
    s.reported = { cost: reportedCost, at: now };
    if (reportedCost > s.spent + 1e-6) {
      const extra = reportedCost - s.spent;
      this.log.warn(
        `flightaware: FlightAware reports $${reportedCost.toFixed(3)} spent, more than our $${s.spent.toFixed(3)}; using theirs`,
      );
      s.spent = round6(reportedCost);
      s.days[dayKey(now)] = round6(this.spentToday(now) + extra);
    }
    await this.save();
  }

  /** Write to disk; saves run one after another so they can't trip over each other. */
  save() {
    if (!this.file) return Promise.resolve(); // in memory only
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state));
      await fs.rename(tmp, this.file);
    };
    this.saving = (this.saving ?? Promise.resolve()).catch(() => {}).then(write);
    return this.saving;
  }
}
