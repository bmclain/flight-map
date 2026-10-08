// One plain-English line about what an aircraft is doing on the radio, written
// by Claude from its recent transmissions and what we can see of the flight.
// Needs ANTHROPIC_API_KEY (or another Anthropic credential) in the environment;
// without it the rule-based line from phrases.js is used.
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { SpendLedger } from '../util/ledger.js';

export const SUMMARY_MODEL = 'claude-haiku-5-5';

const SYSTEM = `You explain air traffic control radio to people watching planes from their backyard near an airport. They don't know aviation jargon.

You get one aircraft's recent radio calls (transcribed by speech recognition, so expect mistakes and garbled words) and what its transponder shows. Reply with ONE short sentence, at most 100 characters, saying what is happening with this plane right now, in plain everyday words. Present tense, no jargon, no callsigns, no quotation marks.

Good examples:
- Cleared to land on runway 27 — it should touch down in a couple of minutes.
- Lined up on the runway, waiting for permission to take off.
- Being steered left onto a new heading as it lines up for landing.
- Taxiing to the runway for departure.
- Handed over from the tower to the Edmonton controllers as it climbs away.

Rely on the radio calls; use the flight data only to make sense of them. If the calls are too garbled to tell, give your best reading with "probably", or reply exactly UNCLEAR.`;

const ago = (ms) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`;

/** The user message: flight data, then the calls oldest first. */
export function summaryPrompt({ aircraft, transmissions, facility, now = Date.now() }) {
  const a = aircraft ?? {};
  const flight = [
    a.typeName && `Aircraft: ${a.typeName}`,
    a.airline && `Airline: ${a.airline}`,
    a.onGround ? 'On the ground' : a.altFt != null && `Altitude: ${a.altFt} ft`,
    a.vertRateFpm != null && Math.abs(a.vertRateFpm) > 300 && (a.vertRateFpm > 0 ? 'Climbing' : 'Descending'),
    a.gsKt != null && `Ground speed: ${Math.round(a.gsKt)} kt`,
    a.distanceKm != null && `Distance from the watcher: ${a.distanceKm.toFixed(1)} km`,
  ].filter(Boolean);
  const calls = transmissions.map((t) => {
    const who = t.role === 'from' ? 'Pilot' : 'Controller';
    const tags = t.intents?.length ? ` [${t.intents.map((i) => i.kind).join(', ')}]` : '';
    return `${ago(now - t.at)} — ${who}: ${t.text}${tags}`;
  });
  return `Airport: ${facility || 'local airport'}\n${flight.join('\n')}\n\nRadio calls, oldest first:\n${calls.join('\n')}`;
}

// Haiku 5.5 list prices, USD per million tokens (prompts under 100K tokens).
export const PRICES = { 'claude-haiku-5-5': { input: 0.1, output: 0.5 } };
const MAX_TOKENS = 1000;
const costOf = (model, input, output) => {
  const p = PRICES[model];
  return (input * p.input + output * p.output) / 1e6;
};

export class Summarizer {
  /**
   * @param {object} opts
   * @param {() => {budget: number, perHour: number}} [opts.limits]  monthly budget in US$ and requests an hour
   * @param {string} [opts.dataDir]  where the spending ledger is kept (none: in memory only, for tests)
   */
  constructor({ log = console, client = null, model = SUMMARY_MODEL, env = process.env, dataDir = null, limits }) {
    this.log = log;
    this.model = model;
    this.limits = limits ?? (() => ({ budget: 2, perHour: 30 }));
    this.calls = []; // times of recent requests, for the hourly cap
    this.client = client;
    if (!this.client) {
      const hasCredential = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
      this.client = hasCredential ? new Anthropic() : null;
    }
    this.ledger = new SpendLedger({
      file: dataDir ? path.join(dataDir, 'cache', 'anthropic-ledger.json') : null,
      log,
      name: 'atc summary',
    });
    this.state = {
      requests: 0,
      failures: 0,
      refused: 0,
      lastRefusal: null,
      lastError: null,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  async init() {
    if (this.ledger.file) await this.ledger.load();
  }

  get available() {
    return !!this.client;
  }

  /** Why a request can't be made now (budget, today's share, hourly cap), or null. */
  #refusal(estimate, now) {
    const { budget, perHour } = this.limits();
    this.calls = this.calls.filter((t) => now - t < 3600_000);
    if (this.calls.length >= perHour) return 'hourly limit';
    return this.ledger.refusal(estimate, { budget, perMinute: 3 }, now)?.reason ?? null;
  }

  /** A sentence, or null (not set up, over budget or the hourly cap, unclear, or failed). */
  async summarize(input) {
    if (!this.client) return null;
    const now = Date.now();
    const prompt = summaryPrompt(input);
    // Book the most it could cost (a generous guess at the prompt, every output
    // token used), then correct it to the real cost from the token counts.
    const estimate = costOf(this.model, Math.ceil((SYSTEM.length + prompt.length) / 2.5), MAX_TOKENS);
    const refused = this.#refusal(estimate, now);
    if (refused) {
      this.state.refused++;
      this.state.lastRefusal = { reason: refused, at: now };
      return null;
    }
    this.calls.push(now);
    await this.ledger.charge('messages', estimate, now);
    this.state.requests++;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TOKENS,
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      });
      const used = response.usage ?? {};
      this.state.inputTokens += used.input_tokens ?? 0;
      this.state.outputTokens += used.output_tokens ?? 0;
      await this.ledger.adjust(costOf(this.model, used.input_tokens ?? 0, used.output_tokens ?? MAX_TOKENS) - estimate);
      if (response.stop_reason === 'refusal') return null;
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .replace(/^["“]|["”]$/g, '')
        .trim();
      if (!text || text === 'UNCLEAR') return null;
      return text.length > 140 ? `${text.slice(0, 137).replace(/\s+\S*$/, '')}…` : text;
    } catch (err) {
      this.state.failures++;
      const message =
        err instanceof Anthropic.AuthenticationError
          ? 'Anthropic API key was rejected'
          : err instanceof Anthropic.RateLimitError
            ? 'rate limited by the Anthropic API'
            : err instanceof Anthropic.APIError
              ? `Anthropic API error ${err.status ?? ''}: ${err.message}`
              : err.message;
      this.state.lastError = { message, at: Date.now() };
      this.log.warn(`atc summary: ${message}`);
      return null;
    }
  }

  status() {
    const { budget } = this.limits();
    const left = this.ledger.allowance(budget);
    return {
      available: this.available,
      model: this.model,
      budgetUsd: budget,
      spentThisMonthUsd: this.ledger.state.spent,
      spentTodayUsd: this.ledger.spentToday(),
      leftTodayUsd: left.today,
      ...this.state,
    };
  }
}
