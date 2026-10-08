// Turning radio transcripts into something we can match against the aircraft
// we're tracking: spoken numbers and the phonetic alphabet are normalised
// ("three four seven" → 347, "Foxtrot Alpha Romeo Charlie" → FARC), and each
// aircraft gets the forms a controller or pilot would say for it ("WestJet 347",
// "Cessna Alpha Romeo Charlie", "Romeo Charlie").

const DIGITS = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  tree: '3',
  four: '4',
  fower: '4',
  five: '5',
  fife: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  niner: '9',
};

// Said in pairs: "ten forty-nine" is 1049, "four thousand" 4000.
const TEENS = {
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
};
const TENS = {
  twenty: '2',
  thirty: '3',
  forty: '4',
  fourty: '4',
  fifty: '5',
  sixty: '6',
  seventy: '7',
  eighty: '8',
  ninety: '9',
};
const ZEROS = { hundred: '00', thousand: '000' };

export const NATO = {
  alpha: 'A',
  alfa: 'A',
  bravo: 'B',
  charlie: 'C',
  delta: 'D',
  echo: 'E',
  foxtrot: 'F',
  golf: 'G',
  hotel: 'H',
  india: 'I',
  juliet: 'J',
  juliett: 'J',
  kilo: 'K',
  lima: 'L',
  mike: 'M',
  november: 'N',
  oscar: 'O',
  papa: 'P',
  quebec: 'Q',
  romeo: 'R',
  sierra: 'S',
  tango: 'T',
  uniform: 'U',
  victor: 'V',
  whiskey: 'W',
  whisky: 'W',
  xray: 'X',
  yankee: 'Y',
  zulu: 'Z',
};
const SPELL = Object.fromEntries(
  Object.entries(NATO)
    .filter(([w]) => !['alfa', 'juliett', 'whisky'].includes(w))
    .map(([w, l]) => [l, w[0].toUpperCase() + w.slice(1)]),
);
SPELL.X = 'X-ray';

/**
 * Words in a transcript: lower case, punctuation dropped except commas (kept
 * as "," words), "x-ray" kept whole, "3-3" → "33".
 */
function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/x-ray/g, 'xray')
    .replace(/(\d)[-.](?=\d)/g, '$1')
    .replace(/,/g, ' , ')
    .replace(/[^a-z0-9,]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Normalised tokens: digits and spelled letters are run together into one
 * alphanumeric token ("november one two three alpha bravo" → "N123AB"), each
 * marked with `alnum`; other words are kept as they are. Words in `names`
 * (airline radio names such as "delta") stay words, not letters.
 */
export function tokenize(text, names = NO_NAMES) {
  const out = [];
  let run = null;
  const flush = () => {
    if (run) out.push({ word: run.word, alnum: true });
    run = null;
  };
  let comma = false;
  for (const w of words(text)) {
    if (w === ',') {
      comma = true;
      if (run) run.tens = false;
      continue;
    }
    // "forty nine": the nine takes the place of the forty's nought.
    if (run?.tens && DIGITS[w]) {
      run.word = run.word.slice(0, -1) + DIGITS[w];
      run.tens = false;
      continue;
    }
    if (run) run.tens = false;
    let piece = null;
    if (/^\d+$/.test(w)) piece = w;
    else if (DIGITS[w]) piece = DIGITS[w];
    else if (TEENS[w]) piece = TEENS[w];
    else if (TENS[w]) piece = `${TENS[w]}0`;
    else if (ZEROS[w] && run && /\d$/.test(run.word)) piece = ZEROS[w];
    else if (NATO[w] && !names.has(w)) piece = NATO[w];
    if (piece == null) {
      flush();
      out.push({ word: w });
      comma = false;
      continue;
    }
    // A comma parts two numbers ("1980, 2500"), not spelled letters ("Foxtrot, Alfa Romeo").
    if (comma && run && /\d$/.test(run.word) && /^\d/.test(piece)) flush();
    comma = false;
    if (!run) run = { word: '', alnum: true };
    run.word += piece;
    if (TENS[w]) run.tens = true;
  }
  flush();
  return out;
}

const NO_NAMES = new Set();

/** Words of nearby airlines' radio names ("DELTA", "AIR CANADA"), for tokenize(). */
export const radioNames = (aircraft) => new Set(aircraft.flatMap((a) => (a.telephony ? words(a.telephony) : [])));

/** Plain normalised text: "WestJet three four seven" → "westjet 347". */
export const normalize = (text, names = NO_NAMES) =>
  tokenize(text, names)
    .map((t) => (t.alnum ? t.word.toLowerCase() : t.word))
    .join(' ');

// Words in airline radio names that don't identify the airline on their own.
const GENERIC = new Set(['air', 'airlines', 'airline', 'airways', 'aviation', 'flight', 'express', 'cargo', 'jet']);

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** Close enough to a radio name, allowing one slip in longer words ("westjett"). */
const nameMatches = (heard, name) => heard === name || (name.length >= 5 && levenshtein(heard, name) <= 1);

/**
 * What can be said on the radio to mean this aircraft.
 * @param {{hex: string, callsign?: string, reg?: string, telephony?: string}} ac
 *   `telephony` is the airline's radio name ("WESTJET") for airline callsigns.
 */
export function spokenForms(ac) {
  const forms = { hex: ac.hex, names: [], number: null, bareNumber: null, regs: [] };
  const cs = (ac.callsign ?? '').toUpperCase().replace(/\s/g, '');
  const flight = /^([A-Z]{3})(\d[0-9A-Z]*)$/.exec(cs);
  // A flight whose radio name we don't know ("RS193" is Rise Air, said "Riser 193"):
  // its number alone may identify it.
  const odd = /^[A-Z]{1,3}(\d{3,4})$/.exec(cs);
  if (odd && !(flight && ac.telephony)) forms.bareNumber = odd[1];
  if (flight && ac.telephony) {
    const parts = words(ac.telephony);
    forms.number = flight[2].replace(/^0+(?=\d)/, '');
    forms.names.push(parts.join(''));
    // "PORTER AIR" is just "Porter" on the radio; "AIR CANADA" stays whole.
    for (const p of parts) if (p.length >= 4 && !GENERIC.has(p)) forms.names.push(p);
    forms.names = [...new Set(forms.names)];
  }
  const reg = (ac.reg ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (reg.length >= 3) forms.regs.push(reg);
  // A private plane's callsign is usually its registration.
  if (cs && !flight && cs !== reg && /^[A-Z0-9]{3,8}$/.test(cs)) forms.regs.push(cs);
  return forms;
}

/** How a registration is said in full: "C-FARC" → "Foxtrot Alpha Romeo Charlie". */
export function spellRegistration(reg) {
  let r = String(reg ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (/^C[FG][A-Z]{3}$/.test(r)) r = r.slice(1); // Canadian: the C is left off
  return [...r].map((c) => SPELL[c] ?? c).join(' ');
}

/** Phrases to prime the speech recogniser with, so it hears "Jazz 712" and not "Just 712". */
export function hintPhrases(aircraft, max = 24) {
  const out = [];
  for (const ac of aircraft) {
    const f = spokenForms(ac);
    if (f.number && ac.telephony) out.push(`${titleCase(ac.telephony)} ${f.number}`);
    else if (ac.reg) out.push(spellRegistration(ac.reg));
    if (out.length >= max) break;
  }
  return out;
}

const titleCase = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Find the aircraft a transmission is to or from.
 * Returns { hex, index, length } for the earliest callsign in the transcript,
 * or null. `index`/`length` are token positions, used to tell who's talking.
 */
export function findCallsign(tokens, candidates) {
  const hits = [];
  const forms = candidates.map(spokenForms);
  for (const f of forms) {
    // Airline flights: radio name then flight number ("westjet 347", "west jet 347").
    if (f.number) {
      const num = f.number.toUpperCase();
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t.alnum || t.word !== num) continue;
        for (const span of [1, 2]) {
          if (i - span < 0) continue;
          const heard = tokens
            .slice(i - span, i)
            .map((x) => x.word.toLowerCase())
            .join('');
          if (f.names.some((n) => nameMatches(heard, n))) {
            hits.push({ hex: f.hex, index: i - span, length: span + 1, strength: 3 });
            break;
          }
        }
      }
      // The right airline with a digit misheard ("Westjet 63" for 603): only
      // when no other plane nearby is that close (checked below).
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t.alnum || !/^\d+$/.test(t.word) || t.word === num || levenshtein(t.word, num) !== 1) continue;
        const heard = tokens[i - 1].word.toLowerCase();
        if (f.names.some((n) => nameMatches(heard, n))) {
          hits.push({ hex: f.hex, index: i - 1, length: 2, strength: 1, tail: `~${i}` });
        }
      }
    }
    // A flight number on its own, not a heading, runway, altitude or frequency.
    if (f.bareNumber) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].word !== f.bareNumber || (i > 0 && NUMBER_WORDS.has(tokens[i - 1].word))) continue;
        hits.push({ hex: f.hex, index: i, length: 1, strength: 1, tail: `#${f.bareNumber}` });
      }
    }
    // Registrations, in full or by their last three ("C-FARC": FARC, CFARC, ARC).
    for (const reg of f.regs) {
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (!t.alnum || t.word.length < 2) continue;
        const full = t.word === reg || (reg.length - t.word.length === 1 && reg.endsWith(t.word));
        const tail = t.word.length >= 3 && /[A-Z]/.test(t.word) && reg.endsWith(t.word);
        if (full || tail) hits.push({ hex: f.hex, index: i, length: 1, strength: full ? 3 : 2, tail: t.word });
        else if (t.word.length === 2 && /^[A-Z]{2}$/.test(t.word) && reg.endsWith(t.word)) {
          hits.push({ hex: f.hex, index: i, length: 1, strength: 1, tail: t.word });
        }
      }
    }
  }
  // A short tail ("Romeo Charlie"), a bare number or a near miss only counts
  // when it fits one aircraft alone.
  const usable = hits.filter((h) => h.strength > 1 || hits.filter((o) => o.tail === h.tail).length === 1);
  if (!usable.length) return null;
  usable.sort((a, b) => a.index - b.index || b.strength - a.strength);
  const { hex, index, length } = usable[0];
  return { hex, index, length };
}

// Words that come before numbers that aren't callsigns.
const NUMBER_WORDS = new Set([
  'heading',
  'runway',
  'squawk',
  'maintain',
  'level',
  'decimal',
  'point',
  'wind',
  'at',
  'altimeter',
  'contact',
  'climb',
  'descend',
  'to',
  'and',
  'information',
  'speed',
  'knots',
  'feet',
  'time',
]);

const FACILITY = new Set([
  'tower',
  'ground',
  'centre',
  'center',
  'approach',
  'departure',
  'arrival',
  'terminal',
  'radio',
  'apron',
  'clearance',
  'delivery',
]);

/**
 * Who is talking, from where the callsign sits:
 *  'to'   — a controller calling the aircraft ("WestJet 347, cleared to land")
 *  'from' — the pilot: calling a facility ("Saskatoon Ground, Cessna ARC…") or
 *           reading back with the callsign last ("…runway 27, WestJet 347")
 */
export function speakerRole(tokens, match) {
  const before = tokens.slice(0, match.index).map((t) => t.word);
  if (before.slice(0, 4).some((w) => FACILITY.has(w))) return 'from';
  const after = tokens.length - (match.index + match.length);
  if (match.index <= 1) return 'to';
  if (after <= 1) return 'from';
  return 'to';
}
