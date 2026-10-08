import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCallsign,
  hintPhrases,
  normalize,
  radioNames,
  speakerRole,
  spellRegistration,
  tokenize,
} from '../server/atc/speech.js';
import { intents, ruleSummary } from '../server/atc/phrases.js';
import { SAMPLE_RATE, Segmenter, wavFile } from '../server/atc/segmenter.js';
import { cleanTranscript } from '../server/atc/whisper.js';
import { summaryPrompt, Summarizer } from '../server/atc/summarizer.js';
import { AtcService } from '../server/atc/index.js';
import { DEFAULT_CONFIG, mergeConfig } from '../server/config.js';
import { quietLog, tmpDir } from './helpers.js';

const NEARBY = [
  { hex: 'c0ffee', callsign: 'WJA347', telephony: 'WESTJET', reg: 'C-GWSA' },
  { hex: 'c0a712', callsign: 'JZA712', telephony: 'JAZZ', reg: 'C-GJZA' },
  { hex: 'c00853', callsign: 'ACA853', telephony: 'AIR CANADA', reg: 'C-FGKP' },
  { hex: 'c00421', callsign: 'POE421', telephony: 'PORTER AIR', reg: 'C-GKQD' },
  { hex: 'c0farc', callsign: 'CFARC', reg: 'C-FARC' },
  { hex: 'a12345', callsign: 'N123AB', reg: 'N123AB' },
];
const who = (text, aircraft = NEARBY) => {
  const tokens = tokenize(text, radioNames(aircraft));
  const m = findCallsign(tokens, aircraft);
  return m && { hex: m.hex, role: speakerRole(tokens, m) };
};

test('spoken numbers and the phonetic alphabet are normalised', () => {
  assert.equal(normalize('WestJet three four seven, runway two seven'), 'westjet 347 runway 27');
  assert.equal(normalize('Foxtrot, Alfa Romeo, Charlie'), 'farc');
  assert.equal(normalize('November one two three alpha bravo'), 'n123ab');
  assert.equal(normalize('runway 3-3, descend and maintain four thousand'), 'runway 33 descend and maintain 4000');
  assert.equal(normalize('X-ray tree fife niner'), 'x359');
  assert.equal(
    normalize('Delta ten forty-nine, descend and maintain four thousand'),
    'd1049 descend and maintain 4000',
  );
  const delta = radioNames([{ telephony: 'DELTA' }]);
  assert.equal(normalize('Delta ten forty-nine, descend', delta), 'delta 1049 descend', 'an airline nearby: a word');
  assert.equal(normalize('United six ninety six, climb to one two thousand'), 'united 696 climb to 12000');
  assert.equal(normalize('FedEx nineteen eighty, twenty five hundred'), 'fedex 1980 2500');
  assert.equal(normalize('a hundred feet'), 'a hundred feet', 'hundred on its own is just a word');
});

test('callsigns are matched to nearby aircraft, as Whisper wrote them', () => {
  // Real transcripts from the test clips (whisper small.en with hints).
  assert.deepEqual(who('WestJet 347, Saskatoon Tower, Wind 2708, Runway 27, cleared to land.'), {
    hex: 'c0ffee',
    role: 'to',
  });
  assert.deepEqual(who('Cleared to land runway 27, WestJet 347.'), { hex: 'c0ffee', role: 'from' });
  assert.deepEqual(who('Jazz 712, turn left heading 330, descend and maintain 4000.'), { hex: 'c0a712', role: 'to' });
  assert.deepEqual(who('Foxtrot Alpha Romeo Charlie, Lie Up and Wait Runway 33.'), { hex: 'c0farc', role: 'to' });
  assert.deepEqual(
    who(
      'Saskatoon Ground, Cesna Alpha Romeo Charlie, at the South Apron, Request Taxi for departure with Information Bravo.',
    ),
    { hex: 'c0farc', role: 'from' },
  );
  assert.deepEqual(who('Air Canada 853, contact Edmonton Centre 132 decimal time. Good day.'), {
    hex: 'c00853',
    role: 'to',
  });
  assert.deepEqual(who('Porter 421, Runway 27, cleared for takeoff.'), { hex: 'c00421', role: 'to' });
  assert.equal(who('West jet 347, roger')?.hex, 'c0ffee', 'split name');
  assert.equal(who('Westjett 347, roger')?.hex, 'c0ffee', 'one letter off');
  assert.equal(who('November one two three alpha bravo, taxi to runway 27')?.hex, 'a12345');
  assert.equal(who('three alpha bravo, roger')?.hex, 'a12345', 'abbreviated US registration');
  assert.equal(who('WestJet three forty-seven, contact departure')?.hex, 'c0ffee', 'number said in pairs');
  // From the real CYXE recording: Rise Air broadcasts RS193 but is "Riser" on the radio.
  const withRise = [...NEARBY, { hex: 'c0r193', callsign: 'RS193', reg: 'C-GGCA' }];
  assert.equal(who('Riser 193, Touch Hill, Fires.', withRise)?.hex, 'c0r193', 'flight number alone');
  assert.equal(who('turn left heading 193', withRise), null, 'a heading is not a flight number');
  // "Westjet 63" for 603, when no other WestJet nearby is that close.
  const westjets = [
    { hex: 'c00603', callsign: 'WJA603', telephony: 'WESTJET' },
    { hex: 'c00617', callsign: 'WJA617', telephony: 'WESTJET' },
  ];
  assert.equal(who('Westjet 63, hello.', westjets)?.hex, 'c00603', 'one digit misheard');
  assert.equal(who('Westjet 613, hello.', westjets), null, 'one digit off two flights: could be either');
  const withDelta = [...NEARBY, { hex: 'a01049', callsign: 'DAL1049', telephony: 'DELTA' }];
  assert.equal(who('Delta ten forty-nine, descend and maintain six thousand', withDelta)?.hex, 'a01049');
});

test('callsign matching avoids false hits', () => {
  assert.equal(who('Taxi to runway 33, Myra alpha, Hold short on runway 27.'), null, 'no callsign heard');
  assert.equal(who('WestJet 358, cleared to land'), null, 'a different flight number');
  assert.equal(who('descend and maintain 4000, information bravo'), null);
  // "Romeo Charlie" alone fits C-FARC, but not once another plane ends in RC too.
  assert.equal(who('Romeo Charlie, roger')?.hex, 'c0farc');
  const twoRc = [...NEARBY, { hex: 'c0abrc', callsign: 'CGBRC', reg: 'C-GBRC' }];
  assert.equal(who('Romeo Charlie, roger', twoRc), null);
});

test('hint phrases name nearby flights the way they are said', () => {
  assert.deepEqual(hintPhrases(NEARBY.slice(0, 2)), ['Westjet 347', 'Jazz 712']);
  assert.equal(spellRegistration('C-FARC'), 'Foxtrot Alpha Romeo Charlie');
  assert.equal(spellRegistration('N123AB'), 'November 1 2 3 Alpha Bravo');
});

test('common radio phrases are put into plain words', () => {
  const say = (t) => intents(normalize(t)).map((i) => i.text);
  assert.equal(say('WestJet 347, runway two seven, cleared to land')[0], 'Cleared to land on runway 27');
  assert.equal(say('Porter 421, runway 27, cleared for takeoff')[0], 'Cleared for take-off from runway 27');
  assert.equal(
    say('Foxtrot Alpha Romeo Charlie, lie up and wait runway 33')[0],
    'Lining up on the runway for runway 33 to wait for take-off',
  );
  assert.equal(say('Jazz 712, turn left heading 330, descend and maintain 4000')[0], 'Turning left to heading 330');
  assert.ok(say('Jazz 712, turn left heading 330, descend and maintain 4000').includes('Descending to 4,000 ft'));
  assert.equal(
    say('Air Canada 853, contact Edmonton Centre 132.5, good day')[0],
    'Handed over to the en-route controllers',
  );
  assert.equal(
    say('Romeo Charlie, taxi to runway three three via alpha, hold short of runway two seven')[0],
    'Holding short of runway 27',
  );
  assert.equal(say('Saskatoon ground, Cessna ARC, request taxi for departure')[0], 'Asking to taxi out for departure');
  assert.equal(say('WestJet 347, cleared ILS approach runway 27')[0], 'Cleared for the ILS approach to runway 27');
  assert.equal(say('WestJet 347, go around')[0], 'Going around — aborting the landing');
  assert.deepEqual(say('roger, good day'), []);
  assert.equal(
    say('Delta 1006, contact Edmont and Centre 132 decimal time, God Bay.')[0],
    'Handed over to the en-route controllers',
  );
  const heard = (t, role) => ({ role, intents: intents(normalize(t)) });
  assert.equal(
    ruleSummary([
      heard('Southwest 779, turn left heading 270, descend and maintain 11000', 'to'),
      heard('Left heading 270, 11,000, Southwest 779', 'from'),
    ]),
    'Turning left to heading 270, descending to 11,000 ft',
    "the controller's instruction over the shorter readback",
  );
  assert.equal(ruleSummary([heard('cleared to land runway 27'), heard('roger')]), 'Cleared to land on runway 27');
});

test('whisper noise is dropped', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript(' Thank you. '), '');
  assert.equal(cleanTranscript('(static) WestJet 347 roger'), 'WestJet 347 roger');
  // Real Whisper output from the CYXE recording.
  assert.equal(cleanTranscript('Roar, Roar, Roar, Roar, Roar! MicroMia Bravo, contact ground'), '');
  const prompt = 'Saskatoon Tower, Saskatoon Ground. Westjet 603, Jazz 712.';
  assert.equal(cleanTranscript('Tower, Saskatoon Tower, Saskatoon Ground, Saskatoon, Saskatoon.', prompt), '');
  assert.equal(
    cleanTranscript('Westjet 603, Saskatoon Tower, cleared to land runway 27.', prompt),
    'Westjet 603, Saskatoon Tower, cleared to land runway 27.',
  );
});

/** `ms` of a tone (or silence) with a little background hiss. */
function tone(ms, amp) {
  const n = (ms / 1000) * SAMPLE_RATE;
  const out = new Int16Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    const hiss = ((seed / 2147483647) * 2 - 1) * 30;
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * 600 * i) / SAMPLE_RATE) + hiss);
  }
  return out;
}
const join = (...parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
};

test('the segmenter cuts calls at the quiet gaps between them', () => {
  const segs = [];
  const seg = new Segmenter({ onSegment: (s) => segs.push(s) });
  const audio = join(
    tone(1500, 0),
    tone(2000, 8000),
    tone(1500, 0),
    tone(3000, 6000),
    tone(2000, 0),
    tone(200, 8000),
    tone(1500, 0),
  );
  // Fed in awkward chunk sizes, as a pipe delivers it.
  for (let i = 0; i < audio.length; i += 777) seg.push(audio.subarray(i, i + 777));
  seg.flush();
  assert.equal(segs.length, 2, 'two calls; the 200 ms blip is dropped');
  const startMs = (s) => (s.startSample / SAMPLE_RATE) * 1000;
  const lenMs = (s) => (s.pcm.length / SAMPLE_RATE) * 1000;
  assert.ok(Math.abs(startMs(segs[0]) - 1300) <= 60, `first starts with pre-roll: ${startMs(segs[0])}`);
  assert.ok(lenMs(segs[0]) >= 2000 && lenMs(segs[0]) < 2600, `first length ${lenMs(segs[0])}`);
  assert.ok(Math.abs(startMs(segs[1]) - 4800) <= 60, `second start ${startMs(segs[1])}`);

  const wav = wavFile(segs[0].pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.length, 44 + segs[0].pcm.length * 2);
});

test('a squelched feed is split at short silences, not at pauses in speech', () => {
  const segs = [];
  const seg = new Segmenter({ onSegment: (s) => segs.push(s) });
  const silence = (ms) => new Int16Array((ms / 1000) * SAMPLE_RATE); // squelch closed: digital zero
  // Controller (with a 400 ms hiss-only pause mid-sentence), 300 ms of squelch, pilot answers.
  seg.push(
    join(
      silence(1000),
      tone(1500, 8000),
      tone(400, 0),
      tone(1200, 8000),
      silence(300),
      tone(2000, 7000),
      silence(1500),
    ),
  );
  seg.flush();
  assert.equal(segs.length, 2, 'two transmissions');
  assert.ok(segs[0].pcm.length / SAMPLE_RATE > 3, 'the pause stayed inside the first');
});

test('the segmenter splits a call that never stops', () => {
  const segs = [];
  const seg = new Segmenter({ onSegment: (s) => segs.push(s), maxMs: 5000 });
  seg.push(join(tone(500, 0), tone(12_000, 8000)));
  seg.flush();
  assert.equal(segs.length, 3);
});

test('the summary prompt carries the flight and the calls in order', () => {
  const now = 1_000_000;
  const prompt = summaryPrompt({
    facility: 'Saskatoon',
    now,
    aircraft: {
      typeName: 'Boeing 737 MAX 8',
      airline: 'WestJet',
      altFt: 2400,
      vertRateFpm: -700,
      gsKt: 140,
      distanceKm: 6.2,
    },
    transmissions: [
      { at: now - 90_000, role: 'to', text: 'WestJet 347, cleared to land runway 27', intents: [{ kind: 'land' }] },
      { at: now - 85_000, role: 'from', text: 'Cleared to land 27, WestJet 347', intents: [{ kind: 'land' }] },
    ],
  });
  assert.match(prompt, /Airport: Saskatoon/);
  assert.match(prompt, /Altitude: 2400 ft\nDescending/);
  assert.match(prompt, /2 min ago — Controller: WestJet 347, cleared to land runway 27 \[land\]\n1 min ago — Pilot:/);
});

/** A stand-in for the Anthropic client. */
const fakeClaude = (reply, calls = []) => ({
  messages: {
    create: async (req) => {
      calls.push(req);
      return typeof reply === 'function' ? reply(req) : reply;
    },
  },
});
const textReply = (text, extra = {}) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 300, output_tokens: 20 },
  ...extra,
});

test('summaries use Claude Haiku at low effort and fall back quietly', async () => {
  const calls = [];
  const s = new Summarizer({ log: quietLog, client: fakeClaude(textReply('"Cleared to land on runway 27."'), calls) });
  const input = { transmissions: [{ at: Date.now(), role: 'to', text: 'cleared to land' }] };
  assert.equal(await s.summarize(input), 'Cleared to land on runway 27.');
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.deepEqual(calls[0].output_config, { effort: 'low' });

  const unclear = new Summarizer({ log: quietLog, client: fakeClaude(textReply('UNCLEAR')) });
  assert.equal(await unclear.summarize(input), null);
  const refused = new Summarizer({ log: quietLog, client: fakeClaude(textReply('', { stop_reason: 'refusal' })) });
  assert.equal(await refused.summarize(input), null);
  const broken = new Summarizer({
    log: quietLog,
    client: fakeClaude(() => {
      throw new Error('network down');
    }),
  });
  assert.equal(await broken.summarize(input), null);
  assert.equal(broken.status().lastError.message, 'network down');

  const capped = new Summarizer({
    log: quietLog,
    client: fakeClaude(textReply('ok')),
    limits: () => ({ budget: 2, perHour: 1 }),
  });
  assert.equal(await capped.summarize(input), 'ok');
  assert.equal(await capped.summarize(input), null, 'over the hourly cap');
  assert.equal(capped.status().lastRefusal.reason, 'hourly limit');

  assert.equal(new Summarizer({ log: quietLog, env: {} }).available, false, 'no API key: rules only');
});

test('Claude summaries are paid for out of a hard budget, at the real cost', async () => {
  const dir = await tmpDir();
  const calls = [];
  const s = new Summarizer({
    log: quietLog,
    dataDir: dir,
    client: fakeClaude(textReply('Lining up to land.'), calls),
    limits: () => ({ budget: 0.5, perHour: 100 }),
  });
  await s.init();
  const input = { transmissions: [{ at: Date.now(), role: 'to', text: 'cleared to land runway 27' }] };
  assert.equal(await s.summarize(input), 'Lining up to land.');
  assert.equal(calls[0].max_tokens, 1000);
  // Booked at the most it could cost, then corrected to 300 in + 20 out at Haiku 5.5 prices.
  assert.equal(s.status().spentThisMonthUsd, (300 * 0.1 + 20 * 0.5) / 1e6);
  // It's on disk, so a restart remembers.
  const again = new Summarizer({ log: quietLog, dataDir: dir, client: fakeClaude(textReply('x')) });
  await again.init();
  assert.equal(again.status().spentThisMonthUsd, s.status().spentThisMonthUsd);

  const broke = new Summarizer({
    log: quietLog,
    client: fakeClaude(textReply('never')),
    limits: () => ({ budget: 0, perHour: 100 }),
  });
  assert.equal(await broke.summarize(input), null, 'no budget, no request');
  assert.match(broke.status().lastRefusal.reason, /budget/);
});

test('the ATC service files transcripts under aircraft and sums them up', async () => {
  const dir = await tmpDir();
  const config = mergeConfig(DEFAULT_CONFIG, { atc: { enabled: true, facility: 'Saskatoon' } }).config;
  const calls = [];
  const atc = new AtcService({
    dataDir: dir,
    getConfig: () => config,
    candidates: () => NEARBY,
    log: quietLog,
    summarizer: new Summarizer({
      log: quietLog,
      client: fakeClaude(textReply('Cleared to land on runway 27, touching down shortly.'), calls),
    }),
  });
  const now = Date.now();
  atc.ingest({ text: 'WestJet 347, Saskatoon Tower, runway 27, cleared to land.', at: now - 8000, now });
  atc.ingest({ text: 'Cleared to land runway 27, WestJet 347.', at: now - 5000, now });
  atc.ingest({ text: 'Taxi to runway 33, Myra alpha.', at: now - 3000, now });

  const brief = atc.brief('c0ffee', now);
  assert.equal(brief.summary, 'Cleared to land on runway 27', 'rule line straight away');
  assert.equal(brief.lastAt, now - 5000);
  assert.equal(atc.brief('c0a712', now), null, 'not heard');
  assert.deepEqual(
    brief.log.map((l) => [l.role, l.text]),
    [
      ['to', 'WestJet 347, Saskatoon Tower, runway 27, cleared to land.'],
      ['from', 'Cleared to land runway 27, WestJet 347.'],
    ],
    'the conversation so far, oldest first',
  );
  // Past the recent window: no summary or audio on the card, but the conversation stays.
  const later = atc.brief('c0ffee', now + 15 * 60_000);
  assert.equal(later.recent, false);
  assert.equal(later.summary, null);
  assert.deepEqual(later.clips, []);
  assert.equal(later.log.length, 2);
  assert.equal(atc.recent().length, 3);
  assert.equal(atc.recent()[0].hex, null, 'unattributed calls are kept too');

  assert.equal(await atc.summarize('c0ffee', now), 'Cleared to land on runway 27, touching down shortly.');
  assert.equal(atc.brief('c0ffee', now).summary, 'Cleared to land on runway 27, touching down shortly.');
  assert.match(calls[0].messages[0].content, /Controller: WestJet 347, Saskatoon Tower/);
  assert.match(calls[0].messages[0].content, /Pilot: Cleared to land runway 27/);

  // Hints for the recogniser: local facilities, then nearby flights.
  assert.match(atc.hintPrompt(NEARBY), /^Saskatoon Tower, Saskatoon Ground\. Westjet 347, Jazz 712, Air Canada 853/);

  // Old calls are forgotten.
  await atc.prune(now + 61 * 60_000);
  assert.equal(atc.recent().length, 0);
  assert.equal(atc.brief('c0ffee', now + 61 * 60_000), null);
  atc.stop();
});

test('ATC settings are validated', () => {
  const { errors } = mergeConfig(DEFAULT_CONFIG, { atc: { source: 'stream', streamUrl: 'ftp://x', recentMinutes: 0 } });
  assert.deepEqual(errors.map((e) => e.field).sort(), ['atc.recentMinutes', 'atc.streamUrl']);
  assert.equal(DEFAULT_CONFIG.atc.enabled, false, 'off until set up');
});
